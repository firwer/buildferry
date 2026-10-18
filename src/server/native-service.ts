import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { FastifyRequest } from "fastify";
import { accountSchema, providerSchema } from "../shared/contracts.js";
import {
  effectivePolicy,
  nativeLeaseSchema,
  nativeRepositorySchema,
  type NativeLease,
  type NativeRepository,
} from "../shared/native.js";
import {
  NativeInventory,
  demandLabel,
  workflowJobs,
} from "./native-inventory.js";
import type { ExecutionService } from "./execution-service.js";
import { capacityLedger, executionCapacity } from "./execution-capacity.js";
import { HttpError, type Context } from "./context.js";
import { currentPeriod, previewRouting } from "./routing.js";
import { runSchema } from "./providers/app-github.js";
import { ProviderError } from "./providers/http.js";
import { verifyUbicloudWorker } from "./providers/ubicloud.js";
import { type VerifyWorkerIdentity } from "./worker-identity.js";
import { nativeWorkerWorkflow } from "./native-worker.js";
import { cpuFamily, machineChoice, nativeMachine } from "./native-machines.js";

export const sourceJobSchema = z.object({
  id: z.number().int().positive(),
  run_id: z.number().int().positive(),
  run_attempt: z.number().int().positive(),
  head_sha: z.string(),
  name: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
  labels: z.array(z.string().min(1).max(255)).max(100),
  runner_id: z.number().int().nonnegative().nullable(),
  html_url: z
    .url()
    .refine((url) => new URL(url).origin === "https://github.com"),
});
export const sourceRunSchema = runSchema.extend({
  workflow_id: z.number().int().positive(),
  head_repository: z.object({ id: z.number().int().positive() }).nullable(),
});
export type SourceJob = z.infer<typeof sourceJobSchema>;
export const nativeHostMinutes = (lease: NativeLease) =>
  lease.policy.maxMinutes + 5;

/** Native source jobs own their checks; this service manages only single-use physical hosts. */
export class NativeService {
  readonly inventory: NativeInventory;
  constructor(
    readonly execution: ExecutionService,
    readonly verify: VerifyWorkerIdentity,
  ) {
    this.inventory = new NativeInventory(execution.context);
  }
  get context(): Context {
    return this.execution.context;
  }
  leases(): NativeLease[] {
    return this.context.store.list("native-lease", nativeLeaseSchema);
  }
  read(id: string): NativeLease | null {
    return this.context.store.get("native-lease", id, nativeLeaseSchema);
  }
  save(lease: NativeLease): void {
    this.context.store.put("native-lease", lease.id, {
      ...lease,
      updatedAt: Date.now(),
    });
  }
  repository(id: number): NativeRepository {
    const repository = this.context.store.get(
      "native-repository",
      String(id),
      nativeRepositorySchema,
    );
    if (!repository)
      throw new HttpError(404, "This repository is not connected.");
    return repository;
  }
  async sourceToken(
    repository: NativeRepository,
    write = false,
  ): Promise<string> {
    return this.execution.github.token(
      repository.installationId,
      repository.id,
      { contents: "read", actions: write ? "write" : "read" },
    );
  }
  async source(lease: NativeLease) {
    const repository = this.repository(lease.repositoryId);
    const token = await this.sourceToken(repository);
    try {
      const run = await this.execution.github.request(
        "GET",
        `/repos/${repository.repository}/actions/runs/${lease.sourceRunId}`,
        token,
        sourceRunSchema,
      );
      const job = await this.execution.github.request(
        "GET",
        `/repos/${repository.repository}/actions/jobs/${lease.sourceJobId}`,
        token,
        sourceJobSchema,
      );
      if (
        run.repository.id !== repository.id ||
        run.id !== lease.sourceRunId ||
        job.id !== lease.sourceJobId ||
        job.run_id !== run.id ||
        job.run_attempt !== lease.attempt ||
        job.head_sha !== lease.sourceSha
      )
        throw new HttpError(409, "The original GitHub job identity changed.");
      return { run, job };
    } finally {
      await this.execution.github.revoke(token);
    }
  }

  /** Re-fetch signed delivery identifiers from GitHub, then bind a demand to its unique source labels. */
  async receive(
    repositoryId: number,
    jobId: number,
  ): Promise<NativeLease | null> {
    const existing = this.leases().find(
      (lease) =>
        lease.repositoryId === repositoryId && lease.sourceJobId === jobId,
    );
    if (existing) return existing;
    const repository = this.repository(repositoryId);
    if (repository.error || repository.refreshedAt === 0) return null;
    const token = await this.sourceToken(repository);
    try {
      const job = await this.execution.github.request(
        "GET",
        `/repos/${repository.repository}/actions/jobs/${jobId}`,
        token,
        sourceJobSchema,
      );
      if (job.status !== "queued" || !job.labels.includes("buildferry"))
        return null;
      const run = await this.execution.github.request(
        "GET",
        `/repos/${repository.repository}/actions/runs/${job.run_id}`,
        token,
        sourceRunSchema,
      );
      if (
        run.repository.id !== repository.id ||
        run.head_repository?.id !== repository.id ||
        run.run_attempt !== job.run_attempt ||
        ![
          "push",
          "pull_request",
          "workflow_dispatch",
          "merge_group",
          "schedule",
        ].includes(run.event)
      )
        return null;
      const matches = repository.workflows
        .flatMap((workflow) =>
          workflow.enabled && !workflow.error
            ? workflow.jobs
                .filter((candidate) => candidate.supported)
                .map((candidate) => ({ workflow, candidate }))
            : [],
        )
        .filter(({ workflow, candidate }) => {
          const prefix = demandLabel(
            workflow.path,
            candidate.key,
            run.id,
            run.run_attempt,
          );
          return job.labels.some(
            (label) =>
              label === prefix ||
              (label.startsWith(`${prefix}--`) &&
                /^\d+$/.test(label.slice(prefix.length + 2))),
          );
        });
      if (matches.length !== 1) return null;
      const match = matches[0];
      if (!match) return null;
      // Validate the actual run's file, including PR revisions, without translating any command steps.
      const file = await this.inventory.content(
        repository,
        match.workflow.path,
        job.head_sha,
        token,
      );
      const declared = workflowJobs(file.content, match.workflow.path).find(
        (candidate) => candidate.key === match.candidate.key,
      );
      if (
        !declared?.supported ||
        !declared.integrated ||
        (declared.matrix && !job.labels.some((label) => /--\d+$/.test(label)))
      )
        return null;
      const configured = effectivePolicy(match.workflow, declared.key);
      const policy = {
        ...configured,
        maxMinutes: Math.min(
          configured.maxMinutes,
          declared.maxMinutes ?? configured.maxMinutes,
        ),
      };
      const lease: NativeLease = {
        id: randomUUID(),
        repositoryId,
        workflowId: match.workflow.id,
        workflowPath: match.workflow.path,
        jobKey: declared.key,
        jobName: job.name,
        sourceJobId: job.id,
        sourceRunId: run.id,
        attempt: run.run_attempt,
        sourceSha: job.head_sha,
        labels: job.labels,
        policy,
        state: "queued",
        sourceConclusion: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        deadline: Date.now() + (policy.maxMinutes + 60) * 60_000,
        accountId: null,
        providerId: null,
        runner: null,
        worker: null,
        remoteRunId: null,
        runnerId: null,
        submittedAt: null,
        jitRequestedAt: null,
        claimedAt: null,
        period: currentPeriod(),
        reservedMinutes: 0,
        actualMinutes: null,
        reservedMicros: 0,
        actualMicros: null,
        cancellationConfirmed: false,
        message: "Waiting for free GitHub capacity.",
        sourceUrl: job.html_url,
        hostUrl: null,
      };
      return this.context.store.transaction(() => {
        const concurrent = this.leases().find(
          (value) =>
            value.repositoryId === repositoryId && value.sourceJobId === jobId,
        );
        if (concurrent) return concurrent;
        this.save(lease);
        return lease;
      });
    } finally {
      await this.execution.github.revoke(token);
    }
  }

  reserve(id: string): NativeLease | null {
    return this.context.store.transaction(() => {
      const lease = this.read(id);
      if (lease?.state !== "queued") return null;
      const repository = this.repository(lease.repositoryId);
      const workflow = repository.workflows.find(
        (value) => value.id === lease.workflowId,
      );
      if (repository.error || !workflow?.enabled || workflow.error) return null;
      const accounts = this.context.store.list("account", accountSchema);
      const providers = this.context.store.list("provider", providerSchema);
      const { candidates, eligible } = executionCapacity(
        {
          projectId: `native:${repository.id}`,
          nativeRepositoryId: repository.id,
          recipe: {
            maxMinutes: lease.policy.maxMinutes,
            memoryGiB: lease.policy.memoryGiB,
            maxCostMicros: lease.policy.maxCostMicros,
          },
          ubicloudRunner: lease.policy.ubicloudRunner ?? undefined,
        },
        this.execution.workers(),
        accounts,
        providers,
        capacityLedger(this.context.store),
      );
      const allowed = candidates
        .filter((candidate) => lease.policy.providers.includes(candidate.kind))
        .map((candidate) => ({
          ...nativeMachine(candidate, lease.policy, providers),
          priority: lease.policy.providers.indexOf(candidate.kind) + 1,
        }));
      const assignment = previewRouting(allowed, {
        jobs: 1,
        maxMinutes: nativeHostMinutes(lease),
        memoryGiB: lease.policy.memoryGiB,
        maxCostMicros: lease.policy.maxCostMicros,
      }).assignments[0];
      if (!assignment?.candidateId || !assignment.runner) {
        this.save({
          ...lease,
          message: assignment?.reason ?? "Waiting for allowed capacity.",
        });
        return null;
      }
      const candidate = allowed.find(
        (value) => value.id === assignment.candidateId,
      );
      if (!candidate) return null;
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
      if (!worker?.nativeSha) return null;
      const reserved: NativeLease = {
        ...lease,
        state: "dispatching",
        worker,
        accountId: worker.accountId,
        providerId:
          candidate.kind === "ubicloud" ? (provider?.projectId ?? null) : null,
        runner: assignment.runner,
        period: currentPeriod(),
        reservedMinutes:
          candidate.kind === "github" ? nativeHostMinutes(lease) : 0,
        reservedMicros: assignment.costMicros,
        ...(candidate.kind === "ubicloud" && provider
          ? {
              expectedFamily: machineChoice(lease.policy, provider).family,
              standardRateMicros: machineChoice(lease.policy, provider)
                .standard,
              premiumRateMicros: machineChoice(lease.policy, provider).premium,
            }
          : {}),
        message: `Starting ${candidate.name} for the original GitHub job.`,
      };
      this.save(reserved);
      return reserved;
    });
  }

  private async verifyProvider(lease: NativeLease): Promise<void> {
    if (!lease.providerId || !lease.worker) return;
    const provider = this.context.store.get(
      "provider",
      lease.providerId,
      providerSchema,
    );
    const secret = this.context.store.secret(
      `ubicloud:${lease.providerId}`,
      z.object({ token: z.string() }),
    );
    if (!provider || !secret)
      throw new HttpError(409, "Reconnect the selected Ubicloud project.");
    await verifyUbicloudWorker(
      provider,
      lease.worker.repository,
      secret.token,
      this.context.fetcher,
    );
  }

  async dispatch(lease: NativeLease): Promise<void> {
    if (!lease.worker?.nativeSha || !lease.runner || lease.submittedAt !== null)
      return;
    const original = await this.source(lease);
    if (
      original.run.run_attempt !== lease.attempt ||
      original.job.status !== "queued"
    ) {
      this.save({
        ...lease,
        state: "cancelled",
        cancellationConfirmed: true,
        actualMinutes: 0,
        actualMicros: 0,
        message: "The original job no longer needs a runner.",
      });
      return;
    }
    const token = await this.execution.workerToken(lease.worker);
    try {
      const ref = `buildferry-native-${lease.worker.nativeSha}`;
      if (
        (await this.execution.github.ref(
          lease.worker.repository,
          ref,
          token,
        )) !== lease.worker.nativeSha
      )
        throw new HttpError(409, "The pinned native launcher changed.");
      await this.verifyProvider(lease);
      const current = this.read(lease.id);
      if (current?.state !== "dispatching" || current.submittedAt !== null)
        return;
      this.save({ ...current, submittedAt: Date.now() });
      try {
        const result = await this.execution.github.request(
          "POST",
          `/repos/${lease.worker.repository}/actions/workflows/${nativeWorkerWorkflow}/dispatches`,
          token,
          z.object({ workflow_run_id: z.number().int().positive() }),
          {
            ref,
            inputs: {
              request_id: lease.id,
              runner: lease.runner,
              max_minutes: String(nativeHostMinutes(lease)),
            },
            return_run_details: true,
          },
        );
        const latest = this.read(lease.id);
        if (latest)
          this.save({
            ...latest,
            remoteRunId: result.workflow_run_id,
            hostUrl: `https://github.com/${lease.worker.repository}/actions/runs/${result.workflow_run_id}`,
            message:
              "Host accepted. Waiting for GitHub to assign the original job.",
          });
      } catch (error) {
        if (
          error instanceof ProviderError &&
          [400, 401, 403, 404, 422].includes(error.status)
        ) {
          const latest = this.read(lease.id);
          if (latest)
            this.save({
              ...latest,
              state: "cancelling",
              actualMinutes: 0,
              actualMicros: 0,
              cancellationConfirmed: true,
              message:
                "GitHub rejected the host request. Cancelling the original workflow.",
            });
        } else throw error;
      }
    } finally {
      await this.execution.github.revoke(token);
    }
  }

  async claim(request: FastifyRequest): Promise<{ jit: string }> {
    const input = z
      .object({
        requestId: z.uuid(),
        runId: z.number().int().positive(),
        cpuModel: z.string().max(200).optional(),
      })
      .strict()
      .parse(request.body);
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith("Bearer "))
      throw new HttpError(401, "A GitHub host identity is required.");
    let claims;
    try {
      claims = await this.verify(authorization.slice(7));
    } catch {
      throw new HttpError(401, "The host identity could not be verified.");
    }
    const lease = this.read(input.requestId);
    const worker = lease?.worker;
    if (
      !lease ||
      !worker?.nativeSha ||
      !["dispatching", "running"].includes(lease.state)
    )
      throw new HttpError(403, "This host request is not active.");
    const ref = `refs/tags/buildferry-native-${worker.nativeSha}`;
    if (
      claims.repository_id !== String(worker.repositoryId) ||
      claims.repository_owner_id !== String(worker.accountId) ||
      claims.run_id !== String(input.runId) ||
      claims.sha !== worker.nativeSha ||
      claims.workflow_sha !== worker.nativeSha ||
      claims.ref !== ref ||
      claims.workflow_ref !==
        `${worker.repository}/.github/workflows/${nativeWorkerWorkflow}@${ref}` ||
      claims.runner_environment !==
        (lease.providerId ? "self-hosted" : "github-hosted")
    )
      throw new HttpError(
        403,
        "The host does not match its pinned launcher and selected provider.",
      );
    if (lease.remoteRunId === null)
      throw new HttpError(425, "The accepted host is still being recorded.");
    if (lease.remoteRunId !== input.runId)
      throw new HttpError(403, "This is a different host run.");
    if (lease.providerId) {
      const family = cpuFamily(input.cpuModel ?? "");
      this.save({ ...lease, hostFamily: family });
      if (
        lease.expectedFamily &&
        lease.expectedFamily !== "account" &&
        family !== lease.expectedFamily
      ) {
        this.save({
          ...lease,
          hostFamily: family,
          state: "cancelling",
          message:
            "Ubicloud returned different hardware. Check its automatic Premium setting before retrying. The source job was not started.",
        });
        throw new HttpError(
          409,
          "Ubicloud did not supply the selected machine family. Check automatic Premium in Ubicloud settings.",
        );
      }
    }
    const source = await this.source(lease);
    if (
      source.run.run_attempt !== lease.attempt ||
      source.job.status !== "queued"
    )
      throw new HttpError(409, "The original job no longer needs this host.");
    const intent = this.context.store.transaction(() => {
      const current = this.read(lease.id);
      if (
        current?.state !== "dispatching" ||
        current.jitRequestedAt !== null ||
        current.claimedAt !== null
      )
        throw new HttpError(
          409,
          "This runner configuration was already requested.",
        );
      this.save({ ...current, jitRequestedAt: Date.now() });
      return current;
    });
    const repository = this.repository(lease.repositoryId);
    const token = await this.execution.github.token(
      repository.installationId,
      repository.id,
      { administration: "write" },
    );
    try {
      const configuration = await this.execution.github.request(
        "POST",
        `/repos/${repository.repository}/actions/runners/generate-jitconfig`,
        token,
        z.object({
          runner: z.object({ id: z.number().int().positive() }),
          encoded_jit_config: z.string().min(1).max(65_536),
        }),
        {
          name: `buildferry-${lease.id}`,
          runner_group_id: 1,
          labels: intent.labels,
          work_folder: "_work",
        },
      );
      const current = this.read(lease.id);
      if (current?.state !== "dispatching") {
        await this.execution.github.request(
          "DELETE",
          `/repos/${repository.repository}/actions/runners/${configuration.runner.id}`,
          token,
          z.null(),
        );
        throw new HttpError(409, "The original job was stopped during setup.");
      }
      this.save({
        ...current,
        runnerId: configuration.runner.id,
        claimedAt: Date.now(),
        state: "running",
        message: "GitHub is assigning the original job to its runner.",
      });
      return { jit: configuration.encoded_jit_config };
    } finally {
      await this.execution.github.revoke(token);
    }
  }
}
