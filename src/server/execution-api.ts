import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { jobSchema, projectSchema } from "../shared/execution.js";
import {
  requireIdentity,
  requireOwner,
  HttpError,
  type Context,
} from "./context.js";
import { ExecutionService } from "./execution-service.js";
import { ExecutionController } from "./execution-controller.js";
import {
  WorkerIdentity,
  githubWorkerVerifier,
  type VerifyWorkerIdentity,
} from "./worker-identity.js";

/** Dashboard writes require a session; worker handshakes require GitHub-signed identities. */
export function registerExecution(
  server: FastifyInstance,
  context: Context,
  options: Readonly<{
    verifyIdentity?: VerifyWorkerIdentity;
    startController: boolean;
  }>,
) {
  const service = new ExecutionService(context);
  const identity = new WorkerIdentity(
    service,
    options.verifyIdentity ?? githubWorkerVerifier(context.config.publicUrl),
  );
  const controller = new ExecutionController(service, identity);
  server.get("/api/execution", async (request) => {
    requireIdentity(request, context);
    return {
      projects: service.projects(),
      workers: service.workers(),
      jobs: service
        .jobs()
        .sort((left, right) => right.createdAt - left.createdAt)
        .slice(0, 200),
    };
  });
  server.post("/api/projects", async (request) => {
    requireOwner(request, context);
    return service.connectProject(
      request.body,
      requireIdentity(request, context).id,
    );
  });
  server.put("/api/projects/:id", async (request) => {
    requireOwner(request, context);
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const project = context.store.get("project", id, projectSchema);
    if (!project) throw new HttpError(404, "This project is not connected.");
    const updates = z
      .object({
        recipe: projectSchema.shape.recipe,
        enabled: z.boolean(),
        onPush: z.boolean(),
      })
      .strict()
      .parse(request.body);
    if (
      service
        .projects()
        .some(
          (value) =>
            value.id !== project.id &&
            value.repositoryId === project.repositoryId &&
            value.recipe.name === updates.recipe.name,
        )
    )
      throw new HttpError(
        409,
        "Choose a unique workload name for this repository.",
      );
    const changed = { ...project, ...updates, updatedAt: Date.now() };
    context.store.put("project", id, changed);
    context.store.audit(
      `${project.repository}'s approved recipe was updated for future runs.`,
    );
    return changed;
  });
  server.post("/api/workers", async (request) => {
    const owner = requireIdentity(request, context);
    const input = z
      .object({
        accountId: z.number().int().positive(),
        allowedProjects: z.array(z.uuid()).max(100),
      })
      .strict()
      .parse(request.body);
    if (input.accountId !== owner.id)
      throw new HttpError(
        403,
        "Only an account's owner can install its worker and approve projects.",
      );
    return service.provisionWorker(input.accountId, input.allowedProjects);
  });
  server.post("/api/jobs", async (request, reply) => {
    requireOwner(request, context);
    const job = await service.enqueue(request.body);
    return reply.code(202).send(job);
  });
  server.post("/api/jobs/:id/cancel", async (request) => {
    requireOwner(request, context);
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const job = context.store.get("job", id, jobSchema);
    if (!job) throw new HttpError(404, "This run was not found.");
    return controller.cancel(job);
  });
  server.post("/api/worker/claim", async (request) => identity.claim(request));
  server.post("/api/worker/prepared", async (request) =>
    identity.prepared(request),
  );
  const interval = options.startController
    ? setInterval(() => {
        controller.tick().catch(() => undefined);
      }, 5000)
    : null;
  interval?.unref();
  return {
    service,
    controller,
    stop: async () => {
      if (interval) clearInterval(interval);
      await controller.stop();
    },
  };
}
