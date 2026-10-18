import { afterEach, describe, expect, it, vi } from "vitest";
import { nativeFixture, nativeRepository } from "./native-fixtures.js";
import { providerSchema } from "../src/shared/contracts.js";
import {
  cpuFamily,
  hostCost,
  machineChoice,
  nativeMachine,
} from "../src/server/native-machines.js";
import { projectId, response } from "./fixtures.js";
import { candidatesFor } from "../src/server/routing.js";
import {
  provisionNativeWorker,
  nativeWorkerFiles,
} from "../src/server/native-worker.js";
import { ProviderError } from "../src/server/providers/http.js";
import { worker } from "./execution-fixtures.js";
import { workerSchema } from "../src/shared/execution.js";

const apps: Awaited<ReturnType<typeof nativeFixture>>[] = [];
async function make() {
  const app = await nativeFixture();
  apps.push(app);
  return app;
}
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.server.close()));
  vi.restoreAllMocks();
});
async function dispatch(app: Awaited<ReturnType<typeof make>>) {
  const lease = await app.enqueue();
  const reserved = lease && app.native.service.reserve(lease.id);
  if (!reserved) throw new Error("Missing reservation");
  await app.native.service.dispatch(reserved);
  return app.native.service.read(reserved.id)!;
}
const provider = providerSchema.parse({
  projectId,
  name: "Cloud",
  runner: "ubicloud-standard-2",
  rateMicros: 1250,
  priority: 2,
  budgetMicros: 1_000_000,
  verifiedAt: Date.now(),
  installations: [{ id: "ub", name: "owner" }],
  machineRates: [{ runner: "ubicloud-premium-2", rateMicros: 2000 }],
});

describe("native machine choices", () => {
  it("preserves a legacy account setting and makes explicit job machines authoritative", () => {
    const policy = nativeRepository.workflows[0]!.policy;
    expect(machineChoice(policy, provider)).toMatchObject({
      family: "account",
      runner: "ubicloud-standard-2",
    });
    expect(
      machineChoice({ ...policy, ubicloudFamily: "premium" }, provider),
    ).toMatchObject({
      family: "premium",
      runner: "ubicloud-premium-2",
      rate: 2000,
    });
    expect(
      machineChoice(
        {
          ...policy,
          ubicloudFamily: "premium",
          ubicloudRunner: "ubicloud-standard-2",
        },
        provider,
      ).family,
    ).toBe("standard");
    const candidate = candidatesFor([], [provider])[0]!;
    expect(
      nativeMachine(
        candidate,
        { ...policy, ubicloudRunner: "ubicloud-standard-2" },
        [provider],
      ).rateMicros,
    ).toBe(2000);
    expect(
      nativeMachine(
        candidate,
        { ...policy, ubicloudRunner: "ubicloud-standard-30" },
        [provider],
      ).reason,
    ).toContain("Set a rate");
    expect(cpuFamily("AMD EPYC 9354P 32-Core Processor")).toBe("standard");
    expect(cpuFamily("AMD Ryzen 9 9950X 16-Core Processor")).toBe("premium");
    expect(cpuFamily("unknown")).toBe("unknown");
  });
  it("rejects a Premium upgrade before providing a Standard job with a runner", async () => {
    const app = await make();
    const lease = await dispatch(app);
    app.native.service.save({
      ...lease,
      providerId: projectId,
      expectedFamily: "standard",
      standardRateMicros: 1250,
      premiumRateMicros: 2000,
      reservedMicros: 30_000,
    });
    app.verify.mockResolvedValue({
      ...app.claims,
      runner_environment: "self-hosted",
    });
    const result = await app.server.inject({
      method: "POST",
      url: "/api/native/claim",
      headers: { authorization: "Bearer signed" },
      payload: {
        requestId: lease.id,
        runId: 901,
        cpuModel: "AMD Ryzen 9 9950X",
      },
    });
    expect(result.statusCode).toBe(409);
    expect(app.state.jitRequests).toBe(0);
    const saved = app.native.service.read(lease.id)!;
    expect(saved).toMatchObject({ state: "cancelling", hostFamily: "premium" });
    expect(hostCost(saved, 1)).toBe(2000);
  });
  it("accepts the selected Standard family and snapshots its actual estimate", async () => {
    const app = await make();
    const lease = await dispatch(app);
    app.native.service.save({
      ...lease,
      providerId: projectId,
      expectedFamily: "standard",
      standardRateMicros: 1250,
      premiumRateMicros: 2000,
      reservedMicros: 30_000,
    });
    app.verify.mockResolvedValue({
      ...app.claims,
      runner_environment: "self-hosted",
    });
    const result = await app.server.inject({
      method: "POST",
      url: "/api/native/claim",
      headers: { authorization: "Bearer signed" },
      payload: { requestId: lease.id, runId: 901, cpuModel: "AMD EPYC 9354P" },
    });
    expect(result.statusCode).toBe(200);
    expect(hostCost(app.native.service.read(lease.id)!, 2)).toBe(2500);
  });
});

describe("native completion recovery", () => {
  it("never attributes a passing original job to an unregistered or different runner", async () => {
    const app = await make();
    const lease = await dispatch(app);
    app.state.job.status = "completed";
    app.state.job.conclusion = "success";
    app.state.job.runner_id = 999;
    app.state.host.status = "completed";
    app.state.host.conclusion = "success";
    await app.native.controller.tick();
    expect(app.native.service.read(lease.id)).toMatchObject({
      cancellationConfirmed: false,
      actualMinutes: null,
    });
  });
  it("retries source cancellation after a host dies and a cancellation response is lost", async () => {
    const app = await make();
    const lease = await dispatch(app);
    app.state.host.status = "completed";
    app.state.host.conclusion = "failure";
    const original = vi.mocked(app.fetcher).getMockImplementation()!;
    let failures = 1;
    vi.mocked(app.fetcher).mockImplementation(async (input, init) => {
      if (String(input).endsWith("/601/cancel") && failures-- > 0)
        throw new Error("offline");
      return original(input, init);
    });
    await app.native.controller.tick();
    expect(app.native.service.read(lease.id)).toMatchObject({
      state: "cancelling",
      actualMinutes: 1,
      cancellationConfirmed: true,
    });
    await app.native.controller.tick();
    expect(
      app.state.cancellations.some((url) => url.endsWith("/601/cancel")),
    ).toBe(true);
    app.state.job.status = "completed";
    app.state.job.conclusion = "cancelled";
    await app.native.controller.tick();
    expect(app.native.service.read(lease.id)?.state).toBe("cancelled");
  });
  it("cleans up a registered runner on a later inventory page after original completion", async () => {
    const app = await make();
    const lease = await dispatch(app);
    app.native.service.save({
      ...lease,
      runnerId: 903,
      jitRequestedAt: Date.now(),
      claimedAt: Date.now(),
      state: "running",
    });
    app.state.job.status = "completed";
    app.state.job.conclusion = "success";
    app.state.job.runner_id = 903;
    app.state.host.status = "completed";
    app.state.host.conclusion = "success";
    const original = vi.mocked(app.fetcher).getMockImplementation()!;
    let removed = false;
    vi.mocked(app.fetcher).mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes("runners?per_page=100&page=1"))
        return response({ total_count: 101, runners: [] });
      if (url.includes("runners?per_page=100&page=2"))
        return response({
          total_count: 101,
          runners: [{ id: 903, name: `buildferry-${lease.id}` }],
        });
      if (url.endsWith("/runners/903") && init?.method === "DELETE") {
        removed = true;
        return new Response(null, { status: 204 });
      }
      return original(input, init);
    });
    await app.native.controller.tick();
    expect(removed).toBe(true);
    expect(app.native.service.read(lease.id)?.state).toBe("completed");
  });
});

describe("pinned native launcher installation", () => {
  it("includes only the bootstrap and strips its identity from source execution", () => {
    const files = nativeWorkerFiles("https://buildferry.example");
    expect(files).toHaveLength(3);
    expect(files[0]!.content).toContain("id-token: write");
    expect(files[0]!.content).toContain('ACTIONS_ID_TOKEN_REQUEST_TOKEN: ""');
    expect(files[2]!.content).toContain("--jitconfig");
    expect(files[2]!.content).toContain("af4b794c");
  });
  it("resumes an accepted branch update without another commit or forced ref", async () => {
    const app = await make();
    vi.spyOn(app.service.credentials, "token").mockResolvedValue("user-token");
    const next = "c".repeat(40);
    let head = worker.sha;
    let tagged = false;
    let commits = 0;
    let fail = true;
    app.ref.mockImplementation(async (_repo, ref) => {
      if (ref.startsWith("buildferry-native-")) throw new ProviderError(422);
      return head;
    });
    vi.mocked(app.fetcher).mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes("/git/ref/tags/buildferry-native-"))
        return tagged
          ? response({ object: { type: "commit", sha: next } })
          : response({ message: "Not Found" }, 404);
      if (url.includes("/git/commits/") && init?.method === "GET")
        return response({ tree: { sha: head } });
      if (url.endsWith("/git/trees")) return response({ sha: next });
      if (url.endsWith("/git/commits")) {
        commits++;
        return response({ sha: next });
      }
      if (url.endsWith("/git/refs")) {
        tagged = true;
        return response({ ref: "tag" });
      }
      if (init?.method === "PATCH") {
        expect(JSON.parse(String(init.body)).force).toBe(false);
        head = next;
        if (fail) {
          fail = false;
          throw new Error("Accepted response lost");
        }
        return response({ ref: "branch" });
      }
      throw new Error(url);
    });
    await expect(provisionNativeWorker(app.service, 1)).rejects.toThrow();
    expect((await provisionNativeWorker(app.service, 1)).nativeSha).toBe(next);
    expect(app.token).toHaveBeenCalledWith(
      worker.installationId,
      worker.repositoryId,
      { contents: "write", workflows: "write" },
    );
    expect(commits).toBe(1);
    expect(app.store.get("worker", "1", workerSchema)?.sha).toBe(worker.sha);
  });
});
