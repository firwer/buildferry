import { randomUUID } from "node:crypto";
import { vi } from "vitest";
import { fixture, projectId as providerId, sampleApp } from "./fixtures.js";
import { newAccount } from "../src/server/auth.js";
import { currentPeriod } from "../src/server/routing.js";
import { recipeHash } from "../src/server/execution-service.js";
import type { Project, Job, Worker } from "../src/shared/execution.js";
import type { WorkerClaims } from "../src/server/worker-identity.js";

export const sourceSha = "a".repeat(40);
export const workerSha = "b".repeat(40);
export const project: Project = {
  id: randomUUID(),
  repository: "owner/source",
  repositoryId: 101,
  ownerId: 1,
  installationId: 201,
  defaultBranch: "main",
  recipe: {
    name: "Build",
    directory: ".",
    commands: ["npm ci", "npm test"],
    maxMinutes: 10,
    memoryGiB: 8,
    maxCostMicros: 0,
  },
  onPush: false,
  enabled: true,
  createdAt: Date.now(),
  updatedAt: Date.now(),
};
export const worker: Worker = {
  accountId: 1,
  repository: "owner/buildferry-ci",
  repositoryId: 301,
  installationId: 401,
  branch: "main",
  sha: workerSha,
  ready: true,
  createdAt: Date.now(),
  allowedProjects: [project.id],
};
export function job(overrides: Partial<Job> = {}): Job {
  return {
    id: randomUUID(),
    projectId: project.id,
    sourceSha,
    recipe: project.recipe,
    recipeHash: recipeHash(project.recipe),
    state: "queued",
    priority: 3,
    route: "auto",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    deadline: Date.now() + 60_000,
    accountId: null,
    providerId: null,
    runner: null,
    worker: null,
    remoteRunId: null,
    checkId: 501,
    checkSubmittedAt: Date.now(),
    outcome: null,
    period: currentPeriod(),
    reservedMinutes: 0,
    actualMinutes: null,
    reservedMicros: 0,
    actualMicros: null,
    bootstrapAt: null,
    submittedAt: null,
    preparedAt: null,
    finishedAt: null,
    queueSeconds: null,
    commandSeconds: null,
    message: "Waiting",
    url: null,
    cancellationConfirmed: false,
    ...overrides,
  };
}
export function claims(job: Job): WorkerClaims {
  return {
    repository_id: String(worker.repositoryId),
    repository_owner_id: "1",
    run_id: String(job.remoteRunId),
    run_attempt: "1",
    sha: workerSha,
    workflow_sha: workerSha,
    workflow_ref: `${worker.repository}/.github/workflows/buildferry-worker.yml@refs/tags/buildferry-worker-${workerSha}`,
    ref: `refs/tags/buildferry-worker-${workerSha}`,
    event_name: "workflow_dispatch",
    runner_environment: "github-hosted",
  };
}
export async function executionFixture() {
  const verify = vi.fn<(token: string) => Promise<WorkerClaims>>();
  const app = await fixture({ signedIn: true, verifyWorkerIdentity: verify });
  app.store.setSecret("github-app", sampleApp);
  app.store.put("project", project.id, project);
  app.store.put("worker", "1", worker);
  const account = newAccount(1, "owner", "owner");
  account.settings = {
    ...account.settings,
    allowanceConfirmed: true,
    workerRepository: "buildferry-ci",
    reserveMinutes: 100,
    contributionMinutes: 1000,
  };
  app.store.put("account", "1", {
    ...account,
    usedMinutes: 0,
    verifiedAt: Date.now(),
    repositoryVerified: true,
  });
  const { service } = app.execution;
  const token = vi
    .spyOn(service.github, "token")
    .mockResolvedValue("installation-token");
  const ref = vi.spyOn(service.github, "ref").mockResolvedValue(sourceSha);
  const bot = vi.spyOn(service.github, "botId").mockResolvedValue(601);
  const revoke = vi.spyOn(service.github, "revoke").mockResolvedValue();
  return { ...app, service, verify, token, ref, bot, revoke, providerId };
}
