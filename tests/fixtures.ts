import { randomBytes } from "node:crypto";
import path from "node:path";
import { vi } from "vitest";
import { Store } from "../src/server/store.js";
import { createApp } from "../src/server/app.js";
import { newAccount } from "../src/server/auth.js";
import type { GitHubApp } from "../src/server/providers/github.js";
import type { Config } from "../src/server/config.js";
import type { VerifyWorkerIdentity } from "../src/server/worker-identity.js";

export const sampleApp: GitHubApp = {
  id: 10,
  slug: "buildferry-test",
  client_id: "test-client",
  client_secret: "test-client-secret",
  webhook_secret: "test-webhook",
  pem: "unused-test-key",
  owner: { id: 1, login: "owner", type: "User" },
};
export const projectId = "pj000000000000000000000000";
export const response = (body: object, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    publicUrl: "https://buildferry.example",
    dataDir: path.resolve(".cache"),
    key: randomBytes(32),
    port: 8787,
    host: "127.0.0.1",
    demo: false,
    trustProxyHops: 0,
    ...overrides,
  };
}
export async function fixture(
  options: {
    demo?: boolean;
    signedIn?: boolean;
    fetcher?: typeof fetch;
    proxyHops?: number;
    verifyWorkerIdentity?: VerifyWorkerIdentity;
    config?: Partial<Config>;
  } = {},
) {
  const config = testConfig({
    demo: options.demo ?? false,
    trustProxyHops: options.proxyHops ?? 0,
    ...options.config,
  });
  const store = new Store(":memory:", config.key);
  const fetcher =
    options.fetcher ??
    vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("Unexpected network request"));
  const app = await createApp(config, {
    store,
    fetcher,
    claimCode: "fixture-claim-code",
    startController: false,
    verifyWorkerIdentity: options.verifyWorkerIdentity,
  });
  if (options.signedIn) {
    store.put("config", "owner", 1);
    store.put("account", "1", newAccount(1, "owner", "owner"));
    store.saveSession(
      "owner-session",
      { githubId: 1, csrf: "owner-csrf", setup: false },
      Date.now() + 60_000,
    );
  }
  const headers = {
    origin: config.publicUrl,
    "x-buildferry-csrf": "owner-csrf",
  };
  const cookies = { bf_session: "owner-session" };
  return { ...app, config, fetcher, headers, cookies };
}
