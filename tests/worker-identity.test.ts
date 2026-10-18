import { afterEach, describe, expect, it } from "vitest";
import { jobSchema } from "../src/shared/execution.js";
import { executionFixture, job, worker, claims } from "./execution-fixtures.js";

const apps: Awaited<ReturnType<typeof executionFixture>>[] = [];
async function make() {
  const app = await executionFixture();
  apps.push(app);
  return app;
}
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.server.close()));
});

describe("verified worker handshake", () => {
  it("requires GitHub identity even on the exact worker routes excluded from cookie authentication", async () => {
    const { server } = await make();
    expect(
      (
        await server.inject({
          method: "POST",
          url: "/api/worker/claim",
          payload: { requestId: job().id, runId: 901 },
        })
      ).statusCode,
    ).toBe(401);
  });
  it("admits one source claim, issues only scoped read access and revokes it before commands", async () => {
    const { server, service, verify, store, token, revoke } = await make();
    const request = job({
      state: "dispatching",
      worker,
      remoteRunId: 901,
      submittedAt: Date.now(),
    });
    service.save(request);
    verify.mockResolvedValue(claims(request));
    const call = {
      method: "POST" as const,
      headers: { authorization: "Bearer signed-oidc" },
      payload: { requestId: request.id, runId: 901 },
    };
    const admitted = await server.inject({ ...call, url: "/api/worker/claim" });
    expect(admitted.statusCode).toBe(200);
    expect(admitted.json()).toMatchObject({
      sourceToken: "installation-token",
      sourceSha: request.sourceSha,
      commands: request.recipe.commands,
    });
    expect(token).toHaveBeenCalledWith(201, 101, { contents: "read" });
    expect(
      (await server.inject({ ...call, url: "/api/worker/claim" })).statusCode,
    ).toBe(409);
    expect(
      (await server.inject({ ...call, url: "/api/worker/prepared" }))
        .statusCode,
    ).toBe(200);
    expect(revoke).toHaveBeenCalledWith("installation-token");
    expect(store.get("job", request.id, jobSchema)).toMatchObject({
      state: "running",
    });
    expect(store.get("job", request.id, jobSchema)?.preparedAt).not.toBeNull();
    expect(
      store.db
        .prepare("SELECT name FROM secrets WHERE name LIKE 'checkout:%'")
        .all(),
    ).toHaveLength(0);
  });
  it.each([
    ["repository_id", "999"],
    ["repository_owner_id", "999"],
    ["sha", "c".repeat(40)],
    ["workflow_sha", "c".repeat(40)],
    ["ref", "refs/heads/main"],
    ["workflow_ref", "other/workflow@refs/heads/main"],
    ["run_id", "902"],
    ["runner_environment", "self-hosted"],
  ])("rejects a mismatched %s claim", async (name, value) => {
    const { server, service, verify, token } = await make();
    const request = job({ state: "dispatching", worker, remoteRunId: 901 });
    service.save(request);
    verify.mockResolvedValue({ ...claims(request), [name]: value });
    const result = await server.inject({
      method: "POST",
      url: "/api/worker/claim",
      headers: { authorization: "Bearer signed" },
      payload: { requestId: request.id, runId: 901 },
    });
    expect(result.statusCode).toBe(403);
    expect(token).not.toHaveBeenCalled();
  });
  it("refuses expired identities, wrong accepted runs, cancelled requests and premature preparation", async () => {
    const { server, service, verify } = await make();
    const request = job({ state: "dispatching", worker, remoteRunId: 901 });
    service.save(request);
    const call = {
      method: "POST" as const,
      url: "/api/worker/claim",
      headers: { authorization: "Bearer signed" },
      payload: { requestId: request.id, runId: 901 },
    };
    verify.mockRejectedValue(new Error("expired"));
    expect((await server.inject(call)).statusCode).toBe(401);
    verify.mockResolvedValue(claims(request));
    service.save({ ...request, remoteRunId: 902 });
    expect((await server.inject(call)).statusCode).toBe(403);
    service.save({ ...request, state: "cancelling" });
    expect((await server.inject(call)).statusCode).toBe(403);
    service.save(request);
    expect(
      (await server.inject({ ...call, url: "/api/worker/prepared" }))
        .statusCode,
    ).toBe(409);
  });
  it("returns a retryable status while dispatch acceptance is being recorded", async () => {
    const { server, service, verify } = await make();
    const request = job({ state: "dispatching", worker, remoteRunId: null });
    service.save(request);
    verify.mockResolvedValue({ ...claims(request), run_id: "901" });
    expect(
      (
        await server.inject({
          method: "POST",
          url: "/api/worker/claim",
          headers: { authorization: "Bearer signed" },
          payload: { requestId: request.id, runId: 901 },
        })
      ).statusCode,
    ).toBe(425);
  });
  it("revokes a minted token if cancellation arrives during its creation", async () => {
    const { server, service, verify, token, revoke } = await make();
    const request = job({ state: "dispatching", worker, remoteRunId: 901 });
    service.save(request);
    verify.mockResolvedValue(claims(request));
    token.mockImplementation(async () => {
      service.save({ ...request, state: "cancelling" });
      return "revoked-after-race";
    });
    expect(
      (
        await server.inject({
          method: "POST",
          url: "/api/worker/claim",
          headers: { authorization: "Bearer signed" },
          payload: { requestId: request.id, runId: 901 },
        })
      ).statusCode,
    ).toBe(409);
    expect(revoke).toHaveBeenCalledWith("revoked-after-race");
  });
  it("does not permit project execution when source-token revocation fails", async () => {
    const { server, service, verify, revoke, store } = await make();
    const request = job({ state: "dispatching", worker, remoteRunId: 901 });
    service.save(request);
    verify.mockResolvedValue(claims(request));
    const call = {
      method: "POST" as const,
      headers: { authorization: "Bearer signed" },
      payload: { requestId: request.id, runId: 901 },
    };
    await server.inject({ ...call, url: "/api/worker/claim" });
    revoke.mockRejectedValue(new Error("Network unavailable"));
    expect(
      (await server.inject({ ...call, url: "/api/worker/prepared" }))
        .statusCode,
    ).toBe(500);
    expect(store.get("job", request.id, jobSchema)?.preparedAt).toBeNull();
  });
});
