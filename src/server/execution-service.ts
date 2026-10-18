import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { accountSchema, providerSchema } from "../shared/contracts.js";
import {
  enqueueSchema,
  jobSchema,
  projectInputSchema,
  projectSchema,
  workerSchema,
  type Job,
  type Project,
  type Worker,
} from "../shared/execution.js";
import { Credentials } from "./auth.js";
import { HttpError, type Context } from "./context.js";
import { AppGitHub } from "./providers/app-github.js";
import { ProviderError } from "./providers/http.js";
import { currentPeriod, previewRouting } from "./routing.js";
import {
  activeJob,
  capacityLedger,
  executionCapacity,
} from "./execution-capacity.js";
import { workerFiles, workerWorkflow } from "./worker-template.js";
import { verifyUbicloudWorker } from "./providers/ubicloud.js";

export { activeJob } from "./execution-capacity.js";
export const recipeHash = (recipe: object) =>
  createHash("sha256").update(JSON.stringify(recipe)).digest("hex");

/** Jobs retain immutable recipe and worker snapshots; provider I/O never enters a transaction. */
export class ExecutionService {
  readonly github: AppGitHub;
  readonly credentials: Credentials;
  constructor(readonly context: Context) {
    this.github = new AppGitHub(context);
    this.credentials = new Credentials(context);
  }
  projects(): Project[] {
    return this.context.store.list("project", projectSchema);
  }
  jobs(): Job[] {
    return this.context.store.list("job", jobSchema);
  }
  workers(): Worker[] {
    return this.context.store.list("worker", workerSchema);
  }
  save(job: Job): void {
    this.context.store.put("job", job.id, { ...job, updatedAt: Date.now() });
  }
  async projectToken(project: Project): Promise<string> {
    return this.github.token(project.installationId, project.repositoryId, {
      contents: "read",
      checks: "write",
    });
  }
  async workerToken(worker: Worker): Promise<string> {
    return this.github.token(worker.installationId, worker.repositoryId, {
      contents: "read",
      actions: "write",
    });
  }

  async connectProject(body: unknown, actorId: number): Promise<Project> {
    const input = projectInputSchema.parse(body);
    if (
      this.projects().some(
        (project) =>
          project.repository.toLowerCase() === input.repository.toLowerCase() &&
          project.recipe.name === input.recipe.name,
      )
    )
      throw new HttpError(
        409,
        "This repository already has a workload with this name.",
      );
    const installation = await this.github.installation(input.repository);
    const metadataToken = await this.credentials.token(actorId);
    const repository = await this.github.repository(
      input.repository,
      metadataToken,
    );
    if (this.workers().some((worker) => worker.repositoryId === repository.id))
      throw new HttpError(
        422,
        "Use a source repository separate from the dedicated CI worker.",
      );
    const project: Project = {
      ...input,
      repository: repository.full_name,
      id: randomUUID(),
      repositoryId: repository.id,
      ownerId: repository.owner.id,
      installationId: installation.id,
      defaultBranch: repository.default_branch,
      enabled: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.context.store.put("project", project.id, project);
    this.context.store.audit(
      `${project.repository} was connected with an approved build recipe.`,
    );
    return project;
  }

  async provisionWorker(
    accountId: number,
    allowedProjects: readonly string[],
  ): Promise<Worker> {
    const account = this.context.store.get(
      "account",
      String(accountId),
      accountSchema,
    );
    if (!account?.settings.workerRepository)
      throw new HttpError(
        422,
        "Choose your dedicated private CI repository first.",
      );
    for (const projectId of allowedProjects)
      if (!this.context.store.get("project", projectId, projectSchema))
        throw new HttpError(422, "Select a connected project.");
    const repositoryName = `${account.login}/${account.settings.workerRepository}`;
    const ownerToken = await this.credentials.token(accountId);
    const repository = await this.github.repository(repositoryName, ownerToken);
    if (!repository.private || repository.owner.id !== accountId)
      throw new HttpError(
        422,
        "The worker must be a private repository you own.",
      );
    if (
      this.projects().some((project) => project.repositoryId === repository.id)
    )
      throw new HttpError(
        422,
        "Use a separate CI repository, not a source project.",
      );
    const previous = this.context.store.get(
      "worker",
      String(accountId),
      workerSchema,
    );
    if (previous?.repositoryId === repository.id) {
      // Active jobs retain their approved worker snapshot; this changes future admission only.
      const updated = { ...previous, allowedProjects: [...allowedProjects] };
      this.context.store.put("worker", String(accountId), updated);
      return updated;
    }
    if (
      this.jobs().some((job) => activeJob(job) && job.accountId === accountId)
    )
      throw new HttpError(
        409,
        "Wait for this account's running jobs before changing its worker.",
      );
    const runs = await this.github.request(
      "GET",
      `/repos/${repository.full_name}/actions/runs?per_page=1`,
      ownerToken,
      z.object({ total_count: z.number() }),
    );
    const workflows = await this.github.request(
      "GET",
      `/repos/${repository.full_name}/actions/workflows?per_page=100`,
      ownerToken,
      z.object({ total_count: z.number() }),
    );
    if (runs.total_count !== 0 || workflows.total_count !== 0)
      throw new HttpError(
        422,
        "Use a new private CI repository with no workflows or previous runs. Existing CI repositories will not be modified.",
      );
    const installation = await this.github.installation(repository.full_name);
    const branchSha = await this.github.ref(
      repository.full_name,
      repository.default_branch,
      ownerToken,
    );
    const commit = await this.github.request(
      "GET",
      `/repos/${repository.full_name}/git/commits/${branchSha}`,
      ownerToken,
      z.object({ tree: z.object({ sha: z.string() }) }),
    );
    const tree = await this.github.request(
      "POST",
      `/repos/${repository.full_name}/git/trees`,
      ownerToken,
      z.object({ sha: z.string() }),
      {
        base_tree: commit.tree.sha,
        tree: workerFiles(this.context.config.publicUrl),
      },
    );
    const next = await this.github.request(
      "POST",
      `/repos/${repository.full_name}/git/commits`,
      ownerToken,
      z.object({ sha: z.string() }),
      {
        message: "Install the reviewed BuildFerry worker",
        tree: tree.sha,
        parents: [branchSha],
      },
    );
    await this.github.request(
      "PATCH",
      `/repos/${repository.full_name}/git/refs/heads/${encodeURIComponent(repository.default_branch)}`,
      ownerToken,
      z.object({ ref: z.string() }),
      { sha: next.sha, force: false },
    );
    await this.github.request(
      "POST",
      `/repos/${repository.full_name}/git/refs`,
      ownerToken,
      z.object({ ref: z.string() }),
      { ref: `refs/tags/buildferry-worker-${next.sha}`, sha: next.sha },
    );
    const worker = workerSchema.parse({
      accountId,
      repository: repository.full_name,
      repositoryId: repository.id,
      installationId: installation.id,
      branch: repository.default_branch,
      sha: next.sha,
      ready: true,
      createdAt: Date.now(),
      allowedProjects,
    });
    this.context.store.put("worker", String(accountId), worker);
    this.context.store.audit(
      `${account.login} installed a worker and approved ${allowedProjects.length} project(s).`,
    );
    return worker;
  }

  async enqueue(body: unknown, requestKey?: string): Promise<Job> {
    const input = enqueueSchema.parse(body);
    const existingId = requestKey
      ? this.context.store.get("enqueue", requestKey, z.string())
      : null;
    const existing = existingId
      ? this.context.store.get("job", existingId, jobSchema)
      : null;
    if (existing) return existing;
    const project = this.context.store.get(
      "project",
      input.projectId,
      projectSchema,
    );
    if (!project?.enabled)
      throw new HttpError(422, "This project is not enabled.");
    const token = await this.projectToken(project);
    const sourceSha = await this.github.ref(
      project.repository,
      input.sha ?? project.defaultBranch,
      token,
    );
    const job: Job = {
      id: randomUUID(),
      projectId: project.id,
      sourceSha,
      recipe: project.recipe,
      recipeHash: recipeHash(project.recipe),
      state: "queued",
      priority: input.priority,
      route: input.route,
      ubicloudRunner: input.ubicloudRunner ?? project.recipe.ubicloudRunner,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      deadline: Date.now() + (60 + project.recipe.maxMinutes) * 60_000,
      accountId: null,
      providerId: null,
      runner: null,
      worker: null,
      remoteRunId: null,
      checkId: null,
      checkSubmittedAt: null,
      checkStartedAt: null,
      outcome: null,
      period: currentPeriod(),
      reservedMinutes: 0,
      actualMinutes: null,
      reservedMicros: 0,
      actualMicros: null,
      bootstrapAt: null,
      submittedAt: null,
      preparedAt: null,
      finishedAt: null,
      queueSeconds: null,
      commandSeconds: null,
      message: "Waiting for eligible capacity.",
      url: null,
      cancellationConfirmed: false,
    };
    this.context.store.transaction(() => {
      this.save(job);
      if (requestKey) this.context.store.put("enqueue", requestKey, job.id);
    });
    this.context.store.audit(
      `${project.repository}: ${project.recipe.name} was queued for ${sourceSha.slice(0, 12)}.`,
    );
    return this.context.store.get("job", job.id, jobSchema) ?? job;
  }

  /** Persist the check intent first; a lost response is reconciled by its unique external ID. */
  async ensureCheck(job: Job): Promise<Job> {
    if (job.checkId !== null) return job;
    const project = this.context.store.get(
      "project",
      job.projectId,
      projectSchema,
    );
    if (!project)
      throw new HttpError(409, "The source project is no longer connected.");
    const token = await this.projectToken(project);
    if (job.checkSubmittedAt !== null) {
      const checks = await this.github.request(
        "GET",
        `/repos/${project.repository}/commits/${job.sourceSha}/check-runs?per_page=100&filter=all`,
        token,
        z.object({
          total_count: z.number(),
          check_runs: z.array(
            z.object({
              id: z.number(),
              external_id: z.string().nullable(),
              app: z.object({ id: z.number() }),
            }),
          ),
        }),
      );
      const appId = this.context.store.secret(
        "github-app",
        z.object({ id: z.number() }),
      )?.id;
      const matching = checks.check_runs.filter(
        (check) => check.external_id === job.id && check.app.id === appId,
      );
      if (matching.length !== 1) return job;
      const found = matching[0];
      if (!found) return job;
      const current = this.context.store.get("job", job.id, jobSchema) ?? job;
      const recorded = { ...current, checkId: found.id };
      this.save(recorded);
      return recorded;
    }
    const current = this.context.store.get("job", job.id, jobSchema);
    if (current?.checkSubmittedAt !== null) return current ?? job;
    const submitted = { ...current, checkSubmittedAt: Date.now() };
    this.save(submitted);
    const check = await this.github.request(
      "POST",
      `/repos/${project.repository}/check-runs`,
      token,
      z.object({ id: z.number().int().positive() }),
      {
        name: `BuildFerry / ${job.recipe.name}`,
        head_sha: job.sourceSha,
        status: "queued",
        external_id: job.id,
        output: {
          title: "Waiting for BuildFerry capacity",
          summary:
            "This additional check does not replace any existing project check or release approval.",
        },
      },
    );
    const latest =
      this.context.store.get("job", job.id, jobSchema) ?? submitted;
    const recorded = { ...latest, checkId: check.id };
    this.save(recorded);
    return recorded;
  }

  /** Reserve worst-case time in the same transaction that removes the job from the queue. */
  reserve(id: string): Job | null {
    return this.context.store.transaction(() => {
      const job = this.context.store.get("job", id, jobSchema);
      if (job?.state !== "queued" || job.checkId === null) return null;
      const allJobs = capacityLedger(this.context.store);
      const workers = this.workers();
      const accounts = this.context.store.list("account", accountSchema);
      const providers = this.context.store.list("provider", providerSchema);
      const { candidates, eligible } = executionCapacity(
        job,
        workers,
        accounts,
        providers,
        allJobs,
      );
      const permitted = candidates.filter(
        (candidate) => job.route === "auto" || candidate.kind === job.route,
      );
      const assignment = previewRouting(permitted, {
        jobs: 1,
        maxMinutes: job.recipe.maxMinutes + 1,
        memoryGiB: job.recipe.memoryGiB,
        maxCostMicros: job.recipe.maxCostMicros,
      }).assignments[0];
      if (!assignment?.candidateId || !assignment.runner) {
        if (assignment && assignment.reason !== job.message)
          this.save({ ...job, message: assignment.reason });
        return null;
      }
      const candidate = candidates.find(
        (value) => value.id === assignment.candidateId,
      );
      if (!candidate) throw new Error("The selected capacity disappeared.");
      const provider = providers.find(
        (value) => value.projectId === candidate.id.split(":")[1],
      );
      const worker = eligible.find((value) =>
        candidate.kind === "github"
          ? value.accountId === Number(candidate.id.split(":")[1])
          : provider?.installations.some(
              (installation) =>
                installation.name.toLowerCase() ===
                value.repository.split("/")[0]?.toLowerCase(),
            ),
      );
      if (!worker) return null;
      const reserved: Job = {
        ...job,
        state: "dispatching",
        period: currentPeriod(),
        accountId: worker.accountId,
        worker,
        providerId:
          candidate.kind === "ubicloud"
            ? (candidate.id.split(":")[1] ?? null)
            : null,
        runner: assignment.runner,
        reservedMinutes:
          candidate.kind === "github" ? job.recipe.maxMinutes + 1 : 0,
        reservedMicros: assignment.costMicros,
        message: `Reserved on ${candidate.name}; dispatch is being recorded.`,
      };
      this.save(reserved);
      return reserved;
    });
  }

  async dispatch(job: Job): Promise<void> {
    if (
      !job.worker ||
      !job.runner ||
      job.state !== "dispatching" ||
      job.submittedAt !== null
    )
      return;
    const token = await this.workerToken(job.worker);
    const currentSha = await this.github.ref(
      job.worker.repository,
      `buildferry-worker-${job.worker.sha}`,
      token,
    );
    if (currentSha !== job.worker.sha)
      throw new HttpError(409, "The approved worker revision changed.");
    await this.verifyPaidWorker(job);
    const admitted = this.context.store.transaction(() => {
      const current = this.context.store.get("job", job.id, jobSchema);
      if (current?.state !== "dispatching" || current.submittedAt !== null)
        return false;
      this.save({ ...current, submittedAt: Date.now() });
      return true;
    });
    if (!admitted) return;
    try {
      const result = await this.github.request(
        "POST",
        `/repos/${job.worker.repository}/actions/workflows/${workerWorkflow}/dispatches`,
        token,
        z.object({ workflow_run_id: z.number().int().positive() }),
        {
          ref: `buildferry-worker-${job.worker.sha}`,
          inputs: {
            request_id: job.id,
            runner: job.runner,
            max_minutes: String(job.recipe.maxMinutes),
          },
          return_run_details: true,
        },
      );
      const current = this.context.store.get("job", job.id, jobSchema);
      if (current)
        this.save({
          ...current,
          remoteRunId: result.workflow_run_id,
          url: `https://github.com/${job.worker.repository}/actions/runs/${result.workflow_run_id}`,
          message:
            "Worker accepted. Waiting for independently verified results.",
        });
    } catch (error) {
      if (
        error instanceof ProviderError &&
        [400, 401, 403, 404, 422].includes(error.status)
      ) {
        const current = this.context.store.get("job", job.id, jobSchema);
        if (current)
          this.save({
            ...current,
            actualMinutes: 0,
            actualMicros: 0,
            finishedAt: Date.now(),
            cancellationConfirmed: true,
            message: "GitHub rejected the dispatch. No worker was accepted.",
          });
        throw new HttpError(
          422,
          "GitHub rejected the dispatch. No worker was accepted.",
        );
      }
      // An uncertain POST is never retried or sent to another provider.
      const current = this.context.store.get("job", job.id, jobSchema);
      if (current)
        this.save({
          ...current,
          message:
            "Dispatch acceptance is uncertain. Capacity remains reserved while GitHub is reconciled.",
        });
    }
  }
  private async verifyPaidWorker(job: Job): Promise<void> {
    if (!job.providerId || !job.worker) return;
    const provider = this.context.store.get(
      "provider",
      job.providerId,
      providerSchema,
    );
    const secret = this.context.store.secret(
      `ubicloud:${job.providerId}`,
      z.object({ token: z.string() }),
    );
    if (!provider || !secret)
      throw new HttpError(409, "Reconnect the selected Ubicloud project.");
    await verifyUbicloudWorker(
      provider,
      job.worker.repository,
      secret.token,
      this.context.fetcher,
    );
  }
}
