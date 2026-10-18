import { stringify } from "yaml";
import { vi } from "vitest";
import {
  defaultRoutePolicy,
  type NativeRepository,
} from "../src/shared/native.js";
import { demandLabel, workflowJobs } from "../src/server/native-inventory.js";
import { nativeWorkerWorkflow } from "../src/server/native-worker.js";
import { executionFixture, sourceSha, worker } from "./execution-fixtures.js";
import { response } from "./fixtures.js";

export const workflowPath = ".github/workflows/ci.yml";
export const workflowContent = stringify({
  name: "CI",
  on: ["push"],
  jobs: {
    test: {
      name: "Tests",
      "runs-on": [
        "buildferry",
        `${demandLabel(workflowPath, "test", "${{ github.run_id }}", "${{ github.run_attempt }}")}--${"${{ strategy.job-index || 0 }}"}`,
      ],
      "timeout-minutes": 10,
      steps: [{ run: "npm test" }],
    },
    release: {
      needs: ["test"],
      "runs-on": "ubuntu-24.04",
      environment: "Production",
      steps: [{ run: "echo protected" }],
    },
  },
});
export const nativeRepository: NativeRepository = {
  id: 101,
  repository: "owner/source",
  installationId: 201,
  defaultBranch: "main",
  headSha: sourceSha,
  private: true,
  refreshedAt: Date.now(),
  error: null,
  workflows: [
    {
      id: 51,
      path: workflowPath,
      name: "CI",
      sha: sourceSha,
      jobs: workflowJobs(workflowContent, workflowPath),
      enabled: true,
      policy: { ...defaultRoutePolicy, maxMinutes: 10 },
      overrides: {},
      error: null,
    },
  ],
};

export async function nativeFixture() {
  const app = await executionFixture();
  app.store.put("native-repository", "101", nativeRepository);
  const nativeWorker = { ...worker, nativeSha: worker.sha };
  app.ref.mockImplementation(async (repository) =>
    repository === worker.repository ? worker.sha : sourceSha,
  );
  app.store.put("worker", "1", nativeWorker);
  vi.spyOn(app.native.service.inventory, "content").mockResolvedValue({
    content: workflowContent,
    sha: sourceSha,
  });
  const job = {
    id: 701,
    run_id: 601,
    run_attempt: 1,
    head_sha: sourceSha,
    name: "Tests",
    status: "queued",
    conclusion: null as string | null,
    labels: ["buildferry", `${demandLabel(workflowPath, "test", 601, 1)}--0`],
    runner_id: 0,
    html_url: "https://github.com/owner/source/actions/runs/601/job/701",
  };
  const source = {
    id: 601,
    workflow_id: 51,
    run_attempt: 1,
    head_sha: sourceSha,
    event: "push",
    path: workflowPath,
    display_title: "CI",
    status: "in_progress",
    conclusion: null as string | null,
    created_at: new Date().toISOString(),
    html_url: "https://github.com/owner/source/actions/runs/601",
    actor: { id: 1, login: "owner" },
    repository: { id: 101 },
    head_repository: { id: 101 },
  };
  const host = {
    id: 901,
    run_attempt: 1,
    head_sha: worker.sha,
    event: "workflow_dispatch",
    path: `.github/workflows/${nativeWorkerWorkflow}`,
    display_title: "",
    status: "in_progress",
    conclusion: null as string | null,
    created_at: new Date().toISOString(),
    html_url: "https://github.com/owner/buildferry-ci/actions/runs/901",
    actor: { id: 601, login: "buildferry-test[bot]" },
    repository: { id: 301 },
  };
  const state = {
    job,
    source,
    host,
    loseDispatch: false,
    dispatches: 0,
    cancellations: [] as string[],
    jitRequests: 0,
  };
  vi.mocked(app.fetcher).mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.includes("/check-runs"))
      throw new Error("Native routing must not write source checks");
    if (url.endsWith("/owner/source/actions/jobs/701"))
      return response(state.job);
    if (url.endsWith("/owner/source/actions/runs/601"))
      return response(state.source);
    if (url.includes("/owner/source/actions/runs?status="))
      return response({ workflow_runs: [] });
    if (url.endsWith("/dispatches")) {
      state.dispatches++;
      const body = JSON.parse(String(init?.body)) as {
        inputs: { request_id: string };
      };
      state.host.display_title = `buildferry-native:${body.inputs.request_id}`;
      if (state.loseDispatch) throw new Error("Lost accepted response");
      return response({ workflow_run_id: 901 }, 201);
    }
    if (url.endsWith("/owner/buildferry-ci/actions/runs/901"))
      return response(state.host);
    if (url.includes(`${nativeWorkerWorkflow}/runs?`))
      return response({ workflow_runs: [state.host] });
    if (url.endsWith("/attempts/1/jobs?per_page=100"))
      return response({
        total_count: 1,
        jobs: [
          {
            name: "BuildFerry native host",
            status: "completed",
            conclusion: state.host.conclusion,
            run_attempt: 1,
            started_at: new Date(Date.now() - 60_000).toISOString(),
            completed_at: new Date().toISOString(),
          },
        ],
      });
    if (url.endsWith("/generate-jitconfig")) {
      state.jitRequests++;
      return response(
        { runner: { id: 903 }, encoded_jit_config: "aGVsbG8=" },
        201,
      );
    }
    if (url.includes("/actions/runners?"))
      return response({ total_count: 0, runners: [] });
    if (url.endsWith("/cancel")) {
      state.cancellations.push(url);
      return new Response(null, { status: 202 });
    }
    throw new Error(`Unhandled fixture request: ${url}`);
  });
  const enqueue = () => app.native.service.receive(101, 701);
  const claims = {
    repository_id: "301",
    repository_owner_id: "1",
    run_id: "901",
    run_attempt: "1" as const,
    sha: worker.sha,
    workflow_sha: worker.sha,
    ref: `refs/tags/buildferry-native-${worker.sha}`,
    workflow_ref: `${worker.repository}/.github/workflows/${nativeWorkerWorkflow}@refs/tags/buildferry-native-${worker.sha}`,
    event_name: "workflow_dispatch" as const,
    runner_environment: "github-hosted" as const,
  };
  app.verify.mockResolvedValue(claims);
  return { ...app, state, enqueue, claims, nativeWorker };
}
