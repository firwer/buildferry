import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { providerSchema } from "../src/shared/contracts.js";
import { jobSchema } from "../src/shared/execution.js";
import { recipeHash } from "../src/server/execution-service.js";
import { executionFixture, job, project } from "./execution-fixtures.js";

const apps: Awaited<ReturnType<typeof executionFixture>>[] = [];
async function make() {
  const app = await executionFixture();
  apps.push(app);
  app.store.put("provider", app.providerId, {
    projectId: app.providerId,
    name: "Cloud",
    installations: [{ id: "install", name: "owner" }],
    verifiedAt: Date.now(),
    runner: "ubicloud-standard-2",
    priority: 2,
    rateMicros: 2000,
    budgetMicros: 250_000,
    machineRates: [{ runner: "ubicloud-standard-4", rateMicros: 4000 }],
  });
  app.store.setSecret(`ubicloud:${app.providerId}`, {
    token: "stored-cloud-token",
  });
  return app;
}
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.server.close()));
});
const paidJob = () =>
  job({
    route: "ubicloud",
    recipe: { ...project.recipe, maxCostMicros: 100_000 },
  });

describe("explicit Ubicloud machines", () => {
  it("uses the provider default and never upgrades it to satisfy a memory request", async () => {
    const { service } = await make();
    const large = paidJob();
    large.recipe = { ...large.recipe, memoryGiB: 16 };
    service.save(large);
    expect(service.reserve(large.id)).toBeNull();
    const small = paidJob();
    service.save(small);
    expect(service.reserve(small.id)).toMatchObject({
      runner: "ubicloud-standard-2",
      reservedMicros: 22_000,
    });
  });
  it("respects the workload machine and its own rate instead of the provider default", async () => {
    const { service } = await make();
    const request = paidJob();
    request.recipe = {
      ...request.recipe,
      ubicloudRunner: "ubicloud-standard-4",
      memoryGiB: 16,
    };
    service.save(request);
    expect(service.reserve(request.id)).toMatchObject({
      runner: "ubicloud-standard-4",
      reservedMicros: 44_000,
    });
  });
  it("snapshots the per-run override ahead of the workload choice without changing its commands", async () => {
    const { service, store } = await make();
    const recipe = {
      ...project.recipe,
      ubicloudRunner: "ubicloud-standard-4" as const,
      maxCostMicros: 100_000,
    };
    store.put("project", project.id, { ...project, recipe });
    const request = await service.enqueue({
      projectId: project.id,
      route: "ubicloud",
      ubicloudRunner: "ubicloud-standard-2",
    });
    expect(request).toMatchObject({
      ubicloudRunner: "ubicloud-standard-2",
      recipe,
      recipeHash: recipeHash(recipe),
    });
    service.save({ ...request, checkId: 501 });
    expect(service.reserve(request.id)?.runner).toBe("ubicloud-standard-2");
  });
  it("blocks a machine without an entered rate instead of falling back to another size", async () => {
    const { service, store } = await make();
    const request = {
      ...paidJob(),
      ubicloudRunner: "ubicloud-standard-8" as const,
    };
    service.save(request);
    expect(service.reserve(request.id)).toBeNull();
    expect(store.get("job", request.id, jobSchema)?.state).toBe("queued");
  });
  it("edits the default without a token and keeps existing reservations charged to the same monthly cap", async () => {
    const { service, store, server, headers, cookies, providerId } =
      await make();
    const request = paidJob();
    service.save(request);
    const admitted = service.reserve(request.id);
    if (!admitted) throw new Error("Fixture was not admitted");
    expect(admitted?.reservedMicros).toBe(22_000);
    const result = await server.inject({
      method: "PUT",
      url: `/api/providers/${providerId}`,
      headers,
      cookies,
      payload: {
        runner: "ubicloud-standard-4",
        rateMicros: 4000,
        priority: 2,
        budgetMicros: 60_000,
        machineRates: [],
      },
    });
    expect(result.statusCode).toBe(200);
    expect(result.body).not.toContain("stored-cloud-token");
    expect(
      store.secret(`ubicloud:${providerId}`, z.object({ token: z.string() }))
        ?.token,
    ).toBe("stored-cloud-token");
    expect(store.get("job", request.id, jobSchema)).toMatchObject({
      runner: "ubicloud-standard-2",
      reservedMicros: 22_000,
    });
    // Free the worker slot, retaining the unresolved paid reservation in the monthly ledger.
    service.save({ ...admitted, state: "failed", cancellationConfirmed: true });
    const next = paidJob();
    service.save(next);
    expect(service.reserve(next.id)).toBeNull();
    expect(
      store.get("provider", providerId, providerSchema)?.budgetMicros,
    ).toBe(60_000);
  });
  it("rejects invalid or unauthenticated machine edits", async () => {
    const { server, headers, cookies, providerId, store } = await make();
    const request = {
      method: "PUT" as const,
      url: `/api/providers/${providerId}`,
      headers,
      payload: {
        runner: "ubicloud-standard-4",
        priority: 2,
        rateMicros: 4000,
        budgetMicros: 250_000,
        machineRates: [{ runner: "ubicloud-standard-4", rateMicros: 1 }],
      },
    };
    expect((await server.inject(request)).statusCode).toBe(401);
    expect((await server.inject({ ...request, cookies })).statusCode).toBe(400);
    expect(store.get("provider", providerId, providerSchema)?.runner).toBe(
      "ubicloud-standard-2",
    );
  });
});
