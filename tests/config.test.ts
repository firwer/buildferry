import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/server/config.js";
import { Store } from "../src/server/store.js";

const directories: string[] = [];
function directory() {
  const value = mkdtempSync(path.join(tmpdir(), "buildferry-config-"));
  directories.push(value);
  return value;
}
afterEach(() => {
  for (const value of directories.splice(0))
    rmSync(value, { recursive: true, force: true });
});

describe("self-hosted configuration", () => {
  it("persists a private key across restarts and accepts an external key", () => {
    const dataDir = directory();
    const first = loadConfig({ BUILDFERRY_DATA_DIR: dataDir }, false);
    expect(first.key.length).toBe(32);
    expect(loadConfig({ BUILDFERRY_DATA_DIR: dataDir }, false).key).toEqual(
      first.key,
    );
    expect(readFileSync(path.join(dataDir, "credentials.key"))).toEqual(
      first.key,
    );
    const key = randomBytes(32);
    expect(
      loadConfig({ BUILDFERRY_ENCRYPTION_KEY: key.toString("base64") }, false)
        .key,
    ).toEqual(key);
    expect(() =>
      loadConfig({ BUILDFERRY_ENCRYPTION_KEY: "short" }, false),
    ).toThrow("32 bytes");
  });
  it("requires HTTPS and rejects paths, credentials and off-host demos", () => {
    const key = randomBytes(32).toString("base64");
    for (const url of [
      "http://buildferry.example",
      "https://example.com/path",
      "https://user:password@example.com",
      "https://example.com/?x=1",
      "https://example.com/#x",
    ]) {
      expect(() =>
        loadConfig(
          { BUILDFERRY_PUBLIC_URL: url, BUILDFERRY_ENCRYPTION_KEY: key },
          false,
        ),
      ).toThrow();
    }
    expect(() =>
      loadConfig({ BUILDFERRY_PUBLIC_URL: "https://example.com" }, true),
    ).toThrow("localhost");
    const demo = loadConfig({ HOST: "0.0.0.0" }, true);
    expect(demo.host).toBe("127.0.0.1");
    expect(demo.demo).toBe(true);
    expect(() => loadConfig({ PORT: "0" }, true)).toThrow();
  });
  it("refuses a lost key instead of generating a replacement for an existing database", () => {
    const dataDir = directory();
    writeFileSync(path.join(dataDir, "buildferry.sqlite"), "existing");
    expect(() => loadConfig({ BUILDFERRY_DATA_DIR: dataDir }, false)).toThrow(
      "key is missing",
    );
  });
  it("refuses a wrong key or a database from a newer release", () => {
    const filename = path.join(directory(), "buildferry.sqlite");
    const key = randomBytes(32);
    const store = new Store(filename, key);
    store.close();
    expect(() => new Store(filename, randomBytes(32))).toThrow("original key");
    const newer = new Store(filename, key);
    newer.db.exec("INSERT INTO migrations(version) VALUES(2)");
    newer.close();
    expect(() => new Store(filename, key)).toThrow("newer BuildFerry");
  });
});
