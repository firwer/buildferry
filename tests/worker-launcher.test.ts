import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
const mocks = vi.hoisted(() => ({
  exec: vi.fn(),
  spawn: vi.fn(),
  read: vi.fn(),
  mkdir: vi.fn(),
  write: vi.fn(),
}));
vi.mock("node:child_process", () => ({
  execFileSync: mocks.exec,
  spawnSync: mocks.spawn,
}));
vi.mock("node:fs", () => ({
  readFileSync: mocks.read,
  mkdirSync: mocks.mkdir,
  writeFileSync: mocks.write,
}));

const sha = "a".repeat(40);
const requestId = "39b82ae2-ce68-4350-a173-9350d8ec7219";
const claim = {
  sourceRepository: "owner/source",
  sourceRepositoryId: 101,
  sourceSha: sha,
  sourceToken: "source-read-only-secret",
  recipeHash: "c".repeat(64),
  directory: ".",
  commands: ["npm ci", "npm test"],
};
function json(body: object, status = 200) {
  return new Response(JSON.stringify(body), { status });
}
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  for (const [name, value] of Object.entries({
    BUILDFERRY_URL: "https://buildferry.example",
    BUILDFERRY_REQUEST_ID: requestId,
    GITHUB_RUN_ID: "901",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_REPOSITORY_ID: "301",
    GITHUB_SHA: "b".repeat(40),
    RUNNER_TEMP: path.resolve(".cache/worker-fixture"),
    ACTIONS_ID_TOKEN_REQUEST_URL:
      "https://token.actions.githubusercontent.com/request",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc-request-secret",
  }))
    vi.stubEnv(name, value);
  mocks.exec.mockImplementation((_binary: string, args: string[]) =>
    args[0] === "rev-parse" ? sha : "",
  );
  mocks.spawn.mockReturnValue({ status: 0 });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  process.exitCode = 0;
});
function network(
  overrides: { revoked?: boolean; accepted?: boolean; claimed?: object } = {},
) {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
    const url = String(input);
    if (url.startsWith("https://token.actions.githubusercontent.com/"))
      return json({ value: "signed-worker-identity" });
    if (url.endsWith("/api/worker/claim"))
      return json(
        overrides.claimed ?? claim,
        overrides.accepted === false ? 403 : 200,
      );
    if (url.endsWith("/api/worker/prepared"))
      return json({ ok: true }, overrides.revoked === false ? 503 : 200);
    throw new Error("Unexpected worker endpoint");
  });
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}
describe("trusted worker launchers", () => {
  it("revokes source access before checkout can invoke a working-tree filter", async () => {
    const fetcher = network();
    mocks.exec.mockImplementation((_binary: string, args: string[]) => {
      if (args[0] === "checkout")
        expect(String(fetcher.mock.calls.at(-1)?.[0])).toContain(
          "/api/worker/prepared",
        );
      return args[0] === "rev-parse" ? sha : "";
    });
    await import("../src/worker/prepare.js");
  });
  it("does not write an executable recipe after a working-tree checkout failure", async () => {
    network();
    mocks.exec.mockImplementation((_binary: string, args: string[]) => {
      if (args[0] === "checkout") throw new Error("Filter failed");
      return args[0] === "rev-parse" ? sha : "";
    });
    await expect(import("../src/worker/prepare.js")).rejects.toThrow(
      "could not be checked out",
    );
    expect(mocks.write).not.toHaveBeenCalled();
  });
  it("fetches the exact revision with transient authentication and revokes before preserving evidence", async () => {
    const fetcher = network();
    await import("../src/worker/prepare.js");
    expect(
      mocks.exec.mock.calls.some(
        ([, args]) =>
          JSON.stringify(args) ===
          JSON.stringify(["fetch", "--no-tags", "--depth=1", "origin", sha]),
      ),
    ).toBe(true);
    const gitFetch = mocks.exec.mock.calls.find(
      ([, args]) => args[0] === "fetch",
    );
    expect(gitFetch?.[2].env.GIT_CONFIG_VALUE_0).toMatch(
      /^AUTHORIZATION: basic /,
    );
    expect(
      mocks.exec.mock.calls
        .filter(([, args]) => args[0] !== "fetch")
        .every(([, , options]) => !options.env.GIT_CONFIG_VALUE_0),
    ).toBe(true);
    expect(fetcher.mock.calls.at(-1)?.[0].toString()).toContain(
      "/api/worker/prepared",
    );
    expect(
      mocks.write.mock.calls.map(([, contents]) => String(contents)).join("\n"),
    ).not.toContain(claim.sourceToken);
    expect(JSON.parse(String(mocks.write.mock.calls[1]?.[1]))).toMatchObject({
      sourceSha: sha,
      requestId,
      workerRepositoryId: 301,
      runId: 901,
    });
  });
  it("revokes even after checkout failure and never leaves a runnable recipe", async () => {
    const fetcher = network();
    mocks.exec.mockImplementation(() => {
      throw new Error("git could expose credential details");
    });
    await expect(import("../src/worker/prepare.js")).rejects.toThrow(
      "could not be checked out",
    );
    expect(fetcher.mock.calls.at(-1)?.[0].toString()).toContain(
      "/api/worker/prepared",
    );
    expect(mocks.write).not.toHaveBeenCalled();
  });
  it("refuses to run if revocation is not confirmed", async () => {
    network({ revoked: false });
    await expect(import("../src/worker/prepare.js")).rejects.toThrow(
      "could not be revoked",
    );
    expect(mocks.write).not.toHaveBeenCalled();
  });
  it.each([
    { sourceSha: "untrusted" },
    { recipeHash: "untrusted" },
    { sourceRepository: "https://attacker.example" },
    { commands: [1] },
  ])("rejects an invalid preparation response", async (changed) => {
    network({ claimed: { ...claim, ...changed } });
    await expect(import("../src/worker/prepare.js")).rejects.toThrow("Invalid");
    expect(mocks.exec).not.toHaveBeenCalled();
  });
  it("refuses denied claims and non-HTTPS service addresses", async () => {
    network({ accepted: false });
    await expect(import("../src/worker/prepare.js")).rejects.toThrow(
      "not admitted",
    );
    vi.resetModules();
    vi.stubEnv("BUILDFERRY_URL", "http://buildferry.example");
    await expect(import("../src/worker/prepare.js")).rejects.toThrow("HTTPS");
  });
  it("rejects escaped working directories and missing request identity", async () => {
    network({ claimed: { ...claim, directory: "../outside" } });
    await expect(import("../src/worker/prepare.js")).rejects.toThrow(
      "escapes the checkout",
    );
    vi.resetModules();
    vi.stubEnv("BUILDFERRY_REQUEST_ID", "invalid");
    await expect(import("../src/worker/prepare.js")).rejects.toThrow(
      "Invalid request",
    );
    vi.resetModules();
    vi.stubEnv("BUILDFERRY_URL", "");
    await expect(import("../src/worker/prepare.js")).rejects.toThrow("Missing");
  });
  it("removes worker identity credentials and fails the recipe at the first failing command", async () => {
    mocks.read.mockReturnValue(
      JSON.stringify({
        directory: "C:/worker-temp/buildferry-source",
        commands: ["first-command", "failing-command", "must-not-run"],
      }),
    );
    mocks.spawn
      .mockReturnValueOnce({ status: 0 })
      .mockReturnValueOnce({ status: 1 });
    await import("../src/worker/run.js");
    expect(mocks.spawn).toHaveBeenCalledTimes(2);
    expect(process.exitCode).toBe(1);
    expect(
      mocks.spawn.mock.calls[0]?.[2].env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
    ).toBeUndefined();
    expect(
      mocks.spawn.mock.calls[0]?.[2].env.ACTIONS_ID_TOKEN_REQUEST_URL,
    ).toBeUndefined();
  });
  it("executes all approved commands in order and validates the local preparation file", async () => {
    mocks.read.mockReturnValue(
      JSON.stringify({
        directory: "C:/worker-temp/source",
        commands: ["one", "two"],
      }),
    );
    await import("../src/worker/run.js");
    expect(mocks.spawn.mock.calls.map(([, args]) => args.at(-1))).toEqual([
      "one",
      "two",
    ]);
    vi.resetModules();
    mocks.read.mockReturnValue(JSON.stringify({ commands: ["one"] }));
    await expect(import("../src/worker/run.js")).rejects.toThrow("invalid");
    vi.resetModules();
    vi.stubEnv("RUNNER_TEMP", "");
    await expect(import("../src/worker/run.js")).rejects.toThrow("missing");
  });
});
