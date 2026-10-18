import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import { z } from "zod";
import { workerSchema, type Worker } from "../shared/execution.js";
import type { ExecutionService } from "./execution-service.js";
import { createWorkerRepository } from "./worker-repository.js";
import { accountSchema } from "../shared/contracts.js";
import { HttpError } from "./context.js";
import { nativeLeaseSchema } from "../shared/native.js";
import { shaSchema } from "../shared/execution.js";
import { ProviderError } from "./providers/http.js";

const updateSchema = z.object({
  repositoryId: z.number(),
  before: shaSchema,
  next: shaSchema,
});

export const nativeWorkerWorkflow = "buildferry-native.yml";
export const nativeHostJobName = "BuildFerry native host";
export const runnerVersion = "2.338.0";
export const runnerChecksum =
  "af4b794c1bc41d73d40535e3fe092a39f9679cd8d965954c2aca25a05ca41d32";

/** The outer workflow supplies one disposable host; GitHub executes the original job on it. */
export function nativeWorkerFiles(publicUrl: string) {
  const workflow = {
    name: "BuildFerry native host",
    "run-name": "buildferry-native:${{ inputs.request_id }}",
    on: {
      workflow_dispatch: {
        inputs: {
          request_id: { required: true, type: "string" },
          runner: { required: true, type: "string" },
          max_minutes: { required: true, type: "string" },
        },
      },
    },
    permissions: {},
    jobs: {
      host: {
        name: nativeHostJobName,
        "runs-on": "${{ inputs.runner }}",
        "timeout-minutes": "${{ fromJSON(inputs.max_minutes) }}",
        permissions: { contents: "read", "id-token": "write" },
        env: {
          BUILDFERRY_URL: publicUrl,
          BUILDFERRY_REQUEST_ID: "${{ inputs.request_id }}",
        },
        steps: [
          {
            name: "Checkout pinned launcher",
            uses: "actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09",
            with: { "persist-credentials": false },
          },
          {
            name: "Setup Node",
            uses: "actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38",
            with: { "node-version": 24 },
          },
          {
            name: "Claim single-use runner",
            run: "node .buildferry/native-claim.mjs",
          },
          {
            name: "Run original GitHub job",
            run: "node .buildferry/native-run.mjs",
            env: {
              ACTIONS_ID_TOKEN_REQUEST_TOKEN: "",
              ACTIONS_ID_TOKEN_REQUEST_URL: "",
            },
          },
        ],
      },
    },
  };
  const helper = (name: string) =>
    readFileSync(
      path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "../../dist/worker",
        `${name}.js`,
      ),
      "utf8",
    );
  return [
    {
      path: `.github/workflows/${nativeWorkerWorkflow}`,
      content: stringify(workflow),
    },
    { path: ".buildferry/native-claim.mjs", content: helper("native-claim") },
    { path: ".buildferry/native-run.mjs", content: helper("native-run") },
  ].map((file) => ({
    ...file,
    mode: "100644" as const,
    type: "blob" as const,
  }));
}

/** Upgrade only the three launcher files, retaining the original recipe worker's immutable tag. */
export async function provisionNativeWorker(
  service: ExecutionService,
  accountId: number,
): Promise<Worker> {
  let account = service.context.store.get(
    "account",
    String(accountId),
    accountSchema,
  );
  if (!account) throw new HttpError(404, "This account is not connected.");
  if (!account.settings.workerRepository)
    account = await createWorkerRepository(service.context, accountId);
  let worker = service.context.store.get(
    "worker",
    String(accountId),
    workerSchema,
  );
  if (!worker) worker = await service.provisionWorker(accountId, []);
  if (
    worker.repository.toLowerCase() !==
    `${account.login}/${account.settings.workerRepository}`.toLowerCase()
  )
    throw new HttpError(
      409,
      "The worker selection changed. Set up the selected worker before updating its launcher.",
    );
  if (
    service.context.store
      .list("native-lease", nativeLeaseSchema)
      .some(
        (lease) =>
          lease.accountId === accountId && !lease.cancellationConfirmed,
      )
  )
    throw new HttpError(
      409,
      "Wait for this account's current runners before updating its launcher.",
    );
  const token = await service.credentials.token(accountId);
  const head = await service.github.ref(
    worker.repository,
    worker.branch,
    token,
  );
  const pending = service.context.store.get(
    "native-worker-update",
    String(accountId),
    updateSchema,
  );
  if (pending && pending.repositoryId !== worker.repositoryId)
    throw new HttpError(
      409,
      "A launcher update for another worker needs review.",
    );
  if (
    head !== (pending?.before ?? worker.nativeSha ?? worker.sha) &&
    head !== pending?.next
  )
    throw new HttpError(
      409,
      "The worker repository changed outside BuildFerry. Review it before updating the launcher.",
    );
  let nextSha = pending?.next;
  if (!nextSha) {
    const commit = await service.github.request(
      "GET",
      `/repos/${worker.repository}/git/commits/${head}`,
      token,
      z.object({ tree: z.object({ sha: z.string() }) }),
    );
    const tree = await service.github.request(
      "POST",
      `/repos/${worker.repository}/git/trees`,
      token,
      z.object({ sha: z.string() }),
      {
        base_tree: commit.tree.sha,
        tree: nativeWorkerFiles(service.context.config.publicUrl),
      },
    );
    const next = await service.github.request(
      "POST",
      `/repos/${worker.repository}/git/commits`,
      token,
      z.object({ sha: z.string() }),
      {
        message: "Install BuildFerry native runner launcher",
        tree: tree.sha,
        parents: [head],
      },
    );
    nextSha = shaSchema.parse(next.sha);
    service.context.store.put("native-worker-update", String(accountId), {
      repositoryId: worker.repositoryId,
      before: head,
      next: nextSha,
    });
  }
  // Record the immutable tag before advancing the branch. Unknown acceptance never forces a ref.
  await pinNativeTag(service, worker, nextSha, token);
  if (head !== nextSha)
    await service.github.request(
      "PATCH",
      `/repos/${worker.repository}/git/refs/heads/${encodeURIComponent(worker.branch)}`,
      token,
      z.object({ ref: z.string() }),
      { sha: nextSha, force: false },
    );
  const updated = { ...worker, nativeSha: nextSha };
  service.context.store.transaction(() => {
    service.context.store.put("worker", String(accountId), updated);
    service.context.store.remove("native-worker-update", String(accountId));
  });
  service.context.store.audit(
    `${account.login}'s native runner launcher was installed at a pinned revision.`,
  );
  return updated;
}

async function pinNativeTag(
  service: ExecutionService,
  worker: Worker,
  nextSha: string,
  token: string,
): Promise<void> {
  const tag = `buildferry-native-${nextSha}`;
  let exists = false;
  try {
    if ((await service.github.ref(worker.repository, tag, token)) !== nextSha)
      throw new HttpError(409, "The pinned native launcher tag changed.");
    exists = true;
  } catch (error) {
    if (!(error instanceof ProviderError && error.status === 404)) throw error;
  }
  if (!exists)
    await service.github.request(
      "POST",
      `/repos/${worker.repository}/git/refs`,
      token,
      z.object({ ref: z.string() }),
      { ref: `refs/tags/${tag}`, sha: nextSha },
    );
}
