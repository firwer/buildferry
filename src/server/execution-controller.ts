import { z } from "zod";
import { jobSchema, projectSchema, type Job } from "../shared/execution.js";
import { activeJob, type ExecutionService } from "./execution-service.js";
import { HttpError } from "./context.js";
import { runSchema } from "./providers/app-github.js";
import { ProviderError } from "./providers/http.js";
import type { WorkerIdentity } from "./worker-identity.js";
import { workerWorkflow } from "./worker-template.js";
import {
  assertRun,
  EvidenceError,
  jobsReportSchema,
  verifyAudit,
  workerAccounting,
} from "./worker-evidence.js";
import { CapacityRefresh } from "./capacity-refresh.js";
import { currentPeriod } from "./routing.js";

/** Durable intent and finalization make restarts, cancellation and lost responses fail closed. */
export class ExecutionController {
  private pending: Promise<void> | null = null;
  private stopped = false;
  private pollOffset = 0;
  private readonly refresh: CapacityRefresh;
  constructor(
    readonly service: ExecutionService,
    private readonly identity: WorkerIdentity,
  ) {
    this.refresh = new CapacityRefresh(service);
  }
  tick(): Promise<void> {
    if (this.pending || this.stopped) return this.pending ?? Promise.resolve();
    this.pending = this.advance().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }
  async stop(): Promise<void> {
    this.stopped = true;
    await this.pending;
  }
  private async advance(): Promise<void> {
    await this.receivePushes();
    const jobs = this.service.jobs().filter(activeJob);
    const running = jobs.filter((job) => job.state !== "queued");
    const offset = running.length ? this.pollOffset % running.length : 0;
    const batch = [...running.slice(offset), ...running.slice(0, offset)].slice(
      0,
      12,
    );
    this.pollOffset = offset + batch.length;
    await Promise.allSettled(
      batch.map((job) => this.guard(job, () => this.reconcile(job))),
    );
    if (!jobs.some((job) => job.state === "queued")) return;
    await this.refresh.run();
    const unchecked = jobs
      .filter((job) => job.state === "queued" && job.checkId === null)
      .sort((left, right) => left.updatedAt - right.updatedAt)
      .slice(0, 6);
    await Promise.allSettled(
      unchecked.map((job) =>
        this.guard(job, async () => {
          const checked = await this.service.ensureCheck(job);
          if (checked.checkId === null)
            this.service.save({
              ...checked,
              message:
                "Waiting for GitHub to reconcile this run's check. No worker has been dispatched.",
            });
        }),
      ),
    );
    await this.admitQueue();
  }
  private async receivePushes(): Promise<void> {
    const schema = z.object({
      ref: z.string(),
      after: z.string(),
      repository: z.object({ id: z.number() }),
      installation: z.object({ id: z.number() }),
      receivedAt: z.number(),
    });
    for (const { id, value } of this.service.context.store
      .entries("push", schema)
      .slice(0, 6)) {
      const projects = this.service
        .projects()
        .filter(
          (project) =>
            project.enabled &&
            project.onPush &&
            project.repositoryId === value.repository.id &&
            project.installationId === value.installation.id &&
            value.ref === `refs/heads/${project.defaultBranch}`,
        );
      try {
        for (const project of projects)
          await this.service.enqueue(
            { projectId: project.id, sha: value.after },
            `push:${id}:${project.id}`,
          );
        this.service.context.store.remove("push", id);
      } catch {
        /* Keep the durable delivery for a later attempt after connection recovery. */
      }
    }
  }
  private async guard(job: Job, action: () => Promise<void>): Promise<void> {
    try {
      await action();
    } catch (error) {
      const current = this.read(job.id);
      if (!current || !activeJob(current)) return;
      if (error instanceof EvidenceError) {
        await this.finish(current, "failed", error.message);
        return;
      }
      const message =
        error instanceof HttpError || error instanceof ProviderError
          ? error.message
          : "GitHub verification is temporarily unavailable. Capacity remains reserved.";
      this.service.save({ ...current, message });
    }
  }
  private read(id: string) {
    return this.service.context.store.get("job", id, jobSchema);
  }
  private async admitQueue(): Promise<void> {
    const pending: Promise<void>[] = [];
    const queue = this.service
      .jobs()
      .filter((job) => job.state === "queued")
      .sort(
        (left, right) =>
          left.priority - right.priority || left.createdAt - right.createdAt,
      );
    for (const job of queue) {
      if (pending.length >= 6) break;
      if (job.deadline <= Date.now()) {
        pending.push(
          this.guard(job, () =>
            this.finish(
              job,
              "failed",
              "No permitted capacity became available before the deadline.",
            ),
          ),
        );
        continue;
      }
      const reserved = this.service.reserve(job.id);
      if (reserved)
        pending.push(this.guard(reserved, () => this.admitDispatch(reserved)));
    }
    await Promise.allSettled(pending);
  }
  async cancel(snapshot: Job): Promise<Job> {
    const job = this.read(snapshot.id) ?? snapshot;
    if (!activeJob(job)) return job;
    if (job.state === "finalizing")
      throw new HttpError(
        409,
        "This run has already finished. Its result is being published.",
      );
    if (job.submittedAt === null) {
      await this.finish(
        {
          ...job,
          cancellationConfirmed: true,
          actualMinutes: 0,
          actualMicros: 0,
        },
        "cancelled",
        "Cancelled before dispatch.",
      );
      return this.read(job.id) ?? job;
    }
    const changed: Job = {
      ...job,
      state: "cancelling",
      message:
        "Cancellation requested. Capacity stays reserved until GitHub confirms the stop.",
    };
    this.service.save(changed);
    return changed;
  }
  private async locate(job: Job, token: string): Promise<Job> {
    if (job.remoteRunId !== null || !job.worker) return job;
    const created =
      ">=" + new Date((job.submittedAt ?? job.createdAt) - 5000).toISOString();
    const list = await this.service.github.request(
      "GET",
      `/repos/${job.worker.repository}/actions/workflows/${workerWorkflow}/runs?event=workflow_dispatch&created=${encodeURIComponent(created)}&per_page=100`,
      token,
      z.object({ total_count: z.number(), workflow_runs: z.array(runSchema) }),
    );
    if (list.total_count > 100)
      throw new HttpError(
        409,
        "Too many provider runs to reconcile safely. Capacity remains reserved; inspect the worker repository.",
      );
    const matches = list.workflow_runs.filter(
      (run) =>
        run.display_title === `buildferry:${job.id}` &&
        run.head_sha === job.worker?.sha,
    );
    if (matches.length > 1)
      throw new EvidenceError(
        "More than one provider run matches this request. Capacity is held for investigation.",
      );
    const match = matches[0];
    if (!match) {
      if (job.deadline <= Date.now())
        this.service.save({
          ...job,
          state: "cancelling",
          message:
            "Dispatch acceptance could not be established. Capacity stays reserved; inspect the worker repository before retrying.",
        });
      return job;
    }
    const current = this.read(job.id) ?? job;
    const located = { ...current, remoteRunId: match.id, url: match.html_url };
    this.service.save(located);
    return located;
  }
  private async reconcile(snapshot: Job): Promise<void> {
    let job = this.read(snapshot.id);
    if (!job) return;
    if (job.state === "finalizing") {
      await this.publish(job);
      return;
    }
    if (!job.worker) return;
    if (job.submittedAt === null && job.state === "dispatching") {
      await this.admitDispatch(job);
      return;
    }
    const token = await this.service.workerToken(job.worker);
    job = await this.locate(job, token);
    if (job.remoteRunId === null || !job.worker) return;
    const run = await this.service.github.request(
      "GET",
      `/repos/${job.worker.repository}/actions/runs/${job.remoteRunId}`,
      token,
      runSchema,
    );
    await assertRun(this.service, job, run, token);
    if (run.status === "completed") {
      await this.complete(job, run, token);
      return;
    }
    const current = this.read(job.id) ?? job;
    if (current.state === "cancelling" || job.deadline <= Date.now()) {
      try {
        await this.service.github.request(
          "POST",
          `/repos/${job.worker.repository}/actions/runs/${run.id}/cancel`,
          token,
          z.null(),
        );
      } catch (error) {
        if (!(error instanceof ProviderError && error.status === 409))
          throw error;
      }
      this.service.save({
        ...current,
        state: "cancelling",
        message: "Waiting for GitHub to confirm cancellation.",
      });
    }
  }
  private async admitDispatch(job: Job): Promise<void> {
    try {
      await this.service.dispatch(job);
    } catch {
      const current = this.read(job.id);
      if (current)
        await this.finish(
          {
            ...current,
            cancellationConfirmed: true,
            actualMinutes: 0,
            actualMicros: 0,
          },
          "failed",
          "Worker setup or dispatch was rejected. No worker was accepted.",
        );
    }
  }
  private async complete(
    job: Job,
    run: z.infer<typeof runSchema>,
    token: string,
  ): Promise<void> {
    if (!job.worker) return;
    const report = await this.service.github.request(
      "GET",
      `/repos/${job.worker.repository}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`,
      token,
      jobsReportSchema,
    );
    if (
      run.conclusion === "cancelled" &&
      report.total_count === 0 &&
      report.jobs.length === 0
    ) {
      await this.finish(
        {
          ...job,
          actualMinutes: 0,
          actualMicros: 0,
          cancellationConfirmed: true,
        },
        "cancelled",
        "GitHub confirmed cancellation before a worker started.",
      );
      return;
    }
    const { build, accounting } = workerAccounting(job, run, report);
    const completed = { ...(this.read(job.id) ?? job), ...accounting };
    this.service.save(completed);
    if (completed.state === "cancelling") {
      await this.finish(
        completed,
        "cancelled",
        "GitHub confirmed the worker has stopped.",
      );
      return;
    }
    if (run.conclusion !== "success" || build.conclusion !== "success") {
      await this.finish(
        completed,
        "failed",
        "One or more worker steps failed. Open the worker log for details.",
      );
      return;
    }
    await verifyAudit(this.service, completed, build, token);
    await this.finish(
      completed,
      "succeeded",
      "Every approved command passed for the requested revision. Worker evidence was independently verified.",
    );
  }
  async finish(
    snapshot: Job,
    requested: "succeeded" | "failed" | "cancelled",
    message: string,
  ): Promise<void> {
    const job = this.service.context.store.transaction(() => {
      const current = this.read(snapshot.id);
      if (!current || !activeJob(current)) return null;
      if (current.state === "finalizing") return current;
      const outcome = current.state === "cancelling" ? "cancelled" : requested;
      const finalizing: Job = {
        ...current,
        period: currentPeriod(),
        actualMinutes: snapshot.actualMinutes,
        actualMicros: snapshot.actualMicros,
        cancellationConfirmed:
          snapshot.cancellationConfirmed || current.submittedAt === null,
        queueSeconds: snapshot.queueSeconds,
        commandSeconds: snapshot.commandSeconds,
        state: "finalizing",
        outcome,
        message: outcome === "cancelled" ? "The run was cancelled." : message,
      };
      this.service.save(finalizing);
      return finalizing;
    });
    if (job) await this.publish(job);
  }
  private async publish(snapshot: Job): Promise<void> {
    await this.identity.revoke(snapshot.id);
    const job = await this.service.ensureCheck(snapshot);
    if (!job.checkId || !job.outcome) return;
    const project = this.service.context.store.get(
      "project",
      job.projectId,
      projectSchema,
    );
    if (!project)
      throw new HttpError(
        409,
        "Restore the source connection to publish this result.",
      );
    const token = await this.service.projectToken(project);
    const conclusions = {
      succeeded: "success",
      cancelled: "cancelled",
      failed: "failure",
    } as const;
    await this.service.github.request(
      "PATCH",
      `/repos/${project.repository}/check-runs/${job.checkId}`,
      token,
      z.object({ id: z.number() }),
      {
        status: "completed",
        conclusion: conclusions[job.outcome],
        completed_at: new Date().toISOString(),
        output: {
          title: job.message,
          summary: `Source: ${job.sourceSha}\nRecipe: ${job.recipeHash}\nWorker: ${job.url ?? "Not dispatched"}\nExisting project checks and release protections remain in force.`,
        },
      },
    );
    this.service.save({ ...job, state: job.outcome, finishedAt: Date.now() });
  }
}
