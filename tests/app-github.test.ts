import { generateKeyPairSync } from "node:crypto";
import { jwtVerify } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AppGitHub } from "../src/server/providers/app-github.js";
import { GitHub } from "../src/server/providers/github.js";
import { Store } from "../src/server/store.js";
import { testConfig, response, sampleApp } from "./fixtures.js";
import { boundedBytes } from "../src/server/providers/http.js";

const stores: Store[] = [];
afterEach(() => {
  stores.splice(0).forEach((store) => store.close());
});
function make() {
  const config = testConfig();
  const store = new Store(":memory:", config.key);
  stores.push(store);
  const fetcher = vi.fn<typeof fetch>();
  const client = new AppGitHub({
    config,
    store,
    fetcher,
    github: new GitHub(fetcher),
  });
  return { client, store, fetcher };
}
describe("GitHub App authority", () => {
  it("signs short-lived RS256 App JWTs from the stored key and scopes installation tokens", async () => {
    const { client, store, fetcher } = make();
    const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
    store.setSecret("github-app", {
      ...sampleApp,
      pem: pair.privateKey.export({ format: "pem", type: "pkcs1" }).toString(),
    });
    const jwt = await client.jwt();
    const verified = await jwtVerify(jwt, pair.publicKey, {
      issuer: sampleApp.client_id,
      algorithms: ["RS256"],
    });
    expect(
      (verified.payload.exp ?? 0) - (verified.payload.iat ?? 0),
    ).toBeLessThan(600);
    fetcher.mockResolvedValueOnce(response({ token: "scoped-token" }));
    expect(await client.token(201, 101, { contents: "read" })).toBe(
      "scoped-token",
    );
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({
      repository_ids: [101],
      permissions: { contents: "read" },
    });
    expect(
      new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("authorization"),
    ).toMatch(/^Bearer ey/);
    fetcher.mockResolvedValueOnce(response({ id: 201, app_id: 10 }));
    expect((await client.installation("owner/source")).id).toBe(201);
  });
  it("rejects missing App setup and narrows repository metadata to an active exact repository", async () => {
    const { client, fetcher } = make();
    await expect(client.jwt()).rejects.toThrow("Connect your GitHub App");
    await expect(client.botId("token")).rejects.toThrow();
    const repo = {
      id: 101,
      full_name: "owner/source",
      private: true,
      archived: false,
      disabled: false,
      default_branch: "main",
      owner: { id: 1, login: "owner" },
    };
    fetcher.mockResolvedValueOnce(response(repo));
    expect((await client.repository("OWNER/source", "scoped")).id).toBe(101);
    fetcher.mockResolvedValueOnce(response({ ...repo, archived: true }));
    await expect(client.repository("owner/source", "scoped")).rejects.toThrow(
      "active",
    );
    fetcher.mockResolvedValueOnce(
      response({ ...repo, full_name: "other/source" }),
    );
    await expect(client.repository("owner/source", "scoped")).rejects.toThrow(
      "active",
    );
    fetcher.mockResolvedValueOnce(response({ sha: "a".repeat(40) }));
    expect(await client.ref("owner/source", "feature/one", "scoped")).toBe(
      "a".repeat(40),
    );
    expect(String(fetcher.mock.calls.at(-1)?.[0])).toContain("feature%2Fone");
  });
  it("authenticates bot lookup with an installation token and handles revoked checkout tokens", async () => {
    const { client, store, fetcher } = make();
    store.setSecret("github-app", sampleApp);
    fetcher.mockResolvedValueOnce(response({ id: 301 }));
    expect(await client.botId("installation-only")).toBe(301);
    expect(
      new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("authorization"),
    ).toBe("Bearer installation-only");
    fetcher.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await client.revoke("read-only-source");
    fetcher.mockResolvedValueOnce(response({}, 401));
    await client.revoke("already-revoked");
    fetcher.mockResolvedValueOnce(response({}, 403));
    await expect(client.revoke("not-revoked")).rejects.toThrow();
  });
  it("bounds response streams before allocating the complete payload", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(10));
      },
      cancel() {
        cancelled = true;
      },
    });
    await expect(boundedBytes(new Response(stream), 12)).rejects.toThrow(
      "oversized",
    );
    expect(cancelled).toBe(true);
    expect(await boundedBytes(new Response(null), 12)).toHaveLength(0);
    const { client, fetcher } = make();
    fetcher.mockResolvedValueOnce(response({ id: "wrong" }));
    await expect(
      client.request("GET", "/test", "token", z.object({ id: z.number() })),
    ).rejects.toThrow("unsupported");
  });
});
