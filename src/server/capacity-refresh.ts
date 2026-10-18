import { z } from "zod";
import { accountSchema, providerSchema } from "../shared/contracts.js";
import type { ExecutionService } from "./execution-service.js";
import { refreshAccount } from "./api.js";
import { verifyUbicloud } from "./providers/ubicloud.js";

/** Revalidate idle capacity periodically; failed connections get a bounded retry interval. */
export class CapacityRefresh {
  private readonly attempted = new Map<string, number>();
  constructor(private readonly service: ExecutionService) {}
  private due(id: string, verifiedAt: number | null): boolean {
    const now = Date.now();
    if (
      now - (verifiedAt ?? 0) < 5 * 60_000 ||
      now - (this.attempted.get(id) ?? 0) < 60_000
    )
      return false;
    this.attempted.set(id, now);
    return true;
  }
  async run(): Promise<void> {
    const { context, credentials } = this.service;
    const accounts = context.store
      .list("account", accountSchema)
      .filter(
        (account) =>
          account.settings.state === "active" &&
          this.due(`account:${account.id}`, account.verifiedAt),
      )
      .slice(0, 4);
    await Promise.allSettled(
      accounts.map((account) => refreshAccount(account, context, credentials)),
    );
    const providers = context.store
      .list("provider", providerSchema)
      .filter((provider) =>
        this.due(`provider:${provider.projectId}`, provider.verifiedAt),
      )
      .slice(0, 4);
    await Promise.allSettled(
      providers.map(async (provider) => {
        const secret = context.store.secret(
          `ubicloud:${provider.projectId}`,
          z.object({ token: z.string() }),
        );
        if (!secret) return;
        try {
          const verified = await verifyUbicloud(
            provider.projectId,
            secret.token,
            context.fetcher,
          );
          const current = context.store.get(
            "provider",
            provider.projectId,
            providerSchema,
          );
          if (current)
            context.store.put("provider", provider.projectId, {
              ...current,
              ...verified,
              verifiedAt: Date.now(),
            });
        } catch {
          const current = context.store.get(
            "provider",
            provider.projectId,
            providerSchema,
          );
          if (current)
            context.store.put("provider", provider.projectId, {
              ...current,
              verifiedAt: 0,
            });
        }
      }),
    );
  }
}
