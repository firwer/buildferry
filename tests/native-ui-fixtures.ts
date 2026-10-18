import type { SessionView } from "../src/shared/contracts.js";
import type { Worker } from "../src/shared/execution.js";
import {
  defaultRoutePolicy,
  type NativeDashboard,
  type NativeLease,
  type NativeRepository,
  type NativeWorkflow,
} from "../src/shared/native.js";

export const githubBase = "https:" + "//" + "github.com/";
export const nativeSha = "a".repeat(40);
export const launcherSha = "b".repeat(40);

export const nativeSession: SessionView = {
  stage: "dashboard",
  demo: false,
  csrf: "native-csrf",
  user: { id: 1, login: "owner", role: "owner" },
  app: {
    slug: "buildferry-test",
    installUrl: githubBase + "settings/apps/buildferry-test/installations/new",
  },
  publicUrl: "https:" + "//" + "buildferry.example",
};

export const nativeWorker: Worker = {
  accountId: 1,
  repository: "owner/buildferry-ci",
  repositoryId: 301,
  installationId: 401,
  branch: "main",
  sha: launcherSha,
  ready: true,
  createdAt: 1_760_000_000_000,
  allowedProjects: [],
  nativeSha: launcherSha,
};

export const nativeWorkflow: NativeWorkflow = {
  id: 9001,
  name: "CI",
  path: ".github/workflows/ci.yml",
  sha: nativeSha,
  enabled: true,
  policy: {
    ...defaultRoutePolicy,
    providers: ["github", "ubicloud"],
  },
  overrides: {},
  error: null,
  jobs: [
    {
      key: "checkout",
      name: "Checkout",
      needs: [],
      runners: ["ubuntu-latest"],
      reusable: false,
      matrix: false,
      environment: null,
      maxMinutes: null,
      supported: true,
      reason: null,
      integrated: true,
    },
    {
      key: "build",
      name: "Build",
      needs: ["checkout"],
      runners: ["buildferry"],
      reusable: false,
      matrix: false,
      environment: "production",
      maxMinutes: 30,
      supported: true,
      reason: null,
      integrated: true,
    },
    {
      key: "windows",
      name: "Windows tests",
      needs: ["build"],
      runners: ["windows-latest"],
      reusable: false,
      matrix: true,
      environment: null,
      maxMinutes: null,
      supported: false,
      reason: "This job needs a different operating system or processor.",
      integrated: false,
    },
    {
      key: "reuse",
      name: "Reusable checks",
      needs: ["checkout"],
      runners: [],
      reusable: true,
      matrix: false,
      environment: null,
      maxMinutes: null,
      supported: false,
      reason: "Choose the jobs inside the called workflow.",
      integrated: false,
    },
  ],
};

export const nativeRepository: NativeRepository = {
  id: 101,
  repository: "owner/source",
  installationId: 201,
  defaultBranch: "main",
  headSha: nativeSha,
  private: true,
  refreshedAt: 1_760_000_000_000,
  workflows: [nativeWorkflow],
  error: null,
};

export function nativeRun(overrides: Partial<NativeLease> = {}): NativeLease {
  return {
    id: "2f7d56b4-2cef-4d3d-8bdd-a83c72cb4db5",
    repositoryId: 101,
    workflowId: 9001,
    workflowPath: ".github/workflows/ci.yml",
    jobKey: "build",
    jobName: "Build",
    sourceJobId: 51,
    sourceRunId: 501,
    attempt: 1,
    sourceSha: nativeSha,
    labels: ["buildferry", "ubuntu-latest"],
    policy: nativeWorkflow.policy,
    state: "running",
    sourceConclusion: null,
    createdAt: 1_760_000_000_000,
    updatedAt: 1_760_000_005_000,
    deadline: 1_760_000_600_000,
    accountId: 1,
    providerId: null,
    runner: "ubicloud-standard-4",
    worker: nativeWorker,
    remoteRunId: 7001,
    runnerId: 8001,
    submittedAt: 1_760_000_001_000,
    jitRequestedAt: 1_760_000_001_500,
    claimedAt: 1_760_000_002_000,
    period: "2026-10",
    reservedMinutes: 20,
    actualMinutes: null,
    reservedMicros: 0,
    actualMicros: null,
    cancellationConfirmed: false,
    message: "Running on the assigned worker.",
    sourceUrl: githubBase + "owner/source/actions/runs/501",
    hostUrl: null,
    ...overrides,
  };
}

export function nativeDashboardFixture(): NativeDashboard {
  return structuredClone({
    repositories: [nativeRepository],
    runs: [nativeRun()],
    workers: [nativeWorker],
  });
}
