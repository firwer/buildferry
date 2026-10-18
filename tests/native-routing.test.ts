import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  effectivePolicy,
  nativeRepositorySchema,
} from "../src/shared/native.js";
import { accountSchema } from "../src/shared/contracts.js";
import { newAccount } from "../src/server/auth.js";
import { demandLabel, workflowJobs } from "../src/server/native-inventory.js";
import {
  nativeFixture,
  nativeRepository,
  workflowContent,
  workflowPath,
} from "./native-fixtures.js";
import { job, worker } from "./execution-fixtures.js";
import { projectId } from "./fixtures.js";

const apps: Awaited<ReturnType<typeof nativeFixture>>[] = [];
async function make() {
  const app = await nativeFixture();
  apps.push(app);
  return app;
}
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.server.close()));
  vi.restoreAllMocks();
});
async function requiredLease(app: Awaited<ReturnType<typeof make>>) {
  const lease = await app.enqueue();
  if (!lease) throw new Error("Missing native demand");
  return lease;
}

describe("native workflow policies", () => {
  it("keeps the real automatic smoke test entirely on the router with its dependency gate", () => {
    const file = ".github/workflows/router-probe.yml";
    const jobs = workflowJobs(readFileSync(file, "utf8"), file);
    expect(jobs).toMatchObject([
      { key: "probe", integrated: true, supported: true, maxMinutes: 2 },
      { key: "gate", integrated: true, supported: true, needs: ["probe"] },
    ]);
  });
  it("loads real dependencies and environments without executing command text", () => {
    const jobs = workflowJobs(workflowContent, workflowPath);
    expect(jobs[0]).toMatchObject({
      key: "test",
      integrated: true,
      supported: true,
    });
    expect(jobs[1]).toMatchObject({
      key: "release",
      needs: ["test"],
      environment: "Production",
      integrated: false,
    });
    expect(demandLabel(workflowPath, "test", 1, 1)).not.toBe(
      demandLabel(".github/workflows/reuse.yml", "test", 1, 1),
    );
  });
  it("shows reusable jobs and unsupported machines honestly, and rejects aliased YAML", () => {
    expect(
      workflowJobs(
        "jobs:\n  call:\n    uses: ./.github/workflows/reuse.yml\n  mac:\n    runs-on: macos-latest\n",
        workflowPath,
      ),
    ).toMatchObject([
      { reusable: true, supported: false },
      { supported: false },
    ]);
    expect(() =>
      workflowJobs(
        "jobs:\n  one: &one\n    runs-on: ubuntu-latest\n  two: *one\n",
        workflowPath,
      ),
    ).toThrow();
  });
  it("replaces workflow providers with a job's own provider order while inheriting other defaults", () => {
    const workflow = nativeRepository.workflows[0];
    if (!workflow) throw new Error("Missing fixture workflow");
    const policy = effectivePolicy(
      {
        ...workflow,
        overrides: {
          test: {
            providers: ["ubicloud"],
            ubicloudRunner: "ubicloud-standard-2",
          },
        },
      },
      "test",
    );
    expect(policy).toMatchObject({
      providers: ["ubicloud"],
      ubicloudRunner: "ubicloud-standard-2",
      maxMinutes: 10,
      memoryGiB: 8,
      maxCostMicros: 0,
    });
  });
  it("requires admin authentication and validates override job keys", async () => {
    const app = await make();
    expect((await app.server.inject("/api/native")).statusCode).toBe(401);
    const workflow = nativeRepository.workflows[0];
    if (!workflow) throw new Error("Missing workflow");
    const result = await app.server.inject({
      method: "PUT",
      url: "/api/native/repositories/101/workflows/51",
      headers: app.headers,
      cookies: app.cookies,
      payload: {
        enabled: true,
        policy: workflow.policy,
        overrides: { missing: { providers: ["ubicloud"] } },
      },
    });
    expect(result.statusCode).toBe(422);
  });
});

describe("native runner admission", () => {
  it("admits newly sharded jobs from the trusted run revision without rewriting the default-branch map", async () => {
    const app = await make();
    vi.mocked(app.native.service.inventory.content).mockResolvedValue({
      content: workflowContent
        .replace("    test:", "    quality-shard:")
        .replace("  test:", "  quality-shard:")
        .replaceAll("-test--", "-quality-shard--"),
      sha: app.state.job.head_sha,
    });
    app.state.job.labels = [
      "buildferry",
      `${demandLabel(workflowPath, "quality-shard", 601, 1)}--1`,
    ];
    const lease = await requiredLease(app);
    expect(lease).toMatchObject({
      jobKey: "quality-shard",
      policy: { maxMinutes: 10, maxCostMicros: 0 },
    });
    expect(
      app.native.service
        .repository(101)
        .workflows[0]?.jobs.some((value) => value.key === "quality-shard"),
    ).toBe(false);
    const other = await make();
    other.state.job.labels = [
      "buildferry",
      `${demandLabel(workflowPath, "undeclared", 601, 1)}--0`,
    ];
    expect(await other.enqueue()).toBeNull();
  });
  it("does not count attributed worker usage twice while still enforcing the account's contribution", async () => {
    const app = await make();
    const account = app.store.get("account", "1", accountSchema);
    if (!account) throw new Error("Missing account");
    app.store.put("account", "1", {
      ...account,
      usedMinutes: 900,
      workerUsedMinutes: 900,
      settings: {
        ...account.settings,
        includedMinutes: 1000,
        contributionMinutes: 1000,
        reserveMinutes: 0,
      },
    });
    app.service.save(
      job({
        accountId: 1,
        worker,
        state: "succeeded",
        actualMinutes: 900,
        cancellationConfirmed: true,
      }),
    );
    const lease = await requiredLease(app);
    expect(app.native.service.reserve(lease.id)?.reservedMinutes).toBe(15);
  });
  it("records one demand per original job and reserves free capacity without creating a check", async () => {
    const app = await make();
    const lease = await requiredLease(app);
    expect((await requiredLease(app)).id).toBe(lease.id);
    expect(app.native.service.reserve(lease.id)).toMatchObject({
      runner: "ubuntu-24.04",
      reservedMinutes: 15,
      reservedMicros: 0,
      accountId: 1,
    });
    expect(app.native.service.reserve(lease.id)).toBeNull();
  });
  it("does not dispatch fork-origin, stale attempts, unknown labels or disabled workflow jobs", async () => {
    const app = await make();
    app.state.source.head_repository.id = 999;
    expect(await app.enqueue()).toBeNull();
    app.state.source.head_repository.id = 101;
    app.state.source.run_attempt = 2;
    expect(await app.enqueue()).toBeNull();
    app.state.source.run_attempt = 1;
    app.state.job.labels = ["buildferry", "someone-elses-label"];
    expect(await app.enqueue()).toBeNull();
    expect(app.native.service.leases()).toHaveLength(0);
  });
  it("uses one shared ledger for native and legacy reservations", async () => {
    const app = await make();
    const lease = await requiredLease(app);
    expect(app.native.service.reserve(lease.id)?.accountId).toBe(1);
    const legacy = job();
    app.service.save(legacy);
    expect(app.service.reserve(legacy.id)).toBeNull();
    expect(app.native.service.read(lease.id)?.reservedMinutes).toBe(15);
  });
  it("waits for busy or unverified free accounts instead of spending on Ubicloud", async () => {
    const app = await make();
    const account = app.store.get("account", "1", accountSchema);
    if (!account) throw new Error("Missing account");
    app.store.put("account", "1", {
      ...account,
      verifiedAt: null,
      settings: { ...account.settings, priority: 20 },
    });
    app.store.put("provider", projectId, {
      projectId,
      name: "Cloud",
      runner: "ubicloud-standard-2",
      priority: 2,
      rateMicros: 1000,
      budgetMicros: 1_000_000,
      installations: [{ id: "ub", name: "owner" }],
      verifiedAt: Date.now(),
    });
    const workflow = nativeRepository.workflows[0];
    if (!workflow) throw new Error("Missing workflow");
    app.store.put("native-repository", "101", {
      ...nativeRepository,
      workflows: [
        { ...workflow, policy: { ...workflow.policy, maxCostMicros: 100_000 } },
      ],
    });
    const lease = await requiredLease(app);
    expect(app.native.service.reserve(lease.id)).toBeNull();
    expect(app.native.service.read(lease.id)?.message).toContain(
      "Paid runners are on hold",
    );
  });
  it("honours paid-only job and machine overrides ahead of eligible free accounts", async () => {
    const app = await make();
    app.store.put("provider", projectId, {
      projectId,
      name: "Cloud",
      runner: "ubicloud-standard-4",
      priority: 2,
      rateMicros: 4000,
      budgetMicros: 1_000_000,
      machineRates: [{ runner: "ubicloud-standard-2", rateMicros: 1000 }],
      installations: [{ id: "ub", name: "owner" }],
      verifiedAt: Date.now(),
    });
    const workflow = nativeRepository.workflows[0];
    if (!workflow) throw new Error("Missing workflow");
    app.store.put("native-repository", "101", {
      ...nativeRepository,
      workflows: [
        {
          ...workflow,
          overrides: {
            test: {
              providers: ["ubicloud"],
              ubicloudRunner: "ubicloud-standard-2",
              maxCostMicros: 100_000,
            },
          },
        },
      ],
    });
    const lease = await requiredLease(app);
    expect(app.native.service.reserve(lease.id)).toMatchObject({
      providerId: projectId,
      runner: "ubicloud-standard-2",
      reservedMicros: 30_000,
    });
  });
  it("spreads concurrent native jobs across connected accounts and then waits", async () => {
    const app = await make();
    const member = newAccount(2, "member", "member");
    app.store.put("account", "2", {
      ...member,
      usedMinutes: 0,
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
      nativeSha: worker.sha,
    });
    const lease = await requiredLease(app);
    const first = app.native.service.reserve(lease.id);
    expect(first?.providerId).toBeNull();
    const second = { ...lease, id: crypto.randomUUID(), sourceJobId: 702 };
    app.native.service.save(second);
    const secondReserved = app.native.service.reserve(second.id);
    expect(secondReserved?.accountId).not.toBe(first?.accountId);
    const third = { ...lease, id: crypto.randomUUID(), sourceJobId: 703 };
    app.native.service.save(third);
    expect(app.native.service.reserve(third.id)).toBeNull();
  });
  it("honours account priority inside the workflow's free GitHub tier", async () => {
    const app = await make();
    const owner = accountSchema.parse(
      app.store.get("account", "1", accountSchema),
    );
    app.store.put("account", "1", {
      ...owner,
      settings: { ...owner.settings, priority: 2 },
    });
    app.store.put("account", "2", {
      ...owner,
      id: 2,
      login: "member",
      usedMinutes: 100,
      settings: { ...owner.settings, priority: 1 },
    });
    app.store.put("worker", "2", {
      ...worker,
      accountId: 2,
      repository: "member/buildferry-ci",
      repositoryId: 302,
      nativeSha: worker.sha,
    });
    const lease = await requiredLease(app);
    expect(app.native.service.reserve(lease.id)?.accountId).toBe(2);
  });
});

describe("native host verification and recovery", () => {
  it("delivers JIT once only to the exact pinned host and first attempt", async () => {
    const app = await make();
    const lease = await requiredLease(app);
    const reserved = app.native.service.reserve(lease.id);
    if (!reserved) throw new Error("Missing reservation");
    await app.native.service.dispatch(reserved);
    const request = {
      method: "POST" as const,
      url: "/api/native/claim",
      headers: { authorization: "Bearer signed-identity" },
      payload: { requestId: lease.id, runId: 901 },
    };
    app.verify.mockResolvedValueOnce({ ...app.claims, repository_id: "999" });
    expect((await app.server.inject(request)).statusCode).toBe(403);
    expect((await app.server.inject(request)).json()).toEqual({
      jit: "aGVsbG8=",
    });
    expect((await app.server.inject(request)).statusCode).toBe(409);
    expect(app.state.jitRequests).toBe(1);
  });
  it("reconciles an accepted dispatch after a lost response without launching a duplicate", async () => {
    const app = await make();
    const lease = await requiredLease(app);
    const reserved = app.native.service.reserve(lease.id);
    if (!reserved) throw new Error("Missing reservation");
    app.state.loseDispatch = true;
    await expect(app.native.service.dispatch(reserved)).rejects.toThrow();
    await app.native.controller.tick();
    expect(app.state.dispatches).toBe(1);
    expect(app.native.service.read(lease.id)?.remoteRunId).toBe(901);
  });
  it("retains native failure when the physical hosting workflow succeeds", async () => {
    const app = await make();
    const lease = await requiredLease(app);
    const reserved = app.native.service.reserve(lease.id);
    if (!reserved) throw new Error("Missing reservation");
    await app.native.service.dispatch(reserved);
    app.state.job.status = "completed";
    app.state.job.conclusion = "failure";
    app.state.host.status = "completed";
    app.state.host.conclusion = "success";
    await app.native.controller.tick();
    expect(app.native.service.read(lease.id)).toMatchObject({
      state: "failed",
      sourceConclusion: "failure",
      cancellationConfirmed: true,
      actualMinutes: 1,
      actualMicros: 0,
    });
  });
  it("keeps reservations held when host identity or assignment is wrong", async () => {
    const app = await make();
    const lease = await requiredLease(app);
    const reserved = app.native.service.reserve(lease.id);
    if (!reserved) throw new Error("Missing reservation");
    await app.native.service.dispatch(reserved);
    app.state.host.head_sha = "f".repeat(40);
    await app.native.controller.tick();
    expect(app.native.service.read(lease.id)).toMatchObject({
      cancellationConfirmed: false,
      actualMinutes: null,
    });
  });
  it("does not cancel a newer source attempt when an old queued demand is cancelled", async () => {
    const app = await make();
    const lease = await requiredLease(app);
    app.state.source.run_attempt = 2;
    await app.native.controller.cancel(lease);
    expect(app.state.cancellations).toHaveLength(0);
  });
  it("updates waiting-job policy while leaving admitted snapshots unchanged", async () => {
    const app = await make();
    const lease = await requiredLease(app);
    const workflow = nativeRepository.workflows[0];
    if (!workflow) throw new Error("Missing workflow");
    const result = await app.server.inject({
      method: "PUT",
      url: "/api/native/repositories/101/workflows/51",
      headers: app.headers,
      cookies: app.cookies,
      payload: {
        enabled: true,
        policy: workflow.policy,
        overrides: { test: { providers: ["github"] } },
      },
    });
    expect(result.statusCode).toBe(200);
    expect(app.native.service.read(lease.id)?.policy.providers).toEqual([
      "github",
    ]);
    expect(
      app.store.get("native-repository", "101", nativeRepositorySchema)
        ?.workflows[0]?.overrides.test,
    ).toEqual({ providers: ["github"] });
  });
});
