import { z } from "zod";
import { type NativeLease } from "../shared/native.js";
import { ProviderError } from "./providers/http.js";
import { runSchema } from "./providers/app-github.js";
import { nativeHostJobName, nativeWorkerWorkflow } from "./native-worker.js";
import {
  sourceJobSchema,
  sourceRunSchema,
  type SourceJob,
  type NativeService,
} from "./native-service.js";
import { CapacityRefresh } from "./capacity-refresh.js";
import { hostCost } from "./native-machines.js";

const inactive = (lease: NativeLease) =>
  lease.cancellationConfirmed &&
  ["completed", "cancelled", "failed"].includes(lease.state);
const hostJobsSchema = z.object({
  total_count: z.number(),
  jobs: z.array(
    z.object({
      name: z.string(),
      status: z.string(),
      conclusion: z.string().nullable(),
      run_attempt: z.number(),
      started_at: z.string().nullable(),
      completed_at: z.string().nullable(),
      labels: z.array(z.string()).optional(),
    }),
  ),
});

function terminalState(
  outcome: string | null,
  sourceDone: boolean,
  newerAttempt: boolean,
): NativeLease["state"] {
  if (!sourceDone) return "cancelling";
  if (outcome === "success") return "completed";
  if (outcome === "cancelled" || newerAttempt) return "cancelled";
  return "failed";
}

function verifyAssignment(lease: NativeLease, job: SourceJob): void {
  const assigned = job.runner_id !== null && job.runner_id > 0;
  if (assigned && job.runner_id !== lease.runnerId)
    throw new Error("Source job assigned to a different runner");
  if (job.conclusion === "success" && (!assigned || lease.runnerId === null))
    throw new Error("The source job's runner assignment could not be verified");
}

/** Reconciliation treats original GitHub job results as authoritative, never the host workflow's success. */
export class NativeController {
  private pending: Promise<void> | null = null;
  private stopped = false;
  private pollAt = 0;
  private reconcileCursor = 0;
  private readonly capacity: CapacityRefresh;
  constructor(readonly service: NativeService) {
    this.capacity = new CapacityRefresh(service.execution);
  }
  tick(): Promise<void> {
    if (this.pending !== null || this.stopped)
      return this.pending ?? Promise.resolve();
    this.pending = this.advance().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }
  async stop(): Promise<void> {
    this.stopped = true;
    await this.pending;
  }
  private async guard(lease: NativeLease, task: () => Promise<void>) {
    try {
      await task();
    } catch {
      const current = this.service.read(lease.id);
      if (current && !inactive(current))
        this.service.save({
          ...current,
          message:
            "GitHub or provider verification needs attention. Existing reservations stay held; no duplicate host will start.",
        });
    }
  }
  private async advance(): Promise<void> {
    await this.events();
    if (Date.now() - this.pollAt >= 30_000) {
      this.pollAt = Date.now();
      await this.discover().catch(() => undefined);
    }
    const active = this.service.leases().filter((lease) => !inactive(lease));
    const hosts = active.filter((lease) => lease.state !== "queued");
    const start = this.reconcileCursor % Math.max(1, hosts.length);
    this.reconcileCursor = start + 12;
    await Promise.allSettled(
      [...hosts.slice(start), ...hosts.slice(0, start)]
        .slice(0, 12)
        .map((lease) => this.guard(lease, () => this.reconcile(lease))),
    );
    const queued = active
      .filter((lease) => lease.state === "queued")
      .sort((left, right) => left.createdAt - right.createdAt);
    if (!queued.length) return;
    await this.capacity.run();
    for (const lease of queued.slice(0, 8))
      await this.guard(lease, async () => {
        const source = await this.service.source(lease);
        if (
          source.job.status === "completed" ||
          source.run.run_attempt !== lease.attempt
        ) {
          this.service.save({
            ...lease,
            state: "cancelled",
            sourceConclusion: source.job.conclusion,
            cancellationConfirmed: true,
            actualMinutes: 0,
            actualMicros: 0,
            message: "GitHub no longer needs this queued runner.",
          });
          return;
        }
        if (Date.now() > lease.deadline) {
          await this.cancel(lease);
          return;
        }
        const reserved = this.service.reserve(lease.id);
        if (reserved) await this.service.dispatch(reserved);
      });
  }
  private async events(): Promise<void> {
    const { store } = this.service.context;
    const events = store.entries(
      "native-event",
      z.object({
        event: z.string(),
        body: z.unknown(),
        receivedAt: z.number(),
      }),
    );
    for (const event of events.slice(0, 20)) {
      const payload = z
        .object({
          repository: z.object({ id: z.number() }),
          installation: z.object({ id: z.number() }),
          workflow_job: z.object({ id: z.number() }).optional(),
        })
        .safeParse(event.value.body);
      const repository = payload.success
        ? this.service.inventory
            .repositories()
            .find(
              (value) =>
                value.id === payload.data.repository.id &&
                value.installationId === payload.data.installation.id,
            )
        : null;
      try {
        if (repository && payload.success && payload.data.workflow_job)
          await this.service.receive(
            repository.id,
            payload.data.workflow_job.id,
          );
        store.remove("native-event", event.id);
      } catch {
        if (Date.now() - event.value.receivedAt > 86_400_000)
          store.remove("native-event", event.id);
      }
    }
  }
  /** Polling recovers missed webhook deliveries and works while an existing App's subscriptions are updated. */
  private async discover(): Promise<void> {
    for (const repository of this.service.inventory
      .repositories()
      .filter(
        (value) =>
          !value.error && value.workflows.some((workflow) => workflow.enabled),
      )
      .slice(0, 10)) {
      const token = await this.service.sourceToken(repository);
      try {
        for (const status of ["queued", "in_progress"]) {
          const runs = await this.service.execution.github.request(
            "GET",
            `/repos/${repository.repository}/actions/runs?status=${status}&per_page=30`,
            token,
            z.object({ workflow_runs: z.array(sourceRunSchema) }),
          );
          for (const run of runs.workflow_runs)
            await this.discoverRun(repository, run, token);
        }
      } finally {
        await this.service.execution.github.revoke(token);
      }
    }
  }
  private async discoverRun(
    repository: ReturnType<NativeService["repository"]>,
    run: z.infer<typeof sourceRunSchema>,
    token: string,
  ): Promise<void> {
    for (let page = 1; page <= 50; page++) {
      const report = await this.service.execution.github.request(
        "GET",
        `/repos/${repository.repository}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100&page=${page}`,
        token,
        z.object({
          total_count: z.number(),
          jobs: z.array(sourceJobSchema),
        }),
      );
      for (const job of report.jobs.filter(
        (value) =>
          value.status === "queued" && value.labels.includes("buildferry"),
      ))
        await this.service.receive(repository.id, job.id);
      if (page * 100 >= report.total_count) break;
    }
  }

  async cancel(lease: NativeLease): Promise<NativeLease> {
    const { run } = await this.service.source(lease);
    if (run.run_attempt === lease.attempt && run.status !== "completed") {
      const repository = this.service.repository(lease.repositoryId);
      const token = await this.service.sourceToken(repository, true);
      try {
        await this.service.execution.github.request(
          "POST",
          `/repos/${repository.repository}/actions/runs/${lease.sourceRunId}/cancel`,
          token,
          z.null(),
        );
      } finally {
        await this.service.execution.github.revoke(token);
      }
    }
    const current = this.service.read(lease.id) ?? lease;
    if (current.submittedAt === null) {
      const cancelled = {
        ...current,
        state: "cancelled" as const,
        actualMinutes: 0,
        actualMicros: 0,
        cancellationConfirmed: true,
        message: "The original workflow was cancelled before a host started.",
      };
      this.service.save(cancelled);
      return cancelled;
    }
    const cancelling = {
      ...current,
      state: "cancelling" as const,
      message:
        "GitHub is cancelling the original workflow. Waiting for the host to stop.",
    };
    this.service.save(cancelling);
    return cancelling;
  }

  private async reconcile(lease: NativeLease): Promise<void> {
    const { run: sourceRun, job: sourceJob } = await this.service.source(lease);
    const worker = lease.worker;
    if (!worker?.nativeSha) return;
    if (lease.cancellationConfirmed && lease.remoteRunId === null) {
      if (
        sourceJob.status !== "completed" &&
        sourceRun.run_attempt === lease.attempt
      ) {
        await this.cancelSource(lease);
        return;
      }
      this.service.save({
        ...lease,
        state: "cancelled",
        sourceConclusion: sourceJob.conclusion,
      });
      return;
    }
    const token = await this.service.execution.workerToken(worker);
    try {
      const current = await this.acceptedHost(lease, token);
      if (!current) return;
      const host = await this.service.execution.github.request(
        "GET",
        `/repos/${worker.repository}/actions/runs/${current.remoteRunId}`,
        token,
        runSchema,
      );
      await this.verifyHost(current, host, token);
      verifyAssignment(current, sourceJob);
      const sourceDone =
        sourceJob.status === "completed" ||
        sourceRun.run_attempt !== current.attempt;
      const stop =
        sourceDone ||
        current.state === "cancelling" ||
        Date.now() > current.deadline;
      if (stop && host.status !== "completed") {
        await this.service.execution.github
          .request(
            "POST",
            `/repos/${worker.repository}/actions/runs/${host.id}/cancel`,
            token,
            z.null(),
          )
          .catch((error: Error) => {
            if (!(error instanceof ProviderError && error.status === 409))
              throw error;
          });
        this.service.save({
          ...current,
          sourceConclusion: sourceJob.conclusion,
          state: "cancelling",
          message:
            "The original job ended. Waiting for the physical host to stop.",
        });
        return;
      }
      if (host.status !== "completed") return;
      const minutes = await this.physicalMinutes(current, host, token);
      await this.removeRunner(current);
      const outcome = sourceJob.conclusion;
      this.service.save({
        ...current,
        sourceConclusion: outcome,
        actualMinutes: minutes,
        actualMicros: hostCost(current, minutes),
        cancellationConfirmed: true,
        state: terminalState(
          outcome,
          sourceDone,
          sourceRun.run_attempt !== current.attempt,
        ),
        message: sourceDone
          ? "Original GitHub result verified. Physical host usage recorded."
          : "The host stopped before the original job completed. The workflow is being cancelled; no check was marked successful.",
      });
      if (!sourceDone) await this.cancelSource(current);
    } finally {
      await this.service.execution.github.revoke(token);
    }
  }
  private async acceptedHost(
    lease: NativeLease,
    token: string,
  ): Promise<NativeLease | null> {
    const worker = lease.worker;
    if (!worker?.nativeSha) throw new Error("Missing worker snapshot");
    let current = this.service.read(lease.id) ?? lease;
    if (current.remoteRunId === null) {
      if (current.submittedAt === null) {
        await this.service.dispatch(current);
        return null;
      }
      const runs = await this.service.execution.github.request(
        "GET",
        `/repos/${worker.repository}/actions/workflows/${nativeWorkerWorkflow}/runs?event=workflow_dispatch&per_page=100`,
        token,
        z.object({ workflow_runs: z.array(runSchema) }),
      );
      const matching = runs.workflow_runs.filter(
        (run) =>
          run.display_title === `buildferry-native:${lease.id}` &&
          run.head_sha === worker.nativeSha &&
          run.run_attempt === 1,
      );
      if (matching.length !== 1 || !matching[0]) return null;
      current = {
        ...current,
        remoteRunId: matching[0].id,
        hostUrl: matching[0].html_url,
      };
      this.service.save(current);
    }

    return current;
  }

  private async verifyHost(
    lease: NativeLease,
    host: z.infer<typeof runSchema>,
    token: string,
  ): Promise<void> {
    const worker = lease.worker;
    if (!worker?.nativeSha) throw new Error("Missing worker snapshot");
    const current = lease;
    const validPath = [
      `.github/workflows/${nativeWorkerWorkflow}`,
      `.github/workflows/${nativeWorkerWorkflow}@refs/tags/buildferry-native-${worker.nativeSha}`,
    ].includes(host.path);
    if (
      host.repository.id !== worker.repositoryId ||
      host.id !== current.remoteRunId ||
      host.head_sha !== worker.nativeSha ||
      host.event !== "workflow_dispatch" ||
      host.run_attempt !== 1 ||
      !validPath ||
      host.display_title !== `buildferry-native:${current.id}` ||
      host.actor.id !== (await this.service.execution.github.botId(token))
    )
      throw new Error("Host identity mismatch");
  }

  private async physicalMinutes(
    lease: NativeLease,
    host: z.infer<typeof runSchema>,
    token: string,
  ): Promise<number> {
    const worker = lease.worker;
    if (!worker) throw new Error("Missing worker snapshot");
    const report = await this.service.execution.github.request(
      "GET",
      `/repos/${worker.repository}/actions/runs/${host.id}/attempts/1/jobs?per_page=100`,
      token,
      hostJobsSchema,
    );
    let minutes = 0;
    if (report.jobs.length !== 0) {
      const job = report.jobs[0];
      if (
        report.total_count !== 1 ||
        report.jobs.length !== 1 ||
        job?.name !== nativeHostJobName ||
        job.run_attempt !== 1 ||
        job.status !== "completed" ||
        !job.started_at ||
        !job.completed_at
      )
        throw new Error("Host completion could not be verified");
      const duration =
        Date.parse(job.completed_at) - Date.parse(job.started_at);
      if (!Number.isFinite(duration) || duration < 0)
        throw new Error("Invalid host duration");
      minutes = Math.max(1, Math.ceil(duration / 60_000));
    } else if (host.conclusion !== "cancelled")
      throw new Error("Host job inventory is missing");

    return minutes;
  }

  private async cancelSource(lease: NativeLease): Promise<void> {
    const repository = this.service.repository(lease.repositoryId);
    const token = await this.service.sourceToken(repository, true);
    try {
      const run = await this.service.execution.github.request(
        "GET",
        `/repos/${repository.repository}/actions/runs/${lease.sourceRunId}`,
        token,
        sourceRunSchema,
      );
      if (run.run_attempt === lease.attempt && run.status !== "completed")
        await this.service.execution.github.request(
          "POST",
          `/repos/${repository.repository}/actions/runs/${run.id}/cancel`,
          token,
          z.null(),
        );
    } finally {
      await this.service.execution.github.revoke(token);
    }
  }
  private async removeRunner(lease: NativeLease): Promise<void> {
    if (lease.runnerId === null && lease.jitRequestedAt === null) return;
    const repository = this.service.repository(lease.repositoryId);
    const token = await this.service.execution.github.token(
      repository.installationId,
      repository.id,
      { administration: "write" },
    );
    try {
      const runnerList = z.object({
        total_count: z.number().int().nonnegative(),
        runners: z.array(z.object({ id: z.number(), name: z.string() })),
      });
      for (let page = 1; page <= 100; page++) {
        const runners = await this.service.execution.github.request(
          "GET",
          `/repos/${repository.repository}/actions/runners?per_page=100&page=${page}`,
          token,
          runnerList,
        );
        const matches = runners.runners.filter(
          (runner) => runner.name === `buildferry-${lease.id}`,
        );
        for (const runner of matches) {
          if (lease.runnerId !== null && lease.runnerId !== runner.id)
            throw new Error("Runner identity mismatch");
          await this.service.execution.github.request(
            "DELETE",
            `/repos/${repository.repository}/actions/runners/${runner.id}`,
            token,
            z.null(),
          );
        }
        if (page * 100 >= runners.total_count) return;
      }
      throw new Error("The runner inventory could not be fully verified");
    } finally {
      await this.service.execution.github.revoke(token);
    }
  }
}
