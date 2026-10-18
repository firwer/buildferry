import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  accountSchema,
  dashboardSchema,
  providerSchema,
  sessionSchema,
} from "../src/shared/contracts.js";
import { newAccount } from "../src/server/auth.js";
import { currentPeriod } from "../src/server/routing.js";
import { fixture, projectId, response } from "./fixtures.js";

const apps: Awaited<ReturnType<typeof fixture>>[] = [];
async function make(options: Parameters<typeof fixture>[0] = {}) {
  const app = await fixture(options);
  apps.push(app);
  return app;
}
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.server.close()));
});

describe("dashboard authentication", () => {
  it("exposes health and minimal setup state without private configuration", async () => {
    const { server } = await make();
    expect((await server.inject("/healthz")).json()).toEqual({ status: "ok" });
    expect((await server.inject("/readyz")).json()).toEqual({
      status: "ready",
      execution: "disabled",
    });
    const session = await server.inject("/api/session");
    expect(sessionSchema.parse(session.json()).stage).toBe("claim");
    expect(session.headers["cache-control"]).toBe("no-store");
  });
  it.each([
    "/api/dashboard",
    "/api/accounts/1/refresh",
    "/api/invitations",
    "/api/providers",
    "/api/routing/preview",
    "/api/tests/plan",
  ])("requires sign-in for %s", async (url) => {
    const { server, headers } = await make();
    const request =
      url === "/api/dashboard"
        ? { url }
        : { method: "POST" as const, url, payload: {}, headers };
    expect((await server.inject(request)).statusCode).toBe(401);
  });
  it("rejects foreign origins and missing CSRF even with an owner session", async () => {
    const { server, cookies, headers } = await make({ signedIn: true });
    const request = {
      method: "POST" as const,
      url: "/api/invitations",
      cookies,
      payload: {},
    };
    expect(
      (
        await server.inject({
          ...request,
          headers: { ...headers, origin: "https://attacker.example" },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await server.inject({ ...request, headers: { origin: headers.origin } }))
        .statusCode,
    ).toBe(403);
    expect((await server.inject({ ...request, headers })).statusCode).toBe(200);
  });
  it("claims the installation once and uses secure expiring cookies", async () => {
    const { server, headers } = await make();
    const request = { method: "POST" as const, url: "/api/claim", headers };
    expect(
      (await server.inject({ ...request, payload: { code: "wrong" } }))
        .statusCode,
    ).toBe(403);
    const claimed = await server.inject({
      ...request,
      payload: { code: "fixture-claim-code" },
    });
    expect(claimed.statusCode).toBe(200);
    expect(String(claimed.headers["set-cookie"])).toMatch(/HttpOnly/);
    expect(String(claimed.headers["set-cookie"])).toMatch(/Secure/);
    expect(
      (
        await server.inject({
          ...request,
          payload: { code: "fixture-claim-code" },
        })
      ).statusCode,
    ).toBe(403);
    const sessionToken =
      claimed.cookies.find((item) => item.name === "bf_session")?.value ?? "";
    expect(
      (
        await server.inject({
          url: "/api/session",
          cookies: { bf_session: sessionToken },
        })
      ).json().stage,
    ).toBe("setup");
  });
  it("rejects claiming an already configured installation and logs out cleanly", async () => {
    const { server, cookies, headers } = await make({ signedIn: true });
    expect(
      (
        await server.inject({
          method: "POST",
          url: "/api/claim",
          headers,
          payload: { code: "fixture-claim-code" },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await server.inject({
          method: "POST",
          url: "/api/logout",
          cookies,
          headers,
          payload: {},
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await server.inject({ url: "/api/dashboard", cookies })).statusCode,
    ).toBe(401);
  });
  it("denies mutations and external calls in the sample demo", async () => {
    const { server, fetcher, config } = await make({ demo: true });
    const headers = {
      origin: config.publicUrl,
      "x-buildferry-csrf": "demo-preview",
    };
    expect(
      dashboardSchema.parse((await server.inject("/api/dashboard")).json())
        .accounts,
    ).toHaveLength(3);
    expect(
      (
        await server.inject({
          method: "POST",
          url: "/api/invitations",
          headers,
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
    const result = await server.inject({
      method: "POST",
      url: "/api/routing/preview",
      headers,
      payload: {
        jobs: 3,
        maxMinutes: 20,
        memoryGiB: 8,
        maxCostMicros: 100_000,
      },
    });
    expect(result.statusCode).toBe(200);
    expect(result.json().assignments).toHaveLength(3);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("account contributions", () => {
  it("verifies owner-wide usage and repository access after saving own limits", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ usageItems: [] }))
      .mockResolvedValueOnce(
        response({
          private: true,
          archived: false,
          disabled: false,
          owner: { id: 1 },
        }),
      );
    const { server, store, cookies, headers } = await make({
      signedIn: true,
      fetcher,
    });
    store.setSecret("github-user:1", {
      access_token: "test-token",
      expires_at: null,
    });
    const settings = {
      ...newAccount(1, "owner", "owner").settings,
      workerRepository: "buildferry-ci",
      allowanceConfirmed: true,
    };
    const result = await server.inject({
      method: "PUT",
      url: "/api/accounts/1",
      headers,
      cookies,
      payload: settings,
    });
    expect(result.statusCode).toBe(200);
    expect(accountSchema.parse(result.json()).repositoryVerified).toBe(true);
    const dashboard = await server.inject({ url: "/api/dashboard", cookies });
    expect(
      dashboardSchema.parse(dashboard.json()).candidates[0]?.availableMinutes,
    ).toBe(1800);
    expect(dashboard.body).not.toContain("test-token");
  });
  it("invalidates old usage after a failed refresh", async () => {
    const { server, store, cookies, headers } = await make({ signedIn: true });
    const account = newAccount(1, "owner", "owner");
    account.usedMinutes = 0;
    account.verifiedAt = Date.now();
    account.repositoryVerified = true;
    store.put("account", "1", account);
    const result = await server.inject({
      method: "POST",
      url: "/api/accounts/1/refresh",
      cookies,
      headers,
      payload: {},
    });
    expect(accountSchema.parse(result.json()).verifiedAt).toBeNull();
    expect(result.json().message).toContain("Reconnect");
  });
  it("lets members manage only their own limits and refreshes", async () => {
    const { server, store, headers } = await make({ signedIn: true });
    store.put("account", "2", newAccount(2, "member", "member"));
    store.saveSession(
      "member-session",
      { csrf: "member-csrf", githubId: 2, setup: false },
      Date.now() + 10000,
    );
    const cookies = { bf_session: "member-session" };
    const memberHeaders = { ...headers, "x-buildferry-csrf": "member-csrf" };
    expect(
      (
        await server.inject({
          method: "PUT",
          url: "/api/accounts/1",
          headers: memberHeaders,
          cookies,
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await server.inject({
          method: "POST",
          url: "/api/accounts/1/refresh",
          headers: memberHeaders,
          cookies,
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await server.inject({
          method: "POST",
          url: "/api/invitations",
          headers: memberHeaders,
          cookies,
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
  });
  it("removes member credentials and sessions while retaining owner sign-in", async () => {
    const { server, store, cookies, headers } = await make({ signedIn: true });
    store.put("account", "2", newAccount(2, "member", "member"));
    store.setSecret("github-user:2", { access_token: "secret" });
    store.saveSession(
      "member-session",
      { csrf: "csrf", githubId: 2, setup: false },
      Date.now() + 10000,
    );
    expect(
      (
        await server.inject({
          method: "DELETE",
          url: "/api/accounts/1",
          headers,
          cookies,
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (
        await server.inject({
          method: "DELETE",
          url: "/api/accounts/2",
          headers,
          cookies,
        })
      ).statusCode,
    ).toBe(204);
    expect(store.secret("github-user:2", z.object({}))).toBeNull();
    expect(store.session("member-session")).toBeNull();
    expect(
      (
        await server.inject({
          method: "POST",
          url: "/api/accounts/2/refresh",
          cookies,
          headers,
          payload: {},
        })
      ).statusCode,
    ).toBe(404);
  });
  it("rejects invalid settings without making network requests", async () => {
    const { server, cookies, headers, fetcher } = await make({
      signedIn: true,
    });
    const result = await server.inject({
      method: "PUT",
      url: "/api/accounts/1",
      cookies,
      headers,
      payload: {
        ...newAccount(1, "owner", "owner").settings,
        reserveMinutes: 3000,
      },
    });
    expect(result.statusCode).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("preserves a pause or new limit made during usage verification", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const { server, store, cookies, headers } = await make({
      signedIn: true,
      fetcher,
    });
    store.setSecret("github-user:1", {
      access_token: "test-token",
      expires_at: null,
    });
    fetcher.mockImplementationOnce(async () => {
      const account = accountSchema.parse(
        store.get("account", "1", accountSchema),
      );
      store.put("account", "1", {
        ...account,
        settings: {
          ...account.settings,
          state: "paused",
          contributionMinutes: 30,
        },
      });
      return response({ usageItems: [] });
    });
    const result = await server.inject({
      method: "POST",
      url: "/api/accounts/1/refresh",
      cookies,
      headers,
      payload: {},
    });
    expect(accountSchema.parse(result.json()).settings).toMatchObject({
      state: "paused",
      contributionMinutes: 30,
    });
  });
  it("does not restore an account disconnected during usage verification", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const { server, store, cookies, headers } = await make({
      signedIn: true,
      fetcher,
    });
    store.put("account", "2", newAccount(2, "member", "member"));
    store.setSecret("github-user:2", {
      access_token: "test-token",
      expires_at: null,
    });
    fetcher.mockImplementationOnce(async () => {
      store.remove("account", "2");
      return response({ usageItems: [] });
    });
    const result = await server.inject({
      method: "POST",
      url: "/api/accounts/2/refresh",
      cookies,
      headers,
      payload: {},
    });
    expect(result.statusCode).toBe(404);
    expect(store.get("account", "2", accountSchema)).toBeNull();
  });
});

describe("provider management and test planning", () => {
  it("stores a verified Ubicloud token encrypted and never returns it", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ id: projectId, name: "Team" }))
      .mockResolvedValueOnce(
        response({ count: 1, items: [{ id: "installation", name: "owner" }] }),
      );
    const { server, store, headers, cookies } = await make({
      signedIn: true,
      fetcher,
    });
    const result = await server.inject({
      method: "POST",
      url: "/api/providers",
      cookies,
      headers,
      payload: {
        projectId,
        token: "fixture-provider-token",
        runner: "ubicloud-standard-4",
        priority: 2,
        rateMicros: 4000,
        budgetMicros: 1_000_000,
      },
    });
    expect(result.statusCode).toBe(200);
    expect(providerSchema.parse(result.json()).name).toBe("Team");
    expect(result.body).not.toContain("fixture-provider-token");
    expect(
      String(store.db.prepare("SELECT body FROM secrets").get()?.body),
    ).not.toContain("fixture-provider-token");
    expect(
      (
        await server.inject({
          method: "DELETE",
          url: `/api/providers/${projectId}`,
          headers,
          cookies,
        })
      ).statusCode,
    ).toBe(204);
    expect(store.list("provider", providerSchema)).toHaveLength(0);
  });
  it("marks failed provider refreshes unavailable", async () => {
    const { server, store, headers, cookies } = await make({ signedIn: true });
    store.put("provider", projectId, {
      projectId,
      name: "Team",
      installations: [],
      verifiedAt: Date.now(),
      runner: "ubicloud-standard-4",
      priority: 2,
      rateMicros: 4000,
      budgetMicros: 1_000_000,
    });
    store.setSecret(`ubicloud:${projectId}`, { token: "fixture-token" });
    expect(
      (
        await server.inject({
          method: "POST",
          url: `/api/providers/${projectId}/refresh`,
          headers,
          cookies,
          payload: {},
        })
      ).statusCode,
    ).toBe(502);
    expect(store.get("provider", projectId, providerSchema)?.verifiedAt).toBe(
      0,
    );
  });
  it("rejects missing provider connections", async () => {
    const { server, headers, cookies } = await make({ signedIn: true });
    expect(
      (
        await server.inject({
          method: "POST",
          url: `/api/providers/${projectId}/refresh`,
          headers,
          cookies,
          payload: {},
        })
      ).statusCode,
    ).toBe(404);
  });
  it("plans complete test groups and validates duplicate suites", async () => {
    const { server, headers, cookies } = await make({ signedIn: true });
    const request = {
      method: "POST" as const,
      url: "/api/tests/plan",
      headers,
      cookies,
    };
    const suites = [
      { name: "one", seconds: 50 },
      { name: "two", seconds: 30 },
    ];
    const result = await server.inject({
      ...request,
      payload: { groups: 2, suites },
    });
    expect(result.statusCode).toBe(200);
    expect(result.json().groups).toHaveLength(2);
    expect(
      (
        await server.inject({
          ...request,
          payload: { groups: 2, suites: [suites[0], suites[0]] },
        })
      ).statusCode,
    ).toBe(400);
  });
  it("does not expose project execution or check mutation endpoints", async () => {
    const { server, cookies, headers } = await make({ signedIn: true });
    expect(
      (
        await server.inject({
          method: "POST",
          url: "/api/jobs/dispatch",
          cookies,
          headers,
          payload: {},
        })
      ).statusCode,
    ).toBe(404);
    const account = newAccount(1, "owner", "owner");
    expect(account.period).toBe(currentPeriod());
  });
  it("hides unexpected internal failures", async () => {
    const { server } = await make();
    server.get("/unexpected", async () => {
      throw new Error("private connection details");
    });
    const result = await server.inject("/unexpected");
    expect(result.statusCode).toBe(500);
    expect(result.body).not.toContain("private connection details");
  });
});
