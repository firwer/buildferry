import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  accountSchema,
  accountSettingsSchema,
  previewInputSchema,
  providerInputSchema,
  providerSchema,
  shardInputSchema,
  type Account,
} from "../shared/contracts.js";
import { Credentials } from "./auth.js";
import {
  HttpError,
  requireIdentity,
  requireOwner,
  type Context,
} from "./context.js";
import {
  candidatesFor,
  currentPeriod,
  planShards,
  previewRouting,
} from "./routing.js";
import { ProviderError } from "./providers/http.js";
import { verifyUbicloud } from "./providers/ubicloud.js";

function accountFrom(request: FastifyRequest, context: Context): Account {
  const { id } = z
    .object({ id: z.coerce.number().int().positive() })
    .parse(request.params);
  const account = context.store.get("account", String(id), accountSchema);
  if (!account) throw new HttpError(404, "This account is not connected.");
  return account;
}

async function refreshAccount(
  account: Account,
  context: Context,
  credentials: Credentials,
): Promise<Account> {
  const updated: Account = {
    ...account,
    verifiedAt: null,
    repositoryVerified: false,
    usedMinutes: null,
    period: currentPeriod(),
  };
  try {
    const token = await credentials.token(account.id);
    updated.usedMinutes = await context.github.usage(
      account.login,
      token,
      updated.period,
    );
    updated.verifiedAt = Date.now();
    if (account.settings.workerRepository) {
      await context.github.repository(
        account.login,
        account.id,
        account.settings.workerRepository,
        token,
      );
      updated.repositoryVerified = true;
    }
    updated.message = updated.repositoryVerified
      ? "Usage and private repository verified. Execution is not enabled."
      : "Usage verified. Select a private CI repository to preview this account.";
  } catch (error) {
    updated.verifiedAt = null;
    updated.usedMinutes = null;
    updated.message =
      error instanceof HttpError || error instanceof ProviderError
        ? error.message
        : "This connection could not be verified. Reconnect and try again.";
  }
  const current = context.store.get(
    "account",
    String(account.id),
    accountSchema,
  );
  if (!current)
    throw new HttpError(
      404,
      "This account was disconnected while verification was running.",
    );
  const repositoryUnchanged =
    current.settings.workerRepository === account.settings.workerRepository;
  const merged = {
    ...updated,
    settings: current.settings,
    repositoryVerified: repositoryUnchanged && updated.repositoryVerified,
  };
  context.store.put("account", String(account.id), merged);
  return merged;
}

export function registerApi(server: FastifyInstance, context: Context): void {
  const credentials = new Credentials(context);
  server.get("/api/dashboard", async (request) => {
    requireIdentity(request, context);
    const accounts = context.store.list("account", accountSchema);
    const providers = context.store.list("provider", providerSchema);
    return {
      accounts,
      providers,
      candidates: candidatesFor(accounts, providers),
      period: currentPeriod(),
      activity: context.store.activity(),
    };
  });
  server.put("/api/accounts/:id", async (request) => {
    const identity = requireIdentity(request, context);
    const account = accountFrom(request, context);
    if (account.id !== identity.id)
      throw new HttpError(
        403,
        "Only this account's owner can change its contribution.",
      );
    const settings = accountSettingsSchema.parse(request.body);
    const changed = {
      ...account,
      settings,
      repositoryVerified:
        settings.workerRepository === account.settings.workerRepository &&
        account.repositoryVerified,
    };
    context.store.put("account", String(account.id), changed);
    context.store.audit(
      `${identity.login} updated their account limits and priority.`,
    );
    return refreshAccount(changed, context, credentials);
  });
  server.post("/api/accounts/:id/refresh", async (request) => {
    const identity = requireIdentity(request, context);
    const account = accountFrom(request, context);
    if (account.id !== identity.id && identity.role !== "owner")
      throw new HttpError(
        403,
        "Only the account or instance owner can refresh this connection.",
      );
    return refreshAccount(account, context, credentials);
  });
  server.delete("/api/accounts/:id", async (request, reply) => {
    const identity = requireIdentity(request, context);
    const account = accountFrom(request, context);
    if (account.role === "owner")
      throw new HttpError(
        422,
        "Pause the instance owner's contribution instead of removing its sign-in.",
      );
    if (account.id !== identity.id && identity.role !== "owner")
      throw new HttpError(403, "You cannot remove another member.");
    context.store.transaction(() => {
      context.store.remove("account", String(account.id));
      context.store.deleteSecret(`github-user:${account.id}`);
      context.store.deleteIdentitySessions(account.id);
      context.store.audit(
        `${account.login} was disconnected. Stored access was removed.`,
      );
    });
    return reply.code(204).send();
  });
  server.post("/api/providers", async (request) => {
    requireOwner(request, context);
    const input = providerInputSchema.parse(request.body);
    const verified = await verifyUbicloud(
      input.projectId,
      input.token,
      context.fetcher,
    );
    const { token, ...settings } = input;
    const provider = { ...settings, ...verified, verifiedAt: Date.now() };
    context.store.transaction(() => {
      context.store.setSecret(`ubicloud:${input.projectId}`, { token });
      context.store.put("provider", input.projectId, provider);
      context.store.audit(
        `Ubicloud project ${verified.name} was connected for routing previews.`,
      );
    });
    return provider;
  });
  server.post("/api/providers/:id/refresh", async (request) => {
    requireOwner(request, context);
    const { id } = z
      .object({ id: providerInputSchema.shape.projectId })
      .parse(request.params);
    const stored = context.store.get("provider", id, providerSchema);
    const secret = context.store.secret(
      `ubicloud:${id}`,
      z.object({ token: z.string() }),
    );
    if (!stored || !secret)
      throw new HttpError(404, "This provider is not connected.");
    context.store.put("provider", id, { ...stored, verifiedAt: 0 });
    const verified = await verifyUbicloud(id, secret.token, context.fetcher);
    const current = context.store.get("provider", id, providerSchema);
    if (!current)
      throw new HttpError(
        404,
        "This provider was disconnected during verification.",
      );
    const updated = { ...current, ...verified, verifiedAt: Date.now() };
    context.store.put("provider", id, updated);
    return updated;
  });
  server.delete("/api/providers/:id", async (request, reply) => {
    requireOwner(request, context);
    const { id } = z
      .object({ id: providerInputSchema.shape.projectId })
      .parse(request.params);
    context.store.transaction(() => {
      context.store.remove("provider", id);
      context.store.deleteSecret(`ubicloud:${id}`);
    });
    return reply.code(204).send();
  });
  server.post("/api/routing/preview", async (request) => {
    requireIdentity(request, context);
    const input = previewInputSchema.parse(request.body);
    return previewRouting(
      candidatesFor(
        context.store.list("account", accountSchema),
        context.store.list("provider", providerSchema),
      ),
      input,
    );
  });
  server.post("/api/tests/plan", async (request) => {
    requireIdentity(request, context);
    return planShards(shardInputSchema.parse(request.body));
  });
}
