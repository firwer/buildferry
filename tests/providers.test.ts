import { describe, expect, it, vi } from "vitest";
import { GitHub } from "../src/server/providers/github.js";
import { providerJson } from "../src/server/providers/http.js";
import {
  verifyUbicloud,
  verifyUbicloudWorker,
} from "../src/server/providers/ubicloud.js";
import { z } from "zod";
import { projectId, response, sampleApp } from "./fixtures.js";

describe("provider requests", () => {
  it("authenticates GitHub reads and disables redirects", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response({ id: 1, login: "owner" }));
    expect(await new GitHub(fetcher).user("fixture-token")).toEqual({
      id: 1,
      login: "owner",
    });
    expect(fetcher).toHaveBeenCalledWith(
      "https://api.github.com/user",
      expect.objectContaining({
        redirect: "error",
        headers: expect.objectContaining({
          Authorization: "Bearer fixture-token",
        }),
      }),
    );
  });
  it("never exposes a provider's error body", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response({ error: "secret echo" }, 401));
    await expect(new GitHub(fetcher).user("fixture-token")).rejects.toThrow(
      "Check its access",
    );
  });
  it("rejects malformed, oversized or unreachable provider responses", async () => {
    const failed = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("private internal detail"));
    await expect(new GitHub(failed).user("token")).rejects.toThrow(
      "could not be reached",
    );
    const malformed = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("not json"));
    await expect(new GitHub(malformed).user("token")).rejects.toThrow(
      "unsupported response",
    );
    const oversized = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("x".repeat(8_000_001)));
    await expect(
      providerJson(oversized, "https://api.github.com/user", z.object({}), {}),
    ).rejects.toThrow("unsupported response");
  });
  it("exchanges an OAuth code with PKCE and records expiry", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      response({
        access_token: "new-token",
        refresh_token: "new-refresh",
        expires_in: 60,
      }),
    );
    const result = await new GitHub(fetcher).exchange(sampleApp, {
      code: "one-use",
      code_verifier: "verifier",
    });
    expect(result.access_token).toBe("new-token");
    expect(result.expires_at).toBeGreaterThan(Date.now());
    const options = fetcher.mock.calls[0]?.[1];
    expect(String(options?.body)).toContain("code_verifier=verifier");
    expect(String(options?.body)).toContain("client_secret=test-client-secret");
  });
  it("supports GitHub authorizations without expiry", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response({ access_token: "token" }));
    expect(
      (await new GitHub(fetcher).exchange(sampleApp, { code: "one-use" }))
        .expires_at,
    ).toBeNull();
  });
});

describe("GitHub usage and repository eligibility", () => {
  const row = {
    date: "2026-10-18",
    product: "Actions",
    sku: "actions_linux",
    quantity: 45,
    unitType: "minutes",
  };
  it("sums owner-wide Linux usage and ignores other product storage", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      response({
        usageItems: [
          row,
          { ...row, quantity: 10 },
          { ...row, product: "Packages" },
          { ...row, unitType: "GB" },
        ],
      }),
    );
    expect(await new GitHub(fetcher).usage("owner", "token", "2026-10")).toBe(
      55,
    );
    expect(String(fetcher.mock.calls[0]?.[0])).not.toContain("repository=");
  });
  it.each([
    { sku: "actions_macos" },
    { date: "2026-09-18" },
    { quantity: 1_000_001 },
  ])("fails closed on unsupported usage %o", (changes) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response({ usageItems: [{ ...row, ...changes }] }));
    return expect(
      new GitHub(fetcher).usage("owner", "token", "2026-10"),
    ).rejects.toThrow();
  });
  it("rounds verified fractional usage up instead of rejecting it or overstating free capacity", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      response({
        usageItems: [
          { ...row, quantity: 45.25 },
          { ...row, quantity: 0.5 },
        ],
      }),
    );
    expect(await new GitHub(fetcher).usage("owner", "token", "2026-10")).toBe(
      46,
    );
  });
  it("allows an empty verified report", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response({ usageItems: [] }));
    expect(await new GitHub(fetcher).usage("owner", "token", "2026-10")).toBe(
      0,
    );
  });
  it.each([
    { private: false },
    { archived: true },
    { disabled: true },
    { owner: { id: 2 } },
  ])("rejects ineligible CI repositories %o", (changes) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      response({
        private: true,
        archived: false,
        disabled: false,
        owner: { id: 1 },
        ...changes,
      }),
    );
    return expect(
      new GitHub(fetcher).repository("owner", 1, "ci", "token"),
    ).rejects.toThrow("active private");
  });
  it("accepts a private CI repository belonging to the linked owner", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      response({
        private: true,
        archived: false,
        disabled: false,
        owner: { id: 1 },
      }),
    );
    await expect(
      new GitHub(fetcher).repository("owner", 1, "ci", "token"),
    ).resolves.toBeUndefined();
  });
});

describe("Ubicloud connection verification", () => {
  it("verifies the exact worker repository before paid dispatch", async () => {
    const provider = {
      projectId,
      name: "Cloud",
      installations: [{ id: "install-1", name: "owner" }],
      runner: "ubicloud-standard-4" as const,
      priority: 2,
      rateMicros: 1000,
      budgetMicros: 50000,
      verifiedAt: Date.now(),
    };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(
      response({
        id: "repo-1",
        installation_name: "owner",
        name: "buildferry-ci",
      }),
    );
    await verifyUbicloudWorker(
      provider,
      "owner/buildferry-ci",
      "ubicloud-secret",
      fetcher,
    );
    expect(String(fetcher.mock.calls[0]?.[0])).toContain(
      "/github/install-1/repository/buildferry-ci",
    );
    expect(
      new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("authorization"),
    ).toBe("Bearer ubicloud-secret");
    await expect(
      verifyUbicloudWorker(provider, "other/ci", "secret", fetcher),
    ).rejects.toThrow("worker's owner");
    fetcher.mockResolvedValueOnce(
      response({ id: "repo-1", installation_name: "owner", name: "other-ci" }),
    );
    await expect(
      verifyUbicloudWorker(provider, "owner/buildferry-ci", "secret", fetcher),
    ).rejects.toThrow("different worker");
  });
  it("checks project identity and all GitHub connections without provisioning compute", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ id: projectId, name: "Team" }))
      .mockResolvedValueOnce(
        response({ count: 1, items: [{ id: "installation", name: "owner" }] }),
      );
    expect(await verifyUbicloud(projectId, "test-token", fetcher)).toEqual({
      name: "Team",
      installations: [{ id: "installation", name: "owner" }],
    });
    expect(
      fetcher.mock.calls.every(
        ([, options]) => !options?.method || options.method === "GET",
      ),
    ).toBe(true);
  });
  it("rejects mismatched projects and incomplete installations", async () => {
    const mismatch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response({ id: "another", name: "Team" }));
    await expect(verifyUbicloud(projectId, "token", mismatch)).rejects.toThrow(
      "different project",
    );
    const incomplete = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ id: projectId, name: "Team" }))
      .mockResolvedValueOnce(
        response({ count: 2, items: [{ id: "one", name: "owner" }] }),
      );
    await expect(
      verifyUbicloud(projectId, "token", incomplete),
    ).rejects.toThrow("Connect a GitHub");
  });
});
