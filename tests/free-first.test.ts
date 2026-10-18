import { afterEach, describe, expect, it } from "vitest";
import { accountSchema } from "../src/shared/contracts.js";
import { jobSchema } from "../src/shared/execution.js";
import { newAccount } from "../src/server/auth.js";
import { executionFixture, job, worker } from "./execution-fixtures.js";

const apps: Awaited<ReturnType<typeof executionFixture>>[] = [];
async function make() {
  const app = await executionFixture();
  apps.push(app);
  const member = newAccount(2, "member", "member");
  app.store.put("account", "2", {
    ...member,
    usedMinutes: 2000,
    verifiedAt: Date.now(),
    repositoryVerified: true,
    settings: {
      ...member.settings,
      allowanceConfirmed: true,
      workerRepository: "buildferry-ci",
    },
  });
  app.store.put("worker", "2", {
    ...worker,
    accountId: 2,
    repository: "member/buildferry-ci",
    repositoryId: 302,
  });
  app.store.put("provider", app.providerId, {
    projectId: app.providerId,
    name: "Cloud",
    installations: [{ id: "ub-2", name: "member" }],
    runner: "ubicloud-standard-4",
    priority: 2,
    rateMicros: 1000,
    budgetMicros: 100_000,
    verifiedAt: Date.now(),
  });
  const account = app.store.get("account", "1", accountSchema);
  if (!account) throw new Error("Missing fixture account");
  return { ...app, account };
}
const request = () => {
  const value = job();
  return { ...value, recipe: { ...value.recipe, maxCostMicros: 100_000 } };
};
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.server.close()));
});

describe("free-first paid admission", () => {
  it("uses three consenting owners before leaving overflow queued", async () => {
    const { service, store, account } = await make();
    store.put("account", "1", {
      ...account,
      settings: {
        ...account.settings,
        includedMinutes: 3000,
        contributionMinutes: 3000,
        reserveMinutes: 0,
      },
    });
    const second = store.get("account", "2", accountSchema);
    if (!second) throw new Error("Missing second fixture owner");
    store.put("account", "2", { ...second, usedMinutes: 0 });
    const third = newAccount(3, "third", "member");
    store.put("account", "3", {
      ...third,
      usedMinutes: 0,
      verifiedAt: Date.now(),
      repositoryVerified: true,
      settings: {
        ...third.settings,
        workerRepository: "buildferry-ci",
        allowanceConfirmed: true,
      },
    });
    store.put("worker", "3", {
      ...worker,
      accountId: 3,
      repository: "third/buildferry-ci",
      repositoryId: 303,
    });
    const queued = Array.from({ length: 4 }, request);
    queued.forEach((next) => service.save(next));
    const reserved = queued.map((next) => service.reserve(next.id));
    expect(reserved.map((next) => next?.accountId ?? null)).toEqual([
      1,
      2,
      3,
      null,
    ]);
    expect(reserved.every((next) => !next || next.reservedMicros === 0)).toBe(
      true,
    );
  });
  it("waits for a busy free owner and resumes without paid dispatch", async () => {
    const { service, store } = await make();
    const first = request();
    service.save(first);
    const busy = service.reserve(first.id);
    expect(busy?.accountId).toBe(1);
    if (!busy) throw new Error("Missing reservation");
    const next = request();
    service.save(next);
    expect(service.reserve(next.id)).toBeNull();
    expect(store.get("job", next.id, jobSchema)).toMatchObject({
      state: "queued",
      providerId: null,
      reservedMicros: 0,
      message: expect.stringContaining("Paid runners are on hold"),
    });
    service.save({
      ...busy,
      state: "succeeded",
      actualMinutes: 5,
      cancellationConfirmed: true,
    });
    expect(service.reserve(next.id)).toMatchObject({
      accountId: 1,
      providerId: null,
      reservedMicros: 0,
    });
  });
  it.each([
    "stale",
    "unknown",
    "previous month",
    "unconfirmed",
    "unconfigured",
  ])(
    "does not treat %s free capacity as an authorization to pay",
    async (condition) => {
      const { service, store, account } = await make();
      const pending = { ...account, settings: { ...account.settings } };
      if (condition === "stale") pending.verifiedAt = Date.now() - 16 * 60_000;
      if (condition === "unknown") pending.usedMinutes = null;
      if (condition === "previous month") pending.period = "2020-01";
      if (condition === "unconfirmed")
        pending.settings.allowanceConfirmed = false;
      if (condition === "unconfigured") pending.repositoryVerified = false;
      store.put("account", "1", pending);
      const next = request();
      service.save(next);
      expect(service.reserve(next.id)).toBeNull();
      expect(store.get("job", next.id, jobSchema)?.message).toContain(
        "Paid runners are on hold",
      );
    },
  );
  it("waits when uncertain reservations could release enough free minutes", async () => {
    const { service, store, account } = await make();
    store.put("account", "1", {
      ...account,
      settings: { ...account.settings, includedMinutes: 120, concurrency: 2 },
    });
    service.save(
      job({ accountId: 1, worker, state: "running", reservedMinutes: 11 }),
    );
    const next = request();
    service.save(next);
    expect(service.reserve(next.id)).toBeNull();
    expect(store.get("job", next.id, jobSchema)?.reservedMicros).toBe(0);
  });
  it("permits bounded fallback after verified free allowance exhaustion", async () => {
    const { service, store, account, providerId } = await make();
    store.put("account", "1", { ...account, usedMinutes: 2000 });
    const next = request();
    service.save(next);
    expect(service.reserve(next.id)).toMatchObject({
      providerId,
      reservedMicros: 11_000,
    });
  });
  it.each(["paused", "draining"] as const)(
    "respects an owner's deliberate %s setting",
    async (state) => {
      const { service, store, account, providerId } = await make();
      store.put("account", "1", {
        ...account,
        settings: { ...account.settings, state },
      });
      const next = request();
      service.save(next);
      expect(service.reserve(next.id)?.providerId).toBe(providerId);
    },
  );
  it("retains the explicit paid-only benchmark route", async () => {
    const { service, providerId } = await make();
    const next = { ...request(), route: "ubicloud" as const };
    service.save(next);
    expect(service.reserve(next.id)?.providerId).toBe(providerId);
  });
  it("keeps the paid cost limit after free allowance is exhausted", async () => {
    const { service, store, account } = await make();
    store.put("account", "1", { ...account, usedMinutes: 2000 });
    const next = job();
    service.save(next);
    expect(service.reserve(next.id)).toBeNull();
  });
});
