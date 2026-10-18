import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  accountSchema,
  accountSettingsSchema,
  previewInputSchema,
  providerInputSchema,
  providerSchema,
  providerSettingsSchema,
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

export async function refreshAccount(
  account: Account,
  context: Context,
  credentials: Credentials,
): Promise<Account> {
  const updated: Account = {
    ...account,
    verifiedAt: null,
    repositoryVerified: false,
    usedMinutes: null,
    workerUsedMinutes: null,
    period: currentPeriod(),
  };
  try {
    const token = await credentials.token(account.id);
    const usage = await context.github.usageReport(
      account.login,
      token,
      updated.period,
      account.settings.workerRepository || undefined,
    );
    updated.usedMinutes = usage.usedMinutes;
    updated.workerUsedMinutes = usage.workerUsedMinutes;
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
      ? "Usage and private repository verified."
      : "Usage verified. Set up this account's worker.";
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

/** Keep synthetic previews usable without relaxing freshness checks for real credentials. */
function capacitySnapshot(context: Context) {
  const now = Date.now();
  const period = currentPeriod(now);
  const accounts = context.store
    .list("account", accountSchema)
    .map((account) =>
      context.config.demo ? { ...account, period, verifiedAt: now } : account,
    );
  const providers = context.store
    .list("provider", providerSchema)
    .map((provider) =>
      context.config.demo ? { ...provider, verifiedAt: now } : provider,
    );
  return {
    accounts,
    providers,
    period,
    candidates: candidatesFor(accounts, providers, now),
  };
}

export function registerApi(server: FastifyInstance, context: Context): void {
  const credentials = new Credentials(context);
  server.get("/api/dashboard", async (request) => {
    requireIdentity(request, context);
    return {
      ...capacitySnapshot(context),
      activity: context.store.activity(),
    };
  });
  server.put("/api/accounts/:id", async (request) => {
    const identity = requireIdentity(request, context);
    const account = accountFrom(request, context);
    if (account.id !== identity.id && identity.role !== "owner")
      throw new HttpError(
        403,
        "Only this account's owner or the administrator can change its settings.",
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
      `${identity.login} updated ${account.login}'s account limits and priority${!settings.allowanceConfirmed ? "; monthly minutes need confirmation" : ""}.`,
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
        `Ubicloud project ${verified.name} was connected with a monthly spend limit.`,
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
  server.put("/api/providers/:id", async (request) => {
    requireOwner(request, context);
    const { id } = z
      .object({ id: providerInputSchema.shape.projectId })
      .parse(request.params);
    const settings = providerSettingsSchema.parse(request.body);
    const current = context.store.get("provider", id, providerSchema);
    if (!current) throw new HttpError(404, "This provider is not connected.");
    // Existing runs retain their runner and reserved rate; the monthly ledger is never reset.
    const updated = {
      ...current,
      ...settings,
      machineRates: settings.machineRates ?? [],
    };
    context.store.put("provider", id, updated);
    context.store.audit(
      `${current.name}'s default machine and spending settings were updated for future assignments.`,
    );
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
    return previewRouting(capacitySnapshot(context).candidates, input);
  });
  server.post(
    "/api/tests/plan",
    { bodyLimit: 8 * 1024 * 1024 },
    async (request) => {
      requireIdentity(request, context);
      return planShards(shardInputSchema.parse(request.body));
    },
  );
}
