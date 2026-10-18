import { unzipSync } from "fflate";
import { z } from "zod";
import { auditSchema, projectSchema, type Job } from "../shared/execution.js";
import type { ExecutionService } from "./execution-service.js";
import { boundedBytes, ProviderError } from "./providers/http.js";
import type { WorkflowRun } from "./providers/app-github.js";
import {
  workerJobName,
  workerSteps,
  workerWorkflow,
} from "./worker-template.js";

export class EvidenceError extends Error {}
export const jobsReportSchema = z.object({
  total_count: z.number(),
  jobs: z.array(
    z.object({
      name: z.string(),
      status: z.string(),
      conclusion: z.string().nullable(),
      run_attempt: z.number(),
      started_at: z.string(),
      completed_at: z.string().nullable(),
      steps: z.array(
        z.object({
          name: z.string(),
          conclusion: z.string().nullable(),
          started_at: z.string().nullable(),
          completed_at: z.string().nullable(),
        }),
      ),
    }),
  ),
});
const artifactsSchema = z.object({
  total_count: z.number(),
  artifacts: z.array(
    z.object({
      id: z.number().int().positive(),
      name: z.string(),
      expired: z.boolean(),
      size_in_bytes: z.number(),
      created_at: z.string(),
    }),
  ),
});

/** Run metadata is obtained with App authority, never accepted from project output. */
export async function assertRun(
  service: ExecutionService,
  job: Job,
  run: WorkflowRun,
  token: string,
): Promise<void> {
  if (!job.worker) throw new EvidenceError("Missing approved worker identity.");
  const matches = {
    run: run.id === job.remoteRunId,
    repository: run.repository.id === job.worker.repositoryId,
    revision: run.head_sha === job.worker.sha,
    event: run.event === "workflow_dispatch",
    workflow: [
      `.github/workflows/${workerWorkflow}`,
      `.github/workflows/${workerWorkflow}@refs/tags/buildferry-worker-${job.worker.sha}`,
    ].includes(run.path),
    request: run.display_title === `buildferry:${job.id}`,
    attempt: run.run_attempt === 1,
    actor: run.actor.id === (await service.github.botId(token)),
  };
  const mismatches = Object.entries(matches)
    .filter(([, matches]) => !matches)
    .map(([field]) => field);
  if (mismatches.length)
    throw new EvidenceError(
      `The provider run identity does not match the approved worker (${mismatches.join(", ")}). Capacity is held for investigation.`,
    );
}

async function downloadAudit(
  service: ExecutionService,
  job: Job,
  artifactId: number,
  token: string,
) {
  if (!job.worker) throw new EvidenceError("Missing worker identity.");
  const fetcher = service.context.fetcher;
  const response = await fetcher(
    `https://api.github.com/repos/${job.worker.repository}/actions/artifacts/${artifactId}/zip`,
    {
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2026-03-10",
      },
    },
  );
  const location = response.headers.get("location");
  if (response.status !== 302 || !location)
    throw new ProviderError(502, "Audit download was not authorized.");
  const url = new URL(location);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    ![".blob.core.windows.net", ".actions.githubusercontent.com"].some(
      (domain) => url.hostname.endsWith(domain),
    )
  )
    throw new EvidenceError("Unexpected artifact storage location.");
  // The signed storage URL receives no GitHub authorization header.
  const download = await fetcher(url, {
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!download.ok)
    throw new ProviderError(502, "The checkout audit could not be downloaded.");
  const bytes = await boundedBytes(download, 32768);
  try {
    const files = unzipSync(bytes, {
      filter: (file) =>
        file.name === "buildferry-audit.json" && file.originalSize <= 16384,
    });
    const content = files["buildferry-audit.json"];
    if (!content || content.length > 16384) throw new Error("Missing audit");
    return auditSchema.parse(JSON.parse(Buffer.from(content).toString("utf8")));
  } catch {
    throw new EvidenceError("The checkout audit could not be verified.");
  }
}

export function workerAccounting(
  job: Job,
  run: WorkflowRun,
  report: z.infer<typeof jobsReportSchema>,
) {
  if (report.total_count !== 1 || report.jobs.length !== 1)
    throw new EvidenceError("Unexpected worker job inventory.");
  const build = report.jobs[0];
  if (
    build?.name !== workerJobName ||
    build.run_attempt !== 1 ||
    !build.completed_at ||
    build.status !== "completed"
  )
    throw new EvidenceError("The worker job could not be verified.");
  const start = Date.parse(build.started_at);
  const duration = Date.parse(build.completed_at) - start;
  const queued = start - Date.parse(run.created_at);
  if (
    !Number.isFinite(duration) ||
    !Number.isFinite(queued) ||
    duration < 0 ||
    queued < -1000
  )
    throw new EvidenceError("The worker duration is invalid.");
  const minutes = Math.max(1, Math.ceil(duration / 60_000));
  const rate = job.reservedMicros / (job.recipe.maxMinutes + 1);
  const commands = build.steps.find((step) => step.name === workerSteps[2]);
  const commandDuration =
    commands?.started_at && commands.completed_at
      ? Date.parse(commands.completed_at) - Date.parse(commands.started_at)
      : null;
  return {
    build,
    accounting: {
      actualMinutes: minutes,
      actualMicros: Math.ceil(minutes * rate),
      cancellationConfirmed: true,
      queueSeconds: Math.max(0, queued / 1000),
      commandSeconds:
        commandDuration !== null &&
        Number.isFinite(commandDuration) &&
        commandDuration >= 0
          ? commandDuration / 1000
          : null,
    },
  };
}

/** An immutable artifact created before commands run proves the exact source and recipe. */
export async function verifyAudit(
  service: ExecutionService,
  job: Job,
  build: z.infer<typeof jobsReportSchema>["jobs"][number],
  token: string,
): Promise<void> {
  if (
    workerSteps.some(
      (name) =>
        !build.steps.some(
          (step) => step.name === name && step.conclusion === "success",
        ),
    )
  )
    throw new EvidenceError("A required worker step did not pass.");
  if (job.preparedAt === null || !job.worker)
    throw new EvidenceError("Source access was not confirmed revoked.");
  const upload = build.steps.find((step) => step.name === workerSteps[1]);
  const artifacts = await service.github.request(
    "GET",
    `/repos/${job.worker.repository}/actions/runs/${job.remoteRunId}/artifacts?per_page=100`,
    token,
    artifactsSchema,
  );
  const matching = artifacts.artifacts.filter(
    (artifact) => artifact.name === "buildferry-audit-1" && !artifact.expired,
  );
  if (
    artifacts.total_count > 100 ||
    matching.length !== 1 ||
    !upload?.started_at ||
    !upload.completed_at
  )
    throw new EvidenceError("The checkout audit is missing or ambiguous.");
  const artifact = matching[0];
  if (!artifact) throw new EvidenceError("The checkout audit is missing.");
  const created = Date.parse(artifact.created_at);
  if (
    !Number.isFinite(created) ||
    artifact.size_in_bytes > 32768 ||
    created < Date.parse(upload.started_at) - 1000 ||
    created > Date.parse(upload.completed_at) + 1000
  )
    throw new EvidenceError(
      "The audit was not preserved before project code ran.",
    );
  const audit = await downloadAudit(service, job, artifact.id, token);
  const project = service.context.store.get(
    "project",
    job.projectId,
    projectSchema,
  );
  if (
    !project ||
    audit.requestId !== job.id ||
    audit.sourceRepositoryId !== project.repositoryId ||
    audit.sourceSha !== job.sourceSha ||
    audit.recipeHash !== job.recipeHash ||
    audit.workerRepositoryId !== job.worker.repositoryId ||
    audit.workerSha !== job.worker.sha ||
    audit.runId !== job.remoteRunId
  )
    throw new EvidenceError("The immutable audit does not match this request.");
}
