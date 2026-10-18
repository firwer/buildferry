import { afterEach, describe, expect, it, vi } from "vitest";
import {
  nativeFixture,
  nativeRepository,
  workflowContent,
  workflowPath,
} from "./native-fixtures.js";
import { nativeRepositorySchema } from "../src/shared/native.js";
import { response } from "./fixtures.js";
import { sourceSha, worker } from "./execution-fixtures.js";

const apps: Awaited<ReturnType<typeof nativeFixture>>[] = [];
async function make() {
  const app = await nativeFixture();
  apps.push(app);
  const inventory = app.native.service.inventory;
  vi.spyOn(inventory.github, "jwt").mockResolvedValue("app-jwt");
  vi.spyOn(inventory.github, "token").mockResolvedValue("source-token");
  vi.spyOn(inventory.github, "revoke").mockResolvedValue();
  vi.spyOn(inventory.github, "ref").mockResolvedValue(sourceSha);
  const repository = {
    id: 101,
    full_name: "owner/source",
    private: true,
    archived: false,
    disabled: false,
    default_branch: "main",
    owner: { id: 1, login: "owner" },
  };
  vi.spyOn(inventory.github, "repository").mockResolvedValue(repository);
  const state = {
    inaccessible: false,
    failWorkflow: false,
    removed: false,
    files: [workflowContent],
  };
  vi.mocked(inventory.content).mockImplementation(async () => {
    if (state.failWorkflow) throw new Error("file unavailable");
    return { content: state.files[0]!, sha: sourceSha };
  });
  vi.mocked(app.fetcher).mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.includes("/app/installations?")) return response([{ id: 201 }]);
    if (url.includes("/access_tokens"))
      return response({ token: "installation-token" });
    if (url.includes("/installation/repositories?")) {
      return response({
        total_count: state.removed ? 0 : 2,
        repositories: state.removed
          ? []
          : [
              repository,
              {
                ...repository,
                id: worker.repositoryId,
                full_name: worker.repository,
              },
            ],
      });
    }
    if (url.includes("/actions/workflows?")) {
      if (state.inaccessible) throw new Error("offline");
      expect(init?.headers).toMatchObject({
        Authorization: "Bearer source-token",
      });
      return response({
        total_count: 1,
        workflows: [
          { id: 51, path: workflowPath, name: "CI", state: "active" },
        ],
      });
    }
    throw new Error(url);
  });
  return { ...app, inventory, state };
}
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.server.close()));
  vi.restoreAllMocks();
});

describe("actual GitHub workflow discovery", () => {
  it("discovers installed repositories, excludes workers, and retains configured overrides", async () => {
    const app = await make();
    app.store.put("native-repository", "101", {
      ...nativeRepository,
      workflows: nativeRepository.workflows.map((workflow) => ({
        ...workflow,
        overrides: { test: { providers: ["github"] } },
      })),
    });
    const list = await app.inventory.refresh();
    expect(list).toHaveLength(1);
    expect(list[0]?.workflows[0]).toMatchObject({
      enabled: true,
      error: null,
      overrides: { test: { providers: ["github"] } },
    });
    expect(app.inventory.github.revoke).toHaveBeenCalledWith(
      "installation-token",
    );
    expect(app.inventory.github.revoke).toHaveBeenCalledWith("source-token");
  });
  it("retains repository and history but stops admitting jobs after access is removed", async () => {
    const app = await make();
    app.state.removed = true;
    const list = await app.inventory.refresh();
    expect(list[0]).toMatchObject({
      error: "GitHub App access was removed.",
      refreshedAt: 0,
    });
    expect(list[0]?.workflows).toHaveLength(1);
  });
  it("shows workflow failures and recovers without dropping settings", async () => {
    const app = await make();
    app.state.failWorkflow = true;
    expect(
      (await app.inventory.refreshRepository(101)).workflows[0],
    ).toMatchObject({ enabled: true, jobs: [], error: expect.any(String) });
    app.state.failWorkflow = false;
    expect(
      (await app.inventory.refreshRepository(101)).workflows[0],
    ).toMatchObject({ enabled: true, error: null });
  });
  it("records access failures and revokes tokens even when refresh fails", async () => {
    const app = await make();
    app.state.inaccessible = true;
    const list = await app.inventory.refresh();
    expect(list[0]?.error).toContain("Workflow access");
    expect(app.inventory.github.revoke).toHaveBeenCalledWith("source-token");
    expect(
      app.store.get("native-repository", "101", nativeRepositorySchema)
        ?.workflows,
    ).toHaveLength(1);
  });
  it("requires administrator authentication for discovery and worker setup", async () => {
    const app = await make();
    for (const url of [
      "/api/native/refresh",
      "/api/native/repositories/101/refresh",
      "/api/native/accounts/1/worker",
    ]) {
      expect(
        (
          await app.server.inject({
            method: "POST",
            url,
            headers: { origin: app.config.publicUrl },
          })
        ).statusCode,
      ).toBe(401);
    }
  });
});
