import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  write: vi.fn(),
  mkdir: vi.fn(),
  unlink: vi.fn(),
  exec: vi.fn(),
  spawn: vi.fn(),
  digest: vi.fn(),
}));
vi.mock("node:fs", () => ({
  readFileSync: mocks.read,
  writeFileSync: mocks.write,
  mkdirSync: mocks.mkdir,
  unlinkSync: mocks.unlink,
}));
vi.mock("node:child_process", () => ({
  execFileSync: mocks.exec,
  spawn: mocks.spawn,
}));
vi.mock("node:crypto", () => ({
  createHash: () => ({ update: () => ({ digest: mocks.digest }) }),
}));
const requestId = "39b82ae2-ce68-4350-a173-9350d8ec7219";
const listeners = new Map<
  NodeJS.Signals,
  Array<(signal: NodeJS.Signals) => void>
>();
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    listeners.set(signal, process.listeners(signal));
  for (const [key, value] of Object.entries({
    BUILDFERRY_URL: "https://buildferry.example",
    BUILDFERRY_REQUEST_ID: requestId,
    GITHUB_RUN_ID: "901",
    RUNNER_TEMP: "/tmp/native",
    ACTIONS_ID_TOKEN_REQUEST_URL:
      "https://token.actions.githubusercontent.com/request",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "bootstrap-secret",
    GITHUB_TOKEN: "outer-secret",
    GH_TOKEN: "outer-gh-secret",
  }))
    vi.stubEnv(key, value);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(() => {
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    for (const listener of process.listeners(signal))
      if (!listeners.get(signal)?.includes(listener))
        process.removeListener(signal, listener);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  process.exitCode = 0;
});

describe("native host bootstrap", () => {
  it("requests a bound GitHub identity, reports hardware and writes a masked single-use file", async () => {
    const network = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ value: "signed-identity" })),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ jit: "aGVsbG8=" })));
    vi.stubGlobal("fetch", network);
    await import("../src/worker/native-claim.js");
    expect(String(network.mock.calls[0]?.[0])).toContain(
      "audience=https%3A%2F%2Fbuildferry.example",
    );
    expect(network.mock.calls[1]?.[1]?.headers).toMatchObject({
      Authorization: "Bearer signed-identity",
    });
    expect(JSON.parse(String(network.mock.calls[1]?.[1]?.body))).toMatchObject({
      requestId,
      runId: 901,
      cpuModel: expect.any(String),
    });
    expect(mocks.write).toHaveBeenCalledWith(
      expect.stringContaining("buildferry-native-jit"),
      "aGVsbG8=",
      { mode: 0o600, flag: "wx" },
    );
    expect(console.log).toHaveBeenCalledWith("::add-mask::aGVsbG8=");
  });
  it("rejects unsafe origins and identity endpoints before sending credentials", async () => {
    const network = vi.fn();
    vi.stubGlobal("fetch", network);
    vi.stubEnv("BUILDFERRY_URL", "http://evil.example");
    await expect(import("../src/worker/native-claim.js")).rejects.toThrow(
      "origin",
    );
    vi.resetModules();
    vi.stubEnv("BUILDFERRY_URL", "https://buildferry.example");
    vi.stubEnv("ACTIONS_ID_TOKEN_REQUEST_URL", "https://evil.example/request");
    await expect(import("../src/worker/native-claim.js")).rejects.toThrow(
      "endpoint",
    );
    expect(network).not.toHaveBeenCalled();
    expect(mocks.write).not.toHaveBeenCalled();
  });
  it("does not write or launch an unauthorized host", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ value: "signed" })),
        )
        .mockResolvedValueOnce(new Response("denied", { status: 409 })),
    );
    await expect(import("../src/worker/native-claim.js")).rejects.toThrow(
      "authorize",
    );
    expect(mocks.write).not.toHaveBeenCalled();
  });
});

describe("official native runner launcher", () => {
  it("checks the archive, consumes JIT once, and removes host credentials from the source runner", async () => {
    mocks.read
      .mockReturnValueOnce("aGVsbG8=")
      .mockReturnValueOnce(Buffer.from("archive"));
    mocks.digest.mockReturnValue(
      "af4b794c1bc41d73d40535e3fe092a39f9679cd8d965954c2aca25a05ca41d32",
    );
    const child = Object.assign(new EventEmitter(), { kill: vi.fn() });
    mocks.spawn.mockReturnValue(child);
    await import("../src/worker/native-run.js");
    const options = mocks.spawn.mock.calls[0]?.[2] as {
      env: NodeJS.ProcessEnv;
    };
    expect(
      Object.keys(options.env).some((key) =>
        /^(ACTIONS_|GITHUB_|RUNNER_|BUILDFERRY_|GH_TOKEN$)/.test(key),
      ),
    ).toBe(false);
    expect(mocks.exec.mock.calls[0]?.[1]).toContain(
      "https://github.com/actions/runner/releases/download/v2.338.0/actions-runner-linux-x64-2.338.0.tar.gz",
    );
    expect(mocks.unlink.mock.calls[0]?.[0]).toContain("buildferry-native-jit");
    expect(mocks.spawn.mock.calls[0]?.[1]).toEqual(["--jitconfig", "aGVsbG8="]);
    child.emit("exit", 7);
    expect(process.exitCode).toBe(7);
  });
  it("never extracts or executes an archive with an incorrect checksum", async () => {
    mocks.read
      .mockReturnValueOnce("aGVsbG8=")
      .mockReturnValueOnce(Buffer.from("archive"));
    mocks.digest.mockReturnValue("wrong");
    await expect(import("../src/worker/native-run.js")).rejects.toThrow(
      "checksum",
    );
    expect(mocks.exec).toHaveBeenCalledTimes(1);
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
});
