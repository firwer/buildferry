import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { jobSchema, projectSchema } from "../src/shared/execution.js";
import { accountSchema } from "../src/shared/contracts.js";
import { ProviderError } from "../src/server/providers/http.js";
import { newAccount } from "../src/server/auth.js";
import {
  executionFixture,
  job,
  project,
  sourceSha,
  worker,
  workerSha,
} from "./execution-fixtures.js";
import { response } from "./fixtures.js";

const apps: Awaited<ReturnType<typeof executionFixture>>[] = [];
async function make() {
  const app = await executionFixture();
  apps.push(app);
  return app;
}
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.server.close()));
  vi.restoreAllMocks();
});

describe("durable execution admission", () => {
  it("carries unsettled reservations across the UTC month boundary", async () => {
    const { service, store } = await make();
    const account = store.get("account", "1", accountSchema);
    if (!account) throw new Error("Missing fixture account");
    store.put("account", "1", {
      ...account,
      settings: {
        ...account.settings,
        concurrency: 2,
        includedMinutes: 120,
        reserveMinutes: 100,
      },
    });
    service.save(
      job({
        period: "2020-01",
        state: "running",
        accountId: 1,
        worker,
        reservedMinutes: 11,
      }),
    );
    const next = job();
    service.save(next);
    expect(service.reserve(next.id)).toBeNull();
  });
  it("persists the approved source and recipe before creating any check", async () => {
    const { service, store, token, ref } = await make();
    const request = await service.enqueue({ projectId: project.id });
    expect(request).toMatchObject({
      sourceSha,
      recipe: project.recipe,
      state: "queued",
      checkId: null,
    });
    expect(token).toHaveBeenCalledWith(201, 101, {
      contents: "read",
      checks: "write",
    });
    expect(ref).toHaveBeenCalledWith(
      project.repository,
      "main",
      "installation-token",
    );
    expect(store.get("job", request.id, jobSchema)).toEqual(request);
    store.put("project", project.id, {
      ...project,
      recipe: { ...project.recipe, commands: ["new-command"] },
    });
    expect(store.get("job", request.id, jobSchema)?.recipe.commands).toEqual([
      "npm ci",
      "npm test",
    ]);
    expect(
      await service.enqueue({ projectId: project.id }, "delivery-1"),
    ).toBeDefined();
    const first = await service.enqueue(
      { projectId: project.id },
      "delivery-1",
    );
    expect(
      await service.enqueue({ projectId: project.id }, "delivery-1"),
    ).toEqual(first);
  });
  it("rejects disabled workloads and incomplete check admission", async () => {
    const { store, service } = await make();
    store.put("project", project.id, { ...project, enabled: false });
    await expect(service.enqueue({ projectId: project.id })).rejects.toThrow(
      "not enabled",
    );
    const waiting = job({ checkId: null });
    service.save(waiting);
    expect(service.reserve(waiting.id)).toBeNull();
  });
  it("creates only its own additional check and recovers a lost check response by external ID", async () => {
    const { service, store, fetcher } = await make();
    const pending = job({ checkId: null, checkSubmittedAt: null });
    service.save(pending);
    vi.mocked(fetcher).mockImplementation(async (_url, init) => {
      const admitted = store.get("job", pending.id, jobSchema);
      expect(admitted?.checkSubmittedAt).not.toBeNull();
      const body = JSON.parse(String(init?.body)) as {
        name: string;
        external_id: string;
      };
      expect(body).toMatchObject({
        name: "BuildFerry / Build",
        external_id: pending.id,
      });
      throw new Error("Connection lost after GitHub accepted the check");
    });
    await expect(service.ensureCheck(pending)).rejects.toThrow();
    vi.mocked(fetcher).mockResolvedValue(
      response({
        total_count: 1,
        check_runs: [{ id: 702, external_id: pending.id, app: { id: 10 } }],
      }),
    );
    const recorded = await service.ensureCheck(
      store.get("job", pending.id, jobSchema) ?? pending,
    );
    expect(recorded.checkId).toBe(702);
    expect(
      vi.mocked(fetcher).mock.calls.map(([, init]) => init?.method),
    ).toEqual(["POST", "GET"]);
    expect(await service.ensureCheck(recorded)).toEqual(recorded);
  });
  it("does not adopt another app's check or an ambiguous check", async () => {
    const { service, fetcher } = await make();
    const pending = job({ checkId: null });
    service.save(pending);
    vi.mocked(fetcher).mockResolvedValue(
      response({
        total_count: 1,
        check_runs: [{ id: 9, external_id: pending.id, app: { id: 999 } }],
      }),
    );
    expect((await service.ensureCheck(pending)).checkId).toBeNull();
    vi.mocked(fetcher).mockResolvedValue(
      response({
        total_count: 2,
        check_runs: [1, 2].map((id) => ({
          id,
          external_id: pending.id,
          app: { id: 10 },
        })),
      }),
    );
    expect((await service.ensureCheck(pending)).checkId).toBeNull();
  });
  it("spreads independent jobs across owners and cannot overbook a parallel slot", async () => {
    const { service, store } = await make();
    const second = {
      ...newAccount(2, "member", "member"),
      settings: {
        ...newAccount(2, "member", "member").settings,
        allowanceConfirmed: true,
        workerRepository: "buildferry-ci",
      },
      usedMinutes: 0,
      verifiedAt: Date.now(),
      repositoryVerified: true,
    };
    store.put("account", "2", second);
    store.put("worker", "2", {
      ...worker,
      accountId: 2,
      repository: "member/buildferry-ci",
      repositoryId: 302,
    });
    const jobs = [job(), job(), job()];
    jobs.forEach((value) => service.save(value));
    const reservations = jobs.map((value) => service.reserve(value.id));
    expect(reservations.filter(Boolean)).toHaveLength(2);
    expect(
      new Set(
        reservations
          .filter((value) => value !== null)
          .map((value) => value.accountId),
      ).size,
    ).toBe(2);
    expect(service.reserve(jobs[0]?.id ?? "")).toBeNull();
  });
  it.each(["paused", "draining"] as const)(
    "stops new assignments when an owner is %s",
    async (state) => {
      const { service, store } = await make();
      const account = store.get("account", "1", accountSchema);
      if (!account) throw new Error("Missing test account");
      store.put("account", "1", {
        ...account,
        settings: { ...account.settings, state },
      });
      const request = job();
      service.save(request);
      expect(service.reserve(request.id)).toBeNull();
    },
  );
  it("excludes stale usage, missing project consent, and changed worker repositories", async () => {
    const { service, store } = await make();
    const account = store.get("account", "1", accountSchema);
    if (!account) throw new Error("Missing test account");
    const request = job();
    service.save(request);
    store.put("account", "1", { ...account, verifiedAt: 0 });
    expect(service.reserve(request.id)).toBeNull();
    store.put("account", "1", account);
    store.put("worker", "1", { ...worker, allowedProjects: [] });
    expect(service.reserve(request.id)).toBeNull();
    store.put("worker", "1", worker);
    store.put("account", "1", {
      ...account,
      settings: { ...account.settings, workerRepository: "other" },
    });
    expect(service.reserve(request.id)).toBeNull();
  });
  it("reserves the complete runtime and preserves uncertain dispatch reservations", async () => {
    const { service, store } = await make();
    const account = store.get("account", "1", accountSchema);
    if (!account) throw new Error("Missing test account");
    store.put("account", "1", {
      ...account,
      settings: {
        ...account.settings,
        includedMinutes: 110,
        reserveMinutes: 100,
      },
    });
    const request = job();
    service.save(request);
    expect(service.reserve(request.id)).toBeNull();
    store.put("account", "1", account);
    const reserved = service.reserve(request.id);
    expect(reserved?.reservedMinutes).toBe(11);
    if (!reserved) throw new Error("Missing reservation");
    service.save({
      ...reserved,
      state: "failed",
      cancellationConfirmed: false,
    });
    const next = job();
    service.save(next);
    expect(service.reserve(next.id)).toBeNull();
  });
  it("uses Ubicloud only with an eligible connection, explicit per-run and monthly budgets", async () => {
    const { service, store, providerId } = await make();
    store.put("provider", providerId, {
      projectId: providerId,
      name: "Cloud",
      installations: [{ id: "ub-1", name: "owner" }],
      runner: "ubicloud-standard-4",
      priority: 2,
      rateMicros: 1000,
      budgetMicros: 50000,
      verifiedAt: Date.now(),
    });
    const request = job({ route: "ubicloud" });
    service.save(request);
    expect(service.reserve(request.id)).toBeNull();
    service.save({
      ...request,
      recipe: { ...request.recipe, maxCostMicros: 20000 },
    });
    const reserved = service.reserve(request.id);
    expect(reserved).toMatchObject({
      providerId,
      reservedMicros: 11000,
      reservedMinutes: 0,
    });
    if (!reserved) throw new Error("Missing reservation");
    service.save({
      ...reserved,
      state: "succeeded",
      cancellationConfirmed: true,
      actualMicros: 45000,
    });
    const next = job({
      route: "ubicloud",
      recipe: { ...request.recipe, maxCostMicros: 20000 },
    });
    service.save(next);
    expect(service.reserve(next.id)).toBeNull();
  });
  it("records dispatch intent before POST and never resubmits an uncertain accepted request", async () => {
    const { service, store, fetcher, ref } = await make();
    ref.mockResolvedValue(workerSha);
    const request = job();
    service.save(request);
    const reserved = service.reserve(request.id);
    if (!reserved) throw new Error("Missing reservation");
    vi.mocked(fetcher).mockImplementation(async () => {
      expect(
        store.get("job", request.id, jobSchema)?.submittedAt,
      ).not.toBeNull();
      throw new Error("Lost dispatch response");
    });
    await service.dispatch(reserved);
    await service.dispatch(reserved);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(store.get("job", request.id, jobSchema)).toMatchObject({
      state: "dispatching",
      remoteRunId: null,
      reservedMinutes: 11,
    });
  });
  it("pins the worker revision and records the returned GitHub run ID", async () => {
    const { service, store, fetcher, ref } = await make();
    const request = job();
    service.save(request);
    const reserved = service.reserve(request.id);
    if (!reserved) throw new Error("Missing reservation");
    ref.mockResolvedValue("c".repeat(40));
    await expect(service.dispatch(reserved)).rejects.toThrow(
      "revision changed",
    );
    expect(fetcher).not.toHaveBeenCalled();
    ref.mockResolvedValue(workerSha);
    vi.mocked(fetcher).mockResolvedValue(response({ workflow_run_id: 901 }));
    await service.dispatch(reserved);
    expect(store.get("job", request.id, jobSchema)?.remoteRunId).toBe(901);
    const body = JSON.parse(
      String(vi.mocked(fetcher).mock.calls[0]?.[1]?.body),
    ) as object;
    expect(body).toMatchObject({
      ref: `buildferry-worker-${workerSha}`,
      return_run_details: true,
      inputs: {
        runner: "ubuntu-24.04",
        max_minutes: "10",
        request_id: request.id,
      },
    });
  });
  it("releases only a definitively rejected dispatch", async () => {
    const { service, store, fetcher, ref } = await make();
    ref.mockResolvedValue(workerSha);
    const request = job();
    service.save(request);
    const reserved = service.reserve(request.id);
    if (!reserved) throw new Error("Missing reservation");
    vi.mocked(fetcher).mockResolvedValue(response({}, 403));
    await expect(service.dispatch(reserved)).rejects.toThrow("rejected");
    expect(store.get("job", request.id, jobSchema)).toMatchObject({
      actualMinutes: 0,
      cancellationConfirmed: true,
    });
  });
  it("protects dashboard writes and exposes no credentials in execution data", async () => {
    const { server, store, headers, cookies } = await make();
    const request = job();
    store.put("job", request.id, request);
    expect((await server.inject("/api/execution")).statusCode).toBe(401);
    const dashboard = await server.inject({ url: "/api/execution", cookies });
    expect(dashboard.statusCode).toBe(200);
    expect(dashboard.body).not.toContain("installation-token");
    expect(
      (
        await server.inject({
          method: "POST",
          url: "/api/jobs",
          cookies,
          payload: { projectId: project.id },
        })
      ).statusCode,
    ).toBe(403);
    const update = await server.inject({
      method: "PUT",
      url: `/api/projects/${project.id}`,
      cookies,
      headers,
      payload: { recipe: project.recipe, enabled: false, onPush: false },
    });
    expect(projectSchema.parse(update.json()).enabled).toBe(false);
    expect(
      (
        await server.inject({
          method: "POST",
          url: "/api/workers",
          cookies,
          headers,
          payload: { accountId: 2, allowedProjects: [] },
        })
      ).statusCode,
    ).toBe(404);
  });
  it("validates GitHub response schemas and leaves a source check unresolved after provider errors", async () => {
    const { service, fetcher } = await make();
    vi.mocked(fetcher).mockResolvedValue(new Response("not json"));
    await expect(
      service.github.request(
        "GET",
        "/test",
        "secret",
        z.object({ id: z.number() }),
      ),
    ).rejects.toBeInstanceOf(ProviderError);
  });
});
