import { createRemoteJWKSet, jwtVerify } from "jose";
import { z } from "zod";
import type { FastifyRequest } from "fastify";
import { jobSchema, projectSchema, type Job } from "../shared/execution.js";
import { HttpError } from "./context.js";
import type { ExecutionService } from "./execution-service.js";
import { workerWorkflow } from "./worker-template.js";

export const workerClaimsSchema = z.object({
  repository_id: z.string(),
  repository_owner_id: z.string(),
  run_id: z.string(),
  run_attempt: z.literal("1"),
  sha: z.string(),
  workflow_sha: z.string(),
  workflow_ref: z.string(),
  ref: z.string(),
  event_name: z.literal("workflow_dispatch"),
  runner_environment: z.enum(["github-hosted", "self-hosted"]),
});
export type WorkerClaims = z.infer<typeof workerClaimsSchema>;
export type VerifyWorkerIdentity = (token: string) => Promise<WorkerClaims>;
const keys = createRemoteJWKSet(
  new URL("https://token.actions.githubusercontent.com/.well-known/jwks"),
  { timeoutDuration: 15_000, cooldownDuration: 30_000 },
);

export function githubWorkerVerifier(audience: string): VerifyWorkerIdentity {
  return async (token) => {
    const result = await jwtVerify(token, keys, {
      issuer: "https://token.actions.githubusercontent.com",
      audience,
      algorithms: ["RS256"],
      maxTokenAge: "10m",
      requiredClaims: ["exp", "iat", "aud", "iss"],
      clockTolerance: 5,
    });
    return workerClaimsSchema.parse(result.payload);
  };
}

/** A worker identity is scoped to one approved revision, one provider run and one attempt. */
export class WorkerIdentity {
  constructor(
    private readonly service: ExecutionService,
    private readonly verify: VerifyWorkerIdentity,
  ) {}
  async authorize(request: FastifyRequest): Promise<Job> {
    const { requestId, runId } = z
      .object({ requestId: z.uuid(), runId: z.number().int().positive() })
      .strict()
      .parse(request.body);
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith("Bearer "))
      throw new HttpError(401, "A verified worker identity is required.");
    let claims: WorkerClaims;
    try {
      claims = await this.verify(authorization.slice(7));
    } catch {
      throw new HttpError(401, "The worker identity could not be verified.");
    }
    const job = this.service.context.store.get("job", requestId, jobSchema);
    const worker = job?.worker;
    if (!job || !worker || !["dispatching", "running"].includes(job.state))
      throw new HttpError(403, "This worker request is not active.");
    const ref = `refs/tags/buildferry-worker-${worker.sha}`;
    if (
      claims.repository_id !== String(worker.repositoryId) ||
      claims.repository_owner_id !== String(worker.accountId) ||
      claims.sha !== worker.sha ||
      claims.workflow_sha !== worker.sha ||
      claims.ref !== ref ||
      claims.workflow_ref !==
        `${worker.repository}/.github/workflows/${workerWorkflow}@${ref}` ||
      claims.run_id !== String(runId) ||
      claims.runner_environment !==
        (job.providerId ? "self-hosted" : "github-hosted")
    )
      throw new HttpError(
        403,
        "The worker does not match this immutable request.",
      );
    if (job.remoteRunId === null)
      throw new HttpError(425, "The accepted run is still being recorded.");
    if (job.remoteRunId !== runId)
      throw new HttpError(
        403,
        "The worker run does not match the accepted dispatch.",
      );
    return job;
  }
  async claim(request: FastifyRequest) {
    const job = await this.authorize(request);
    const context = this.service.context;
    const project = context.store.get("project", job.projectId, projectSchema);
    if (!project)
      throw new HttpError(409, "The source project is no longer connected.");
    context.store.transaction(() => {
      const current = context.store.get("job", job.id, jobSchema);
      if (
        current?.bootstrapAt !== null ||
        !["dispatching", "running"].includes(current.state)
      )
        throw new HttpError(
          409,
          "Source preparation has already been claimed.",
        );
      this.service.save({ ...current, bootstrapAt: Date.now() });
    });
    const sourceToken = await this.service.github.token(
      project.installationId,
      project.repositoryId,
      { contents: "read" },
    );
    const current = context.store.get("job", job.id, jobSchema);
    if (!current || !["dispatching", "running"].includes(current.state)) {
      await this.service.github.revoke(sourceToken);
      throw new HttpError(409, "This request has been stopped.");
    }
    context.store.setSecret(`checkout:${job.id}`, { token: sourceToken });
    return {
      sourceRepository: project.repository,
      sourceRepositoryId: project.repositoryId,
      sourceSha: job.sourceSha,
      sourceToken,
      recipeHash: job.recipeHash,
      directory: job.recipe.directory,
      commands: job.recipe.commands,
    };
  }
  async prepared(request: FastifyRequest) {
    const job = await this.authorize(request);
    await this.revoke(job.id);
    const current = this.service.context.store.get("job", job.id, jobSchema);
    if (!current || !["dispatching", "running"].includes(current.state))
      throw new HttpError(409, "This request has been stopped.");
    if (current.bootstrapAt === null)
      throw new HttpError(409, "Source preparation was not admitted.");
    this.service.save({
      ...current,
      state: "running",
      preparedAt: current.preparedAt ?? Date.now(),
      message:
        "The approved commands are running. Source checkout access has been revoked.",
    });
    return { ok: true };
  }
  async revoke(id: string): Promise<void> {
    const secret = this.service.context.store.secret(
      `checkout:${id}`,
      z.object({ token: z.string() }),
    );
    if (secret) {
      await this.service.github.revoke(secret.token);
      this.service.context.store.deleteSecret(`checkout:${id}`);
    }
  }
}
