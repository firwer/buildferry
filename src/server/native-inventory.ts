import { createHash } from "node:crypto";
import { parseDocument } from "yaml";
import { z } from "zod";
import {
  defaultRoutePolicy,
  nativeRepositorySchema,
  nativeWorkflowSchema,
  type NativeRepository,
  type NativeWorkflow,
} from "../shared/native.js";
import { shaSchema, workerSchema } from "../shared/execution.js";
import { AppGitHub, repositoryDetailSchema } from "./providers/app-github.js";
import { type Context, HttpError } from "./context.js";

const jobInputSchema = z.object({
  name: z.string().optional(),
  needs: z.union([z.string(), z.array(z.string())]).optional(),
  "runs-on": z
    .union([z.string(), z.array(z.string()), z.record(z.string(), z.unknown())])
    .optional(),
  uses: z.string().optional(),
  strategy: z.object({ matrix: z.unknown().optional() }).optional(),
  environment: z.union([z.string(), z.object({ name: z.string() })]).optional(),
  "timeout-minutes": z
    .union([z.number().int().positive(), z.string()])
    .optional(),
});
const workflowInputSchema = z.object({
  jobs: z.record(z.string(), jobInputSchema),
});
const fileSchema = z.object({
  encoding: z.literal("base64"),
  content: z.string(),
  sha: shaSchema,
});
const workflowListSchema = z.object({
  total_count: z.number().int().nonnegative(),
  workflows: z.array(
    z.object({
      id: z.number().int().positive(),
      name: z.string(),
      path: z.string(),
      state: z.string(),
    }),
  ),
});

/** A workflow-path identity prevents equal job keys in reusable workflows sharing one runner pool. */
export const workflowKey = (path: string) =>
  createHash("sha256").update(path).digest("hex").slice(0, 12);
export function demandLabel(
  path: string,
  jobKey: string,
  runId: string | number,
  attempt: string | number,
): string {
  return `buildferry-${runId}-${attempt}-${workflowKey(path)}-${jobKey}`;
}

function jobReason(
  reusable: boolean,
  incompatible: boolean,
  dedicated: boolean,
  hasRunner: boolean,
): string | null {
  if (reusable) return "Choose the jobs inside the called workflow.";
  if (incompatible)
    return "This job needs a different operating system or processor.";
  if (dedicated)
    return "This job uses a dedicated machine. Keep its existing runner.";
  if (!hasRunner) return "This job has no runner to configure.";
  return null;
}

/** Read only job metadata; GitHub remains the interpreter for steps, expressions and dependencies. */
export function workflowJobs(
  content: string,
  path: string,
): NativeWorkflow["jobs"] {
  const document = parseDocument(content, { uniqueKeys: true });
  if (document.errors.length)
    throw new HttpError(422, "GitHub's workflow file could not be read.");
  const workflow = workflowInputSchema.parse(
    document.toJS({ maxAliasCount: 0 }),
  );
  return Object.entries(workflow.jobs).map(([key, job]) => {
    const runners =
      typeof job["runs-on"] === "string" ? [job["runs-on"]] : job["runs-on"];
    const labels = Array.isArray(runners) ? runners : [];
    const reusable = Boolean(job.uses);
    const incompatible = labels.some((label) =>
      /windows|macos|arm64|\bARM\b/i.test(label),
    );
    const dedicated =
      labels.includes("self-hosted") && !labels.includes("buildferry");
    const supported =
      !reusable && !incompatible && !dedicated && Boolean(runners);
    return {
      key,
      name: job.name ?? key,
      needs: typeof job.needs === "string" ? [job.needs] : (job.needs ?? []),
      runners: labels,
      reusable,
      matrix: job.strategy?.matrix !== undefined,
      environment:
        typeof job.environment === "string"
          ? job.environment
          : (job.environment?.name ?? null),
      maxMinutes:
        typeof job["timeout-minutes"] === "number"
          ? job["timeout-minutes"]
          : null,
      supported,
      reason: jobReason(reusable, incompatible, dedicated, Boolean(runners)),
      integrated:
        (labels.includes("buildferry") &&
          labels.some((label) =>
            label.startsWith(
              `buildferry-${"${{ github.run_id }}"}-${"${{ github.run_attempt }}"}-${workflowKey(path)}-${key}`,
            ),
          )) ||
        labels.some(
          (label) =>
            label.includes(
              `["buildferry","buildferry-{0}-{1}-${workflowKey(path)}-${key}--{2}"]`,
            ) &&
            label.includes("github.run_id") &&
            label.includes("github.run_attempt") &&
            label.includes("strategy.job-index"),
        ),
    };
  });
}

export class NativeInventory {
  readonly github: AppGitHub;
  constructor(readonly context: Context) {
    this.github = new AppGitHub(context);
  }
  repositories(): NativeRepository[] {
    return this.context.store.list("native-repository", nativeRepositorySchema);
  }

  async refresh(): Promise<NativeRepository[]> {
    const installations: { id: number }[] = [];
    for (let page = 1; page <= 100; page++) {
      const batch = await this.github.request(
        "GET",
        `/app/installations?per_page=100&page=${page}`,
        await this.github.jwt(),
        z.array(z.object({ id: z.number().int().positive() })),
      );
      installations.push(...batch);
      if (batch.length < 100) break;
      if (page === 100)
        throw new HttpError(
          422,
          "Too many GitHub installations to load safely.",
        );
    }
    const found = new Set<number>();
    const workers = this.context.store.list("worker", workerSchema);
    for (const installation of installations) {
      for (const id of await this.refreshInstallation(installation.id, workers))
        found.add(id);
    }
    // Retain history for removed access, but stop admitting its jobs immediately.
    for (const repository of this.repositories())
      if (!found.has(repository.id))
        this.context.store.put("native-repository", String(repository.id), {
          ...repository,
          error: "GitHub App access was removed.",
          refreshedAt: 0,
        });
    return this.repositories();
  }

  private async refreshInstallation(
    installationId: number,
    workers: z.infer<typeof workerSchema>[],
  ): Promise<Set<number>> {
    const found = new Set<number>();
    const token = await this.github.request(
      "POST",
      `/app/installations/${installationId}/access_tokens`,
      await this.github.jwt(),
      z.object({ token: z.string() }),
      { permissions: { contents: "read", actions: "read" } },
    );
    try {
      for (let page = 1; page <= 100; page++) {
        const batch = await this.github.request(
          "GET",
          `/installation/repositories?per_page=100&page=${page}`,
          token.token,
          z.object({
            total_count: z.number(),
            repositories: z.array(repositoryDetailSchema),
          }),
        );
        for (const repository of batch.repositories) {
          if (
            repository.archived ||
            repository.disabled ||
            workers.some((worker) => worker.repositoryId === repository.id)
          )
            continue;
          found.add(repository.id);
          await this.refreshDiscovered(repository, installationId);
        }
        if (page * 100 >= batch.total_count) break;
        if (page === 100)
          throw new HttpError(422, "Too many repositories to load safely.");
      }
    } finally {
      await this.github.revoke(token.token);
    }

    return found;
  }

  private async refreshDiscovered(
    repository: z.infer<typeof repositoryDetailSchema>,
    installationId: number,
  ): Promise<void> {
    const existing = this.context.store.get(
      "native-repository",
      String(repository.id),
      nativeRepositorySchema,
    );
    const initial: NativeRepository = existing ?? {
      id: repository.id,
      repository: repository.full_name,
      installationId: installationId,
      defaultBranch: repository.default_branch,
      headSha: "0".repeat(40),
      private: repository.private,
      refreshedAt: 0,
      workflows: [],
      error: null,
    };
    this.context.store.put("native-repository", String(repository.id), {
      ...initial,
      repository: repository.full_name,
      installationId: installationId,
      defaultBranch: repository.default_branch,
    });
    try {
      await this.refreshRepository(repository.id);
    } catch {
      this.context.store.put("native-repository", String(repository.id), {
        ...(this.context.store.get(
          "native-repository",
          String(repository.id),
          nativeRepositorySchema,
        ) ?? initial),
        error:
          "Workflow access could not be refreshed. Check the GitHub App connection.",
        refreshedAt: 0,
      });
    }
  }

  async content(
    repository: NativeRepository,
    path: string,
    ref: string,
    token: string,
  ): Promise<{ content: string; sha: string }> {
    if (!/^\.github\/workflows\/[a-zA-Z0-9_.-]+\.ya?ml$/.test(path))
      throw new HttpError(422, "This workflow path is not supported.");
    const file = await this.github.request(
      "GET",
      `/repos/${repository.repository}/contents/${path}?ref=${encodeURIComponent(ref)}`,
      token,
      fileSchema,
    );
    const content = Buffer.from(file.content, "base64").toString("utf8");
    if (Buffer.byteLength(content) > 1_000_000)
      throw new HttpError(422, "This workflow file is too large to load.");
    return { content, sha: file.sha };
  }

  async refreshRepository(id: number): Promise<NativeRepository> {
    const stored = this.context.store.get(
      "native-repository",
      String(id),
      nativeRepositorySchema,
    );
    if (!stored) throw new HttpError(404, "This repository is not connected.");
    const token = await this.github.token(stored.installationId, id, {
      contents: "read",
      actions: "read",
    });
    try {
      const metadata = await this.github.repository(stored.repository, token);
      if (metadata.id !== stored.id)
        throw new HttpError(409, "The repository identity changed.");
      const headSha = await this.github.ref(
        stored.repository,
        stored.defaultBranch,
        token,
      );
      const workflows: NativeWorkflow[] = [];
      for (let page = 1; page <= 100; page++) {
        const list = await this.github.request(
          "GET",
          `/repos/${stored.repository}/actions/workflows?per_page=100&page=${page}`,
          token,
          workflowListSchema,
        );
        for (const workflow of list.workflows) {
          if (!workflow.path.startsWith(".github/workflows/")) continue;
          const previous = stored.workflows.find(
            (value) => value.id === workflow.id && value.path === workflow.path,
          );
          const base = {
            id: workflow.id,
            name: workflow.name,
            path: workflow.path,
            enabled: previous?.enabled ?? false,
            policy: previous?.policy ?? defaultRoutePolicy,
            overrides: previous?.overrides ?? {},
            jobs: [],
            sha: headSha,
            error: null,
          };
          try {
            const file = await this.content(
              stored,
              workflow.path,
              headSha,
              token,
            );
            const jobs = workflowJobs(file.content, workflow.path);
            workflows.push(
              nativeWorkflowSchema.parse({
                ...base,
                sha: file.sha,
                jobs,
                policy: previous?.policy ?? {
                  ...defaultRoutePolicy,
                  maxMinutes: Math.min(
                    180,
                    Math.max(60, ...jobs.map((job) => job.maxMinutes ?? 60)),
                  ),
                },
              }),
            );
          } catch {
            workflows.push({
              ...base,
              error:
                "This workflow could not be read. Routing is paused for it.",
            });
          }
        }
        if (page * 100 >= list.total_count) break;
        if (page === 100)
          throw new HttpError(422, "Too many workflows to load safely.");
      }
      const current =
        this.context.store.get(
          "native-repository",
          String(id),
          nativeRepositorySchema,
        ) ?? stored;
      const updated: NativeRepository = {
        ...current,
        headSha,
        workflows: workflows.map((workflow) => {
          const latest = current.workflows.find(
            (value) => value.id === workflow.id,
          );
          return latest
            ? {
                ...workflow,
                enabled: latest.enabled,
                policy: latest.policy,
                overrides: latest.overrides,
              }
            : workflow;
        }),
        refreshedAt: Date.now(),
        error: null,
      };
      this.context.store.put("native-repository", String(id), updated);
      return updated;
    } finally {
      await this.github.revoke(token);
    }
  }
}
