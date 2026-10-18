import { createHmac, randomUUID } from "node:crypto";
import { strToU8, zipSync } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jobSchema } from "../src/shared/execution.js";
import { accountSchema } from "../src/shared/contracts.js";
import { ExecutionController } from "../src/server/execution-controller.js";
import { WorkerIdentity } from "../src/server/worker-identity.js";
import { workerSteps } from "../src/server/worker-template.js";
import {
  executionFixture,
  job,
  project,
  worker,
  sourceSha,
} from "./execution-fixtures.js";
import { response, sampleApp } from "./fixtures.js";

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

function evidence(request: ReturnType<typeof job>) {
  const start = Date.now() - 100_000;
  const iso = (offset: number) => new Date(start + offset).toISOString();
  const run = {
    id: 901,
    run_attempt: 1,
    head_sha: worker.sha,
    event: "workflow_dispatch",
    path: ".github/workflows/buildferry-worker.yml",
    display_title: `buildferry:${request.id}`,
    status: "completed",
    conclusion: "success",
    created_at: iso(-20_000),
    html_url: "https://github.com/owner/buildferry-ci/actions/runs/901",
    actor: { id: 601, login: "buildferry-test[bot]" },
    repository: { id: worker.repositoryId },
  };
  const build = {
    name: "BuildFerry worker",
    status: "completed",
    conclusion: "success",
    run_attempt: 1,
    started_at: iso(0),
    completed_at: iso(60_000),
    steps: workerSteps.map((name, index) => ({
      name,
      conclusion: "success",
      started_at: iso(index * 2000),
      completed_at: iso((index + 1) * 2000),
    })),
  };
  const artifacts = {
    total_count: 1,
    artifacts: [
      {
        id: 1001,
        name: "buildferry-audit-1",
        expired: false,
        size_in_bytes: 400,
        created_at: iso(3000),
      },
    ],
  };
  const audit = {
    version: 1,
    requestId: request.id,
    sourceRepositoryId: project.repositoryId,
    sourceSha: request.sourceSha,
    recipeHash: request.recipeHash,
    workerRepositoryId: worker.repositoryId,
    workerSha: worker.sha,
    runId: 901,
    attempt: 1,
  };
  return { run, build, artifacts, audit };
}
type Proof = ReturnType<typeof evidence>;
function provider(
  app: Awaited<ReturnType<typeof make>>,
  request: ReturnType<typeof job>,
  proof: Proof,
) {
  const checks: { conclusion: string }[] = [];
  vi.mocked(app.fetcher).mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.endsWith("/jobs?filter=latest&per_page=100"))
      return response({ total_count: 1, jobs: [proof.build] });
    if (url.endsWith("/artifacts?per_page=100"))
      return response(proof.artifacts);
    if (url.endsWith("/artifacts/1001/zip"))
      return new Response(null, {
        status: 302,
        headers: {
          location:
            "https://test.blob.core.windows.net/audit.zip?signature=test",
        },
      });
    if (url.includes(".blob.core.windows.net")) {
      expect(init?.headers).toBeUndefined();
      return new Response(
        zipSync({
          "buildferry-audit.json": strToU8(JSON.stringify(proof.audit)),
        }),
      );
    }
    if (url.endsWith("/cancel")) return new Response(null, { status: 202 });
    if (url.includes("/check-runs/") && init?.method === "PATCH") {
      checks.push(JSON.parse(String(init.body)) as { conclusion: string });
      return response({ id: request.checkId ?? 501 });
    }
    if (url.endsWith("/actions/runs/901")) return response(proof.run);
    if (url.includes("/workflows/buildferry-worker.yml/runs?"))
      return response({ total_count: 1, workflow_runs: [proof.run] });
    throw new Error(`Unexpected fixture endpoint: ${url}`);
  });
  return checks;
}
function running(overrides: Partial<ReturnType<typeof job>> = {}) {
  return job({
    state: "running",
    worker,
    accountId: 1,
    remoteRunId: 901,
    submittedAt: Date.now() - 120_000,
    preparedAt: Date.now() - 110_000,
    bootstrapAt: Date.now() - 111_000,
    reservedMinutes: 11,
    ...overrides,
  });
}

describe("independent provider result verification", () => {
  it("admits a fitting workload behind jobs that cannot use current capacity", async () => {
    const app = await make();
    const blocked = Array.from({ length: 6 }, (_, index) =>
      job({
        createdAt: Date.now() - 100 + index,
        recipe: { ...project.recipe, memoryGiB: 64 },
      }),
    );
    blocked.forEach((value) => app.service.save(value));
    const fitting = job();
    app.service.save(fitting);
    app.ref.mockResolvedValue(worker.sha);
    vi.mocked(app.fetcher).mockImplementation(async () =>
      response({ workflow_run_id: 901 }),
    );
    await app.execution.controller.tick();
    expect(app.store.get("job", fitting.id, jobSchema)?.state).toBe(
      "dispatching",
    );
    expect(
      blocked.every(
        (value) =>
          app.store.get("job", value.id, jobSchema)?.state === "queued",
      ),
    ).toBe(true);
  });
  it("polls every active run fairly when more than one polling batch is active", async () => {
    const app = await make();
    const requests = Array.from({ length: 14 }, (_, index) =>
      running({ remoteRunId: 900 + index }),
    );
    requests.forEach((value) => app.service.save(value));
    const observed = new Set<number>();
    vi.mocked(app.fetcher).mockImplementation(async (input) => {
      const id = Number(new URL(String(input)).pathname.split("/").at(-1));
      const request = requests.find((value) => value.remoteRunId === id);
      if (!request) throw new Error("Unexpected fixture endpoint");
      observed.add(id);
      return response({ ...evidence(request).run, id, status: "in_progress" });
    });
    await app.execution.controller.tick();
    expect(observed.size).toBe(12);
    await app.execution.controller.tick();
    expect(observed.size).toBe(14);
  });
  it("releases a provider-confirmed cancellation that never acquired a runner", async () => {
    const app = await make();
    const request = running({ state: "cancelling", preparedAt: null });
    app.service.save(request);
    const proof = evidence(request);
    proof.run.conclusion = "cancelled";
    const checks = provider(app, request, proof);
    const original = vi.mocked(app.fetcher).getMockImplementation();
    if (!original) throw new Error("Missing fixture provider");
    vi.mocked(app.fetcher).mockImplementation(async (input, init) =>
      String(input).includes("/jobs?")
        ? response({ total_count: 0, jobs: [] })
        : original(input, init),
    );
    await app.execution.controller.tick();
    expect(checks[0]?.conclusion).toBe("cancelled");
    expect(app.store.get("job", request.id, jobSchema)).toMatchObject({
      state: "cancelled",
      actualMinutes: 0,
      cancellationConfirmed: true,
    });
  });
  it("publishes success only after provider steps and immutable audit match", async () => {
    const app = await make();
    const request = running();
    app.service.save(request);
    const checks = provider(app, request, evidence(request));
    await app.execution.controller.tick();
    expect(app.store.get("job", request.id, jobSchema)).toMatchObject({
      state: "succeeded",
      actualMinutes: 1,
      cancellationConfirmed: true,
      queueSeconds: 20,
      commandSeconds: 2,
    });
    expect(checks.map((check) => check.conclusion)).toEqual(["success"]);
  });
  it.each([
    "sourceSha",
    "recipeHash",
    "workerSha",
    "requestId",
    "runId",
  ] as const)("fails a mismatched immutable %s", async (field) => {
    const app = await make();
    const request = running();
    app.service.save(request);
    const proof = evidence(request);
    if (field === "runId") proof.audit.runId = 902;
    else
      proof.audit[field] =
        field === "requestId"
          ? randomUUID()
          : "c".repeat(field === "recipeHash" ? 64 : 40);
    const checks = provider(app, request, proof);
    await app.execution.controller.tick();
    expect(app.store.get("job", request.id, jobSchema)).toMatchObject({
      state: "failed",
      cancellationConfirmed: true,
    });
    expect(checks.map((check) => check.conclusion)).toEqual(["failure"]);
  });
  it.each([
    "expired",
    "missing",
    "late",
    "oversized",
    "step-failed",
    "unrevoked",
  ])("blocks %s audit evidence", async (mode) => {
    const app = await make();
    const request = running(mode === "unrevoked" ? { preparedAt: null } : {});
    app.service.save(request);
    const proof = evidence(request);
    const artifact = proof.artifacts.artifacts[0];
    if (!artifact) throw new Error("Missing fixture artifact");
    if (mode === "expired") artifact.expired = true;
    if (mode === "missing") proof.artifacts.artifacts = [];
    if (mode === "late") artifact.created_at = new Date().toISOString();
    if (mode === "oversized") artifact.size_in_bytes = 40_000;
    if (mode === "step-failed" && proof.build.steps[1])
      proof.build.steps[1].conclusion = "failure";
    const checks = provider(app, request, proof);
    await app.execution.controller.tick();
    expect(app.store.get("job", request.id, jobSchema)?.state).toBe("failed");
    expect(checks[0]?.conclusion).toBe("failure");
  });
  it.each(["actor", "attempt", "worker-sha", "repository"])(
    "rejects an untrusted run %s without releasing its uncertain capacity",
    async (field) => {
      const app = await make();
      const request = running();
      app.service.save(request);
      const proof = evidence(request);
      if (field === "actor") proof.run.actor.id = 999;
      if (field === "attempt") proof.run.run_attempt = 2;
      if (field === "worker-sha") proof.run.head_sha = "c".repeat(40);
      if (field === "repository") proof.run.repository.id = 999;
      provider(app, request, proof);
      await app.execution.controller.tick();
      expect(app.store.get("job", request.id, jobSchema)).toMatchObject({
        state: "failed",
        cancellationConfirmed: false,
      });
    },
  );
  it("cancellation racing with verified success never publishes success", async () => {
    const app = await make();
    const request = running();
    app.service.save(request);
    const checks = provider(app, request, evidence(request));
    const fetcher = vi.mocked(app.fetcher);
    const original = fetcher.getMockImplementation();
    if (!original) throw new Error("Missing fixture provider");
    fetcher.mockImplementation(async (input, init) => {
      if (String(input).includes(".blob.core.windows.net"))
        await app.execution.controller.cancel(request);
      return original(input, init);
    });
    await app.execution.controller.tick();
    expect(checks.map((check) => check.conclusion)).toEqual(["cancelled"]);
    expect(app.store.get("job", request.id, jobSchema)?.state).toBe(
      "cancelled",
    );
  });
  it("recovers finalization after a service restart and rejects late cancellation", async () => {
    const app = await make();
    const request = running();
    app.service.save(request);
    const checks = provider(app, request, evidence(request));
    const fetcher = vi.mocked(app.fetcher);
    const original = fetcher.getMockImplementation();
    if (!original) throw new Error("Missing fixture provider");
    fetcher.mockImplementation(async (input, init) =>
      String(input).includes("/check-runs/")
        ? response({}, 503)
        : original(input, init),
    );
    await app.execution.controller.tick();
    const finalizing = app.store.get("job", request.id, jobSchema);
    expect(finalizing?.state).toBe("finalizing");
    if (!finalizing) throw new Error("Missing persisted result");
    await expect(app.execution.controller.cancel(finalizing)).rejects.toThrow(
      "already finished",
    );
    fetcher.mockImplementation(original);
    const recovered = new ExecutionController(
      app.service,
      new WorkerIdentity(app.service, app.verify),
    );
    await recovered.tick();
    await recovered.stop();
    expect(checks[0]?.conclusion).toBe("success");
    expect(app.store.get("job", request.id, jobSchema)?.state).toBe(
      "succeeded",
    );
  });
  it("records failed commands without sending the job to another provider", async () => {
    const app = await make();
    const request = running();
    app.service.save(request);
    const proof = evidence(request);
    proof.run.conclusion = "failure";
    proof.build.conclusion = "failure";
    const checks = provider(app, request, proof);
    await app.execution.controller.tick();
    expect(checks[0]?.conclusion).toBe("failure");
    expect(app.service.jobs()).toHaveLength(1);
  });
  it("cancels the accepted run and holds reservations until it actually stops", async () => {
    const app = await make();
    const request = running();
    app.service.save(request);
    const proof = evidence(request);
    proof.run.status = "in_progress";
    provider(app, request, proof);
    await app.execution.controller.cancel(request);
    await app.execution.controller.tick();
    expect(app.store.get("job", request.id, jobSchema)).toMatchObject({
      state: "cancelling",
      cancellationConfirmed: false,
    });
    proof.run.status = "completed";
    await app.execution.controller.tick();
    expect(app.store.get("job", request.id, jobSchema)).toMatchObject({
      state: "cancelled",
      cancellationConfirmed: true,
    });
  });
  it("reconciles a lost dispatch response by unique run identity without another POST", async () => {
    const app = await make();
    const request = running({ remoteRunId: null, state: "dispatching" });
    app.service.save(request);
    provider(app, request, evidence(request));
    await app.execution.controller.tick();
    expect(app.store.get("job", request.id, jobSchema)?.state).toBe(
      "succeeded",
    );
    expect(
      vi
        .mocked(app.fetcher)
        .mock.calls.some(
          ([input, init]) =>
            String(input).endsWith("/dispatches") && init?.method === "POST",
        ),
    ).toBe(false);
  });
  it("keeps unknown dispatches reserved after their deadline and exposes a recovery message", async () => {
    const app = await make();
    const request = running({
      state: "dispatching",
      remoteRunId: null,
      deadline: Date.now() - 1,
    });
    app.service.save(request);
    vi.mocked(app.fetcher).mockResolvedValue(
      response({ total_count: 0, workflow_runs: [] }),
    );
    await app.execution.controller.tick();
    expect(app.store.get("job", request.id, jobSchema)).toMatchObject({
      state: "cancelling",
      cancellationConfirmed: false,
    });
  });
  it("processes a signed default-branch push once, survives redelivery and ignores other branches", async () => {
    const app = await make();
    app.store.put("project", project.id, { ...project, onPush: true });
    const account = app.store.get("account", "1", accountSchema);
    if (!account) throw new Error("Missing fixture account");
    app.store.put("account", "1", {
      ...account,
      settings: { ...account.settings, state: "paused" },
    });
    vi.mocked(app.fetcher).mockResolvedValue(response({ id: 501 }));
    const delivery = randomUUID();
    const body = JSON.stringify({
      ref: "refs/heads/main",
      after: sourceSha,
      deleted: false,
      repository: { id: project.repositoryId },
      installation: { id: project.installationId },
    });
    const send = () =>
      app.server.inject({
        method: "POST",
        url: "/api/github/webhook",
        headers: {
          "content-type": "application/json",
          "x-github-event": "push",
          "x-github-delivery": delivery,
          "x-hub-signature-256": `sha256=${createHmac("sha256", sampleApp.webhook_secret).update(body).digest("hex")}`,
        },
        payload: body,
      });
    expect((await send()).statusCode).toBe(202);
    await app.execution.controller.tick();
    expect(app.service.jobs()).toHaveLength(1);
    expect((await send()).json()).toMatchObject({ duplicate: true });
    await app.execution.controller.tick();
    expect(app.service.jobs()).toHaveLength(1);
  });
});
