import { z } from "zod";
import { providerJson, ProviderError } from "./http.js";
import { loginSchema } from "../../shared/contracts.js";

export const appSchema = z.object({
  id: z.number().int().positive(),
  slug: z.string().min(1),
  client_id: z.string().min(1),
  client_secret: z.string().min(1),
  webhook_secret: z.string().min(1),
  pem: z.string().min(1),
  owner: z.object({
    id: z.number(),
    login: loginSchema,
    type: z.literal("User"),
  }),
});
export type GitHubApp = z.infer<typeof appSchema>;
export const tokenSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().optional(),
  expires_at: z.number().nullable(),
});
export type GitHubToken = z.infer<typeof tokenSchema>;
const exchangeSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().optional(),
  expires_in: z.number().positive().optional(),
});
const userSchema = z.object({
  id: z.number().int().positive(),
  login: loginSchema,
});
const billingSchema = z.object({
  usageItems: z.array(
    z.object({
      date: z.string().min(10),
      product: z.string(),
      sku: z.string(),
      quantity: z.number().nonnegative(),
      unitType: z.string(),
      repositoryName: z.string().nullable().optional(),
    }),
  ),
});

export class GitHub {
  constructor(private readonly fetcher: typeof fetch = fetch) {}

  request<S extends z.ZodType>(
    endpoint: string,
    token: string,
    schema: S,
  ): Promise<z.infer<S>> {
    return providerJson(
      this.fetcher,
      `https://api.github.com${endpoint}`,
      schema,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2026-03-10",
        },
      },
    );
  }

  convertManifest(code: string): Promise<GitHubApp> {
    // The one-use conversion code authenticates this GitHub endpoint before the app exists.
    return providerJson(
      this.fetcher,
      `https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`,
      appSchema,
      {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2026-03-10",
        },
      },
    );
  }

  async exchange(
    app: GitHubApp,
    fields: Record<string, string>,
  ): Promise<GitHubToken> {
    const body = new URLSearchParams({
      client_id: app.client_id,
      client_secret: app.client_secret,
      ...fields,
    });
    const data = await providerJson(
      this.fetcher,
      "https://github.com/login/oauth/access_token",
      exchangeSchema,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body,
      },
    );
    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: data.expires_in ? Date.now() + data.expires_in * 1000 : null,
    };
  }

  user(token: string) {
    return this.request("/user", token, userSchema);
  }

  async usage(login: string, token: string, period: string): Promise<number> {
    return (await this.usageReport(login, token, period)).usedMinutes;
  }

  /** Use repository-attributed billing to avoid counting the same worker minute in both ledgers. */
  async usageReport(
    login: string,
    token: string,
    period: string,
    workerRepository?: string,
  ) {
    const [year, month] = period.split("-");
    const report = await this.request(
      `/users/${encodeURIComponent(login)}/settings/billing/usage?year=${year}&month=${Number(month)}`,
      token,
      billingSchema,
    );
    let total = 0;
    let worker = 0;
    let attributed = Boolean(workerRepository);
    const workerName = workerRepository?.toLowerCase();
    const qualifiedWorkerName = `${login}/${workerRepository}`.toLowerCase();
    for (const item of report.usageItems) {
      if (
        item.product.toLowerCase() !== "actions" ||
        item.unitType.toLowerCase() !== "minutes"
      )
        continue;
      if (
        !item.date.startsWith(period) ||
        !["actions_linux", "actions linux"].includes(item.sku.toLowerCase())
      ) {
        throw new ProviderError(
          422,
          "This account includes usage that this version cannot safely convert to included minutes.",
        );
      }
      total += item.quantity;
      if (!item.repositoryName) attributed = false;
      const repositoryName = item.repositoryName?.toLowerCase();
      if (
        workerName &&
        (repositoryName === workerName ||
          repositoryName === qualifiedWorkerName)
      )
        worker += item.quantity;
    }
    if (!Number.isFinite(total) || total > 1_000_000)
      throw new ProviderError(422, "The account usage could not be verified.");
    // Billing quantities can include partial minutes; round usage up to preserve the reserve.
    return {
      usedMinutes: Math.ceil(total),
      workerUsedMinutes: attributed ? Math.floor(worker) : null,
    };
  }

  async repository(
    login: string,
    id: number,
    name: string,
    token: string,
  ): Promise<void> {
    const repository = await this.request(
      `/repos/${encodeURIComponent(login)}/${encodeURIComponent(name)}`,
      token,
      z.object({
        private: z.boolean(),
        archived: z.boolean(),
        disabled: z.boolean(),
        owner: z.object({ id: z.number() }),
      }),
    );
    if (
      !repository.private ||
      repository.archived ||
      repository.disabled ||
      repository.owner.id !== id
    ) {
      throw new ProviderError(
        422,
        "Choose an active private repository owned by this account.",
      );
    }
  }
}
