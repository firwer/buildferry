import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Store } from "../src/server/store.js";
import { equalSecret, seal, unseal } from "../src/server/crypto.js";

describe("credential encryption and state persistence", () => {
  it("encrypts credentials and binds them to their owner", () => {
    const key = randomBytes(32);
    const encrypted = seal(key, "alice", "private token");
    expect(encrypted).not.toContain("private token");
    expect(unseal(key, "alice", encrypted)).toBe("private token");
    expect(() => unseal(key, "bob", encrypted)).toThrow();
    expect(() => unseal(randomBytes(32), "alice", encrypted)).toThrow();
    expect(() => unseal(key, "alice", "x")).toThrow("Invalid stored");
    expect(equalSecret("same", "same")).toBe(true);
    expect(equalSecret("same", "other")).toBe(false);
  });
  it("preserves encrypted credentials across database restarts", () => {
    mkdirSync(".cache", { recursive: true });
    const filename = path.resolve(".cache", `test-${randomUUID()}.sqlite`);
    const key = randomBytes(32);
    let store = new Store(filename, key);
    try {
      store.setSecret("github", { token: "sensitive fixture" });
      store.put("account", "one", { name: "owner" });
      store.close();
      store = new Store(filename, key);
      expect(store.secret("github", z.object({ token: z.string() }))).toEqual({
        token: "sensitive fixture",
      });
      expect(
        store.db.prepare("SELECT body FROM secrets").get()?.body,
      ).not.toContain("sensitive fixture");
      expect(store.list("account", z.object({ name: z.string() }))).toEqual([
        { name: "owner" },
      ]);
      store.remove("account", "one");
      expect(store.list("account", z.object({}))).toEqual([]);
      store.deleteSecret("github");
      expect(store.secret("github", z.object({}))).toBeNull();
    } finally {
      store.close();
      for (const suffix of ["", "-wal", "-shm"])
        rmSync(filename + suffix, { force: true });
    }
  });
  it("rolls back multi-step changes and safely nests state consumption", () => {
    const store = new Store(":memory:", randomBytes(32));
    try {
      store.state(
        "invite",
        { kind: "invite", sessionHash: "", verifier: "", invite: "" },
        Date.now() + 1000,
      );
      expect(() =>
        store.transaction(() => {
          store.takeState("invite");
          store.put("x", "a", 1);
          throw new Error("rollback");
        }),
      ).toThrow("rollback");
      expect(store.hasInvite("invite")).toBe(true);
      expect(store.get("x", "a", z.number())).toBeNull();
      expect(store.takeState("invite")?.kind).toBe("invite");
      expect(store.hasInvite("invite")).toBe(false);
      expect(store.takeState("invite")).toBeNull();
    } finally {
      store.close();
    }
  });
  it("expires sessions and states, and never stores reusable session tokens", () => {
    const store = new Store(":memory:", randomBytes(32));
    try {
      store.saveSession(
        "raw-session",
        { csrf: "csrf", githubId: 1, setup: false },
        100,
      );
      store.state(
        "raw-state",
        {
          kind: "oauth",
          verifier: "private verifier",
          sessionHash: "",
          invite: "",
        },
        100,
      );
      expect(store.session("raw-session", 99)?.githubId).toBe(1);
      expect(store.session("raw-session", 100)).toBeNull();
      expect(
        store.db.prepare("SELECT hash FROM sessions").get()?.hash,
      ).not.toBe("raw-session");
      expect(
        store.db.prepare("SELECT body FROM states").get()?.body,
      ).not.toContain("private verifier");
      store.prune(100);
      expect(store.takeState("raw-state", 99)).toBeNull();
      store.saveSession(
        "another",
        { csrf: "csrf", githubId: 1, setup: false },
        100,
      );
      store.deleteIdentitySessions(1);
      expect(store.session("another", 99)).toBeNull();
    } finally {
      store.close();
    }
  });
});
