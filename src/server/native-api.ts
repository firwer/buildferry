import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  effectivePolicy,
  nativeWorkflowSettingsSchema,
  nativeLeaseSchema,
} from "../shared/native.js";
import { requireOwner, type Context, HttpError } from "./context.js";
import type { ExecutionService } from "./execution-service.js";
import { NativeService } from "./native-service.js";
import { NativeController } from "./native-controller.js";
import {
  githubWorkerVerifier,
  type VerifyWorkerIdentity,
} from "./worker-identity.js";
import { provisionNativeWorker } from "./native-worker.js";

export function registerNative(
  server: FastifyInstance,
  context: Context,
  execution: ExecutionService,
  options: { verifyIdentity?: VerifyWorkerIdentity; startController: boolean },
) {
  const service = new NativeService(
    execution,
    options.verifyIdentity ?? githubWorkerVerifier(context.config.publicUrl),
  );
  const controller = new NativeController(service);
  const workerUpdates = new Map<
    number,
    ReturnType<typeof provisionNativeWorker>
  >();
  const dashboard = () => ({
    repositories: service.inventory.repositories(),
    workers: execution.workers(),
    runs: service
      .leases()
      .sort((left, right) => right.createdAt - left.createdAt)
      .slice(0, 200),
  });
  server.get("/api/native", async (request) => {
    requireOwner(request, context);
    return dashboard();
  });
  server.post("/api/native/refresh", async (request) => {
    requireOwner(request, context);
    await service.inventory.refresh();
    return dashboard();
  });
  server.post("/api/native/repositories/:id/refresh", async (request) => {
    requireOwner(request, context);
    const { id } = z
      .object({ id: z.coerce.number().int().positive() })
      .parse(request.params);
    return service.inventory.refreshRepository(id);
  });
  server.put(
    "/api/native/repositories/:id/workflows/:workflowId",
    async (request) => {
      requireOwner(request, context);
      const { id, workflowId } = z
        .object({
          id: z.coerce.number().int().positive(),
          workflowId: z.coerce.number().int().positive(),
        })
        .parse(request.params);
      const input = nativeWorkflowSettingsSchema.parse(request.body);
      const repository = service.repository(id);
      const workflow = repository.workflows.find(
        (value) => value.id === workflowId,
      );
      if (!workflow)
        throw new HttpError(404, "This workflow is not connected.");
      if (
        Object.keys(input.overrides).some(
          (key) =>
            !workflow.jobs.some((job) => job.key === key && job.supported),
        )
      )
        throw new HttpError(422, "Choose a configurable job in this workflow.");
      if (input.enabled && !workflow.enabled) {
        // A read-only preflight proves runner authority before any source job is routed here.
        const token = await execution.github.token(
          repository.installationId,
          id,
          { administration: "write" },
        );
        try {
          await execution.github.request(
            "GET",
            `/repos/${repository.repository}/actions/runners?per_page=1`,
            token,
            z.object({ total_count: z.number() }),
          );
        } finally {
          await execution.github.revoke(token);
        }
      }
      const changed = { ...workflow, ...input };
      const updated = {
        ...repository,
        workflows: repository.workflows.map((value) =>
          value.id === workflowId ? changed : value,
        ),
      };
      context.store.transaction(() => {
        context.store.put("native-repository", String(id), updated);
        for (const lease of service
          .leases()
          .filter(
            (lease) =>
              lease.repositoryId === id &&
              lease.workflowId === workflowId &&
              lease.state === "queued",
          ))
          service.save({
            ...lease,
            policy: {
              ...effectivePolicy(changed, lease.jobKey),
              maxMinutes: Math.min(
                effectivePolicy(changed, lease.jobKey).maxMinutes,
                workflow.jobs.find((job) => job.key === lease.jobKey)
                  ?.maxMinutes ?? 180,
              ),
            },
          });
        context.store.audit(
          `${repository.repository}: routing settings saved for ${workflow.name}.`,
        );
      });
      return updated;
    },
  );
  server.post("/api/native/accounts/:id/worker", async (request) => {
    requireOwner(request, context);
    const { id } = z
      .object({ id: z.coerce.number().int().positive() })
      .parse(request.params);
    const active = workerUpdates.get(id);
    if (active) return active;
    const pending = provisionNativeWorker(execution, id).finally(() =>
      workerUpdates.delete(id),
    );
    workerUpdates.set(id, pending);
    return pending;
  });
  server.post("/api/native/runs/:id/cancel", async (request) => {
    requireOwner(request, context);
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const lease = context.store.get("native-lease", id, nativeLeaseSchema);
    if (!lease) throw new HttpError(404, "This run is not connected.");
    return controller.cancel(lease);
  });
  server.post("/api/native/claim", async (request) => service.claim(request));
  const interval = options.startController
    ? setInterval(() => {
        controller.tick().catch(() => undefined);
      }, 5_000)
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
