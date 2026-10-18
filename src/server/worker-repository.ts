import { randomUUID } from "node:crypto";
import { z } from "zod";
import { accountSchema, repositorySchema } from "../shared/contracts.js";
import { workerSchema } from "../shared/execution.js";
import { Credentials } from "./auth.js";
import { HttpError, type Context } from "./context.js";
import { AppGitHub, repositoryDetailSchema } from "./providers/app-github.js";
import { ProviderError } from "./providers/http.js";

const creationSchema = z.object({
  name: repositorySchema,
  marker: z.uuid(),
  repositoryId: z.number().int().positive().nullable(),
});
const createdRepositorySchema = repositoryDetailSchema.extend({
  description: z.string().nullable(),
});

/** Reconcile a lost creation response by a durable marker; never adopt an unrelated repository. */
export async function createWorkerRepository(
  context: Context,
  accountId: number,
) {
  const key = String(accountId);
  const account = context.store.get("account", key, accountSchema);
  if (!account) throw new HttpError(404, "This account is not connected.");
  const installed = context.store.get("worker", key, workerSchema);
  if (
    installed?.ready &&
    installed.repository.toLowerCase() ===
      `${account.login}/${account.settings.workerRepository}`.toLowerCase()
  )
    return account;
  const desiredName = account.settings.workerRepository || "buildferry-ci";
  const intentKey = `${key}:${desiredName}`;
  const intent = context.store.transaction(() => {
    const existing = context.store.get(
      "worker-repository",
      intentKey,
      creationSchema,
    );
    if (existing) return existing;
    const created = {
      name: desiredName,
      marker: randomUUID(),
      repositoryId: null,
    };
    context.store.put("worker-repository", intentKey, created);
    return created;
  });
  const token = await new Credentials(context).token(accountId);
  const owner = await context.github.user(token);
  if (
    owner.id !== accountId ||
    owner.login.toLowerCase() !== account.login.toLowerCase()
  )
    throw new HttpError(
      403,
      "Reconnect this GitHub account before creating its worker.",
    );
  const github = new AppGitHub(context);
  const name = `${account.login}/${intent.name}`;
  const description = `BuildFerry private worker (${intent.marker})`;
  let repository: z.infer<typeof createdRepositorySchema>;
  try {
    repository = await github.request(
      "GET",
      `/repos/${name}`,
      token,
      createdRepositorySchema,
    );
  } catch (error) {
    if (!(error instanceof ProviderError && error.status === 404)) throw error;
    if (intent.repositoryId !== null)
      throw new HttpError(
        409,
        "The worker repository was removed. Reconnect it before continuing.",
      );
    try {
      repository = await github.request(
        "POST",
        "/user/repos",
        token,
        createdRepositorySchema,
        {
          name: intent.name,
          description,
          private: true,
          auto_init: true,
          has_issues: false,
          has_projects: false,
          has_wiki: false,
        },
      );
    } catch (creationError) {
      if (
        creationError instanceof ProviderError &&
        creationError.status === 403
      )
        throw new HttpError(
          422,
          "Approve Repository creation in this account's GitHub App installation, then try again.",
        );
      throw creationError;
    }
  }
  if (
    repository.owner.id !== accountId ||
    !repository.private ||
    repository.archived ||
    repository.disabled ||
    repository.full_name.toLowerCase() !== name.toLowerCase() ||
    repository.description !== description ||
    (intent.repositoryId !== null && repository.id !== intent.repositoryId)
  )
    throw new HttpError(
      409,
      "A different repository already uses this name. Select an existing worker or choose another name in account settings.",
    );
  return context.store.transaction(() => {
    const current = context.store.get("account", key, accountSchema);
    if (!current)
      throw new HttpError(409, "This account was disconnected during setup.");
    if (
      current.settings.workerRepository &&
      current.settings.workerRepository !== intent.name
    )
      throw new HttpError(
        409,
        "The repository was created, but the account selection changed. Select it again to continue.",
      );
    const updated = {
      ...current,
      settings: { ...current.settings, workerRepository: intent.name },
      repositoryVerified: true,
      message:
        "Private worker repository created. Finish worker setup to run jobs.",
    };
    context.store.put("worker-repository", intentKey, {
      ...intent,
      repositoryId: repository.id,
    });
    context.store.put("account", key, updated);
    context.store.audit(
      `${account.login}'s private worker repository was created and verified.`,
    );
    return updated;
  });
}
