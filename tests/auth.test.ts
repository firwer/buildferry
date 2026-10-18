import { createHmac, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { Credentials } from "../src/server/auth.js";
import { GitHub, appSchema } from "../src/server/providers/github.js";
import { digest } from "../src/server/crypto.js";
import { sessionSchema } from "../src/shared/contracts.js";
import { fixture, response, sampleApp } from "./fixtures.js";

const apps: Awaited<ReturnType<typeof fixture>>[] = [];
async function make(options: Parameters<typeof fixture>[0] = {}) {
  const app = await fixture(options);
  apps.push(app);
  return app;
}
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.server.close()));
});

async function claim(app: Awaited<ReturnType<typeof fixture>>) {
  const result = await app.server.inject({
    method: "POST",
    url: "/api/claim",
    headers: { origin: app.config.publicUrl },
    payload: { code: "fixture-claim-code" },
  });
  const cookies = {
    bf_session:
      result.cookies.find((item) => item.name === "bf_session")?.value ?? "",
  };
  const session = sessionSchema.parse(
    (await app.server.inject({ url: "/api/session", cookies })).json(),
  );
  return {
    cookies,
    headers: {
      origin: app.config.publicUrl,
      "x-buildferry-csrf": session.csrf,
    },
  };
}

describe("GitHub App setup and OAuth", () => {
  it("completes a bound manifest and PKCE sign-in without returning credentials", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(sampleApp))
      .mockResolvedValueOnce(
        response({
          access_token: "fixture-access",
          refresh_token: "fixture-refresh",
          expires_in: 28800,
        }),
      )
      .mockResolvedValueOnce(response({ id: 1, login: "owner" }));
    const app = await make({ fetcher });
    const setup = await claim(app);
    const prepared = await app.server.inject({
      method: "POST",
      url: "/api/setup/manifest",
      ...setup,
      payload: { name: "BuildFerry Team Test" },
    });
    expect(prepared.statusCode).toBe(200);
    const form = prepared.json<{
      url: string;
      manifest: { default_permissions: object; default_events: string[] };
    }>();
    expect(form.manifest.default_events).toEqual([
      "push",
      "workflow_job",
      "workflow_run",
    ]);
    expect(form.manifest.default_permissions).toEqual({
      actions: "write",
      contents: "write",
      checks: "write",
      workflows: "write",
      metadata: "read",
      plan: "read",
      repository_creation: "write",
      administration: "write",
    });
    const state = new URL(form.url).searchParams.get("state") ?? "";
    const conversion = await app.server.inject({
      url: `/setup/github/callback?code=manifest-code&state=${state}`,
      cookies: setup.cookies,
    });
    expect(conversion.statusCode).toBe(302);
    const signIn = await app.server.inject({
      url: "/auth/github",
      cookies: setup.cookies,
    });
    const location = new URL(String(signIn.headers.location));
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    const oauth = location.searchParams.get("state") ?? "";
    const completed = await app.server.inject({
      url: `/auth/callback?code=oauth-code&state=${oauth}`,
      cookies: { ...setup.cookies, bf_oauth: oauth },
    });
    expect(completed.statusCode).toBe(302);
    const signedCookies = {
      bf_session:
        completed.cookies.find((item) => item.name === "bf_session")?.value ??
        "",
    };
    const session = await app.server.inject({
      url: "/api/session",
      cookies: signedCookies,
    });
    expect(sessionSchema.parse(session.json()).user?.role).toBe("owner");
    expect(session.body).not.toMatch(
      /fixture-access|fixture-refresh|test-client-secret|test-webhook|unused-test-key/,
    );
    expect(
      (
        await app.server.inject({
          url: `/setup/github/callback?code=manifest-code&state=${state}`,
          cookies: setup.cookies,
        })
      ).statusCode,
    ).toBe(403);
  });
  it("binds manifest registration to the setup browser and expires its state", async () => {
    const app = await make();
    const setup = await claim(app);
    const prepared = await app.server.inject({
      method: "POST",
      url: "/api/setup/manifest",
      ...setup,
      payload: { name: "BuildFerry Test" },
    });
    const state = new URL(prepared.json().url).searchParams.get("state");
    expect(
      (
        await app.server.inject(
          `/setup/github/callback?code=code&state=${state}`,
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.server.inject({
          url: "/setup/github/callback?code=code&state=missing",
          cookies: setup.cookies,
        })
      ).statusCode,
    ).toBe(403);
    expect((await app.server.inject("/auth/github")).statusCode).toBe(409);
  });
  it("does not allow a registered app to be replaced by another setup", async () => {
    const app = await make();
    const setup = await claim(app);
    app.store.setSecret("github-app", sampleApp);
    expect(
      (
        await app.server.inject({
          method: "POST",
          url: "/api/setup/manifest",
          ...setup,
          payload: { name: "Another app" },
        })
      ).statusCode,
    ).toBe(409);
  });
  it("requires a setup session before the first GitHub sign-in", async () => {
    const app = await make();
    app.store.setSecret("github-app", sampleApp);
    expect((await app.server.inject("/auth/github")).statusCode).toBe(403);
  });
  it("rejects mismatched OAuth browser cookies before contacting GitHub", async () => {
    const app = await make();
    expect(
      (
        await app.server.inject({
          url: "/auth/callback?code=one&state=two",
          cookies: { bf_oauth: "three" },
        })
      ).statusCode,
    ).toBe(403);
    expect(app.fetcher).not.toHaveBeenCalled();
    expect(
      (
        await app.server.inject({
          url: "/auth/callback?code=one&state=two",
          cookies: { bf_oauth: "two" },
        })
      ).statusCode,
    ).toBe(403);
  });
  it("rejects initial setup by anyone except the GitHub App's owner", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ access_token: "fixture" }))
      .mockResolvedValueOnce(response({ id: 2, login: "outsider" }));
    const app = await make({ fetcher });
    const setup = await claim(app);
    app.store.setSecret("github-app", sampleApp);
    const start = await app.server.inject({
      url: "/auth/github",
      cookies: setup.cookies,
    });
    const state =
      new URL(String(start.headers.location)).searchParams.get("state") ?? "";
    expect(
      (
        await app.server.inject({
          url: `/auth/callback?code=code&state=${state}`,
          cookies: { ...setup.cookies, bf_oauth: state },
        })
      ).statusCode,
    ).toBe(403);
    expect(app.store.get("config", "owner", z.number())).toBeNull();
  });
  it("requires a valid invitation for unknown members and consumes it once", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ access_token: "fixture" }))
      .mockResolvedValueOnce(response({ id: 2, login: "member" }));
    const app = await make({ signedIn: true, fetcher });
    app.store.setSecret("github-app", sampleApp);
    const invite = await app.server.inject({
      method: "POST",
      url: "/api/invitations",
      headers: app.headers,
      cookies: app.cookies,
      payload: {},
    });
    const token = new URL(invite.json().url).searchParams.get("invite") ?? "";
    const start = await app.server.inject(`/auth/github?invite=${token}`);
    const state =
      new URL(String(start.headers.location)).searchParams.get("state") ?? "";
    const complete = await app.server.inject({
      url: `/auth/callback?code=code&state=${state}`,
      cookies: { bf_oauth: state },
    });
    expect(complete.statusCode).toBe(302);
    expect(app.store.hasInvite(token)).toBe(false);
    expect(
      (await app.server.inject(`/auth/github?invite=${token}`)).statusCode,
    ).toBe(403);
    const cookies = {
      bf_session:
        complete.cookies.find((item) => item.name === "bf_session")?.value ??
        "",
    };
    expect(
      sessionSchema.parse(
        (await app.server.inject({ url: "/api/session", cookies })).json(),
      ).user?.role,
    ).toBe("member");
  });
  it("does not grant a new membership just for installing or authorizing the app", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ access_token: "fixture" }))
      .mockResolvedValueOnce(response({ id: 2, login: "outsider" }));
    const app = await make({ signedIn: true, fetcher });
    app.store.setSecret("github-app", sampleApp);
    const start = await app.server.inject("/auth/github");
    const state =
      new URL(String(start.headers.location)).searchParams.get("state") ?? "";
    expect(
      (
        await app.server.inject({
          url: `/auth/callback?code=code&state=${state}`,
          cookies: { bf_oauth: state },
        })
      ).statusCode,
    ).toBe(403);
  });
  it("allows a known owner to sign in again without another invitation", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ access_token: "fixture" }))
      .mockResolvedValueOnce(response({ id: 1, login: "renamed-owner" }));
    const app = await make({ signedIn: true, fetcher });
    app.store.setSecret("github-app", sampleApp);
    const start = await app.server.inject("/auth/github");
    const state =
      new URL(String(start.headers.location)).searchParams.get("state") ?? "";
    expect(
      (
        await app.server.inject({
          url: `/auth/callback?code=code&state=${state}`,
          cookies: { bf_oauth: state },
        })
      ).statusCode,
    ).toBe(302);
  });
});

describe("webhook authentication", () => {
  it("checks the exact raw body and deduplicates signed deliveries", async () => {
    const app = await make();
    app.store.setSecret("github-app", sampleApp);
    const payload = '{ "action": "created" }';
    const signature = `sha256=${createHmac("sha256", sampleApp.webhook_secret).update(payload).digest("hex")}`;
    const request = {
      method: "POST" as const,
      url: "/api/github/webhook",
      payload,
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": signature,
        "x-github-delivery": randomUUID(),
      },
    };
    expect((await app.server.inject(request)).json()).toEqual({
      received: true,
      duplicate: false,
    });
    expect((await app.server.inject(request)).json()).toEqual({
      received: true,
      duplicate: true,
    });
    expect(
      (await app.server.inject({ ...request, payload: '{"action":"created"}' }))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await app.server.inject({
          ...request,
          headers: { "content-type": "application/json" },
        })
      ).statusCode,
    ).toBe(403);
  });
});

describe("credential refresh", () => {
  it("shares an expiring token refresh across concurrent callers", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      response({
        access_token: "fresh",
        refresh_token: "rotated",
        expires_in: 28800,
      }),
    );
    const app = await make({ signedIn: true, fetcher });
    app.store.setSecret("github-app", sampleApp);
    app.store.setSecret("github-user:1", {
      access_token: "old",
      refresh_token: "old-refresh",
      expires_at: 1,
    });
    const credentials = new Credentials({
      config: app.config,
      store: app.store,
      fetcher,
      github: new GitHub(fetcher),
    });
    expect(
      await Promise.all([credentials.token(1), credentials.token(1)]),
    ).toEqual(["fresh", "fresh"]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(
      app.store.secret("github-user:1", z.object({ refresh_token: z.string() }))
        ?.refresh_token,
    ).toBe("rotated");
    expect(await credentials.token(1)).toBe("fresh");
  });
  it("requires reconnection for missing refresh credentials", async () => {
    const app = await make({ signedIn: true });
    const credentials = new Credentials({
      config: app.config,
      store: app.store,
      fetcher: app.fetcher,
      github: new GitHub(app.fetcher),
    });
    await expect(credentials.token(1)).rejects.toThrow("Reconnect");
    app.store.setSecret("github-user:1", {
      access_token: "old",
      expires_at: 1,
    });
    await expect(credentials.token(1)).rejects.toThrow("Reconnect");
    expect(app.store.secret("github-app", appSchema)).toBeNull();
    expect(digest("one")).not.toBe(digest("two"));
  });
});
