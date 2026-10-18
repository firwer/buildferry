import { afterEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import {
  executionFixture,
  job,
  project,
  worker,
  sourceSha,
  workerSha,
} from "./execution-fixtures.js";
import { response } from "./fixtures.js";
import { accountSchema } from "../src/shared/contracts.js";
import { workerFiles } from "../src/server/worker-template.js";

const apps: Awaited<ReturnType<typeof executionFixture>>[] = [];
async function make() {
  const app = await executionFixture();
  apps.push(app);
  vi.spyOn(app.service.credentials, "token").mockResolvedValue(
    "owner-user-token",
  );
  vi.spyOn(app.service.github, "installation").mockResolvedValue({
    id: 401,
    app_id: 10,
  });
  const repository = vi
    .spyOn(app.service.github, "repository")
    .mockResolvedValue({
      id: worker.repositoryId,
      full_name: worker.repository,
      private: true,
      archived: false,
      disabled: false,
      default_branch: "main",
      owner: { id: 1, login: "owner" },
    });
  return { ...app, repository };
}
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.server.close()));
  vi.restoreAllMocks();
});

describe("owner-approved worker provisioning", () => {
  it("does not allow an installed worker repository to become a source workload", async () => {
    const { service } = await make();
    await expect(
      service.connectProject(
        { repository: worker.repository, recipe: project.recipe },
        1,
      ),
    ).rejects.toThrow("separate from the dedicated CI worker");
  });
  it("updates only the account owner's explicit workload approvals for an existing worker", async () => {
    const { service, fetcher } = await make();
    expect((await service.provisionWorker(1, [])).allowedProjects).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
    await expect(
      service.provisionWorker(1, [crypto.randomUUID()]),
    ).rejects.toThrow("connected project");
  });
  it("rejects source repositories, public repositories, and accounts without a worker choice", async () => {
    const { service, store, repository } = await make();
    const metadata = await repository.getMockImplementation()?.("", "");
    if (!metadata) throw new Error("Missing fixture metadata");
    repository.mockResolvedValueOnce({ ...metadata, private: false });
    await expect(service.provisionWorker(1, [project.id])).rejects.toThrow(
      "private repository",
    );
    repository.mockResolvedValueOnce({ ...metadata, id: project.repositoryId });
    await expect(service.provisionWorker(1, [project.id])).rejects.toThrow(
      "source project",
    );
    const account = store.get("account", "1", accountSchema);
    if (!account) throw new Error("Missing fixture account");
    store.put("account", "1", {
      ...account,
      settings: { ...account.settings, workerRepository: "" },
    });
    await expect(service.provisionWorker(1, [])).rejects.toThrow(
      "Choose your dedicated",
    );
  });
  it("never overwrites repositories with previous workflows or runs", async () => {
    const { service, store, fetcher } = await make();
    store.remove("worker", "1");
    vi.mocked(fetcher).mockImplementation(async () =>
      response({ total_count: 1 }),
    );
    await expect(service.provisionWorker(1, [])).rejects.toThrow(
      "Existing CI repositories will not be modified",
    );
    expect(
      vi.mocked(fetcher).mock.calls.every(([, init]) => init?.method === "GET"),
    ).toBe(true);
  });
  it("refuses worker changes while capacity is active", async () => {
    const { service } = await make();
    service.save(job({ state: "running", worker, accountId: 1 }));
    await expect(service.provisionWorker(1, [])).rejects.toThrow(
      "running jobs",
    );
  });
  it("atomically installs built launchers and pins the revision on a fresh dedicated repository", async () => {
    const { service, store, fetcher } = await make();
    store.remove("worker", "1");
    vi.mocked(fetcher).mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes("/actions/")) return response({ total_count: 0 });
      if (url.includes("/git/commits/") && init?.method === "GET")
        return response({ tree: { sha: sourceSha } });
      if (url.endsWith("/git/trees")) return response({ sha: sourceSha });
      if (url.endsWith("/git/commits")) return response({ sha: workerSha });
      if (url.includes("/git/refs")) return response({ ref: "accepted" });
      throw new Error("Unexpected fixture endpoint");
    });
    expect(await service.provisionWorker(1, [project.id])).toMatchObject({
      sha: workerSha,
      ready: true,
      allowedProjects: [project.id],
    });
    const mutations = vi
      .mocked(fetcher)
      .mock.calls.filter(([, init]) => init?.method !== "GET");
    expect(mutations).toHaveLength(4);
    const refUpdate = mutations.find(([, init]) => init?.method === "PATCH");
    expect(JSON.parse(String(refUpdate?.[1]?.body))).toEqual({
      sha: workerSha,
      force: false,
    });
  });
  it("ships no management secrets and preserves audit evidence before project commands", () => {
    const files = workerFiles("https://buildferry.example");
    const workflow = parse(files[0]?.content ?? "") as {
      permissions: object;
      jobs: { execute: { permissions: object; steps: { name: string }[] } };
    };
    expect(workflow.permissions).toEqual({});
    expect(workflow.jobs.execute.permissions).toEqual({
      contents: "read",
      "id-token": "write",
    });
    expect(
      workflow.jobs.execute.steps.map((step) => step.name).slice(-3),
    ).toEqual([
      "Prepare immutable source",
      "Preserve checkout audit",
      "Run approved recipe",
    ]);
    expect(files.map((file) => file.content).join("\n")).not.toContain(
      "owner-user-token",
    );
    expect(files.map((file) => file.path)).toContain(".buildferry/prepare.mjs");
  });
  it("connects independent workloads on the same repository under distinct names", async () => {
    const { service, repository } = await make();
    const metadata = await repository.getMockImplementation()?.("", "");
    if (!metadata) throw new Error("Missing metadata");
    repository.mockResolvedValue({
      ...metadata,
      id: project.repositoryId,
      full_name: project.repository,
    });
    await expect(
      service.connectProject(
        { repository: project.repository, recipe: project.recipe },
        1,
      ),
    ).rejects.toThrow("already has a workload");
    expect(
      await service.connectProject(
        {
          repository: project.repository,
          recipe: { ...project.recipe, name: "Independent tests" },
        },
        1,
      ),
    ).toMatchObject({
      repositoryId: project.repositoryId,
      recipe: { name: "Independent tests" },
    });
  });
});
