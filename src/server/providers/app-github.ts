import { createPrivateKey } from "node:crypto";
import { importPKCS8, SignJWT } from "jose";
import { z } from "zod";
import { configuredApp, HttpError, type Context } from "../context.js";
import { boundedBytes, ProviderError } from "./http.js";
import { shaSchema } from "../../shared/execution.js";

export const repositoryDetailSchema = z.object({
  id: z.number().int().positive(),
  full_name: z.string(),
  private: z.boolean(),
  archived: z.boolean(),
  disabled: z.boolean(),
  default_branch: z.string(),
  owner: z.object({ id: z.number().int().positive(), login: z.string() }),
});
export const runSchema = z.object({
  id: z.number().int().positive(),
  run_attempt: z.number().int().positive(),
  head_sha: shaSchema,
  event: z.string(),
  path: z.string(),
  display_title: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
  created_at: z.string(),
  html_url: z
    .url()
    .refine((value) => new URL(value).origin === "https://github.com"),
  actor: z.object({ id: z.number().int().positive(), login: z.string() }),
  repository: z.object({ id: z.number().int().positive() }),
});
export type WorkflowRun = z.infer<typeof runSchema>;

/** App authority is narrowed to one repository and explicit permissions for each token. */
export class AppGitHub {
  constructor(private readonly context: Context) {}
  async request<S extends z.ZodType>(
    method: string,
    endpoint: string,
    token: string,
    schema: S,
    body?: object,
  ): Promise<z.infer<S>> {
    let response: Response;
    try {
      response = await this.context.fetcher(
        `https://api.github.com${endpoint}`,
        {
          method,
          redirect: "error",
          signal: AbortSignal.timeout(15_000),
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2026-03-10",
            ...(body ? { "Content-Type": "application/json" } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
        },
      );
    } catch {
      throw new ProviderError(
        502,
        "GitHub could not be reached. The request remains recorded for reconciliation.",
      );
    }
    if (!response.ok)
      throw new ProviderError(
        response.status,
        undefined,
        `${method} ${endpoint}`,
      );
    if (response.status === 204) return schema.parse(null);
    try {
      const content = await boundedBytes(response, 8_000_000);
      if (content.length === 0) return schema.parse(null);
      return schema.parse(JSON.parse(Buffer.from(content).toString("utf8")));
    } catch {
      throw new ProviderError(502, "GitHub returned an unsupported response.");
    }
  }
  async jwt(): Promise<string> {
    const app = configuredApp(this.context);
    if (!app) throw new HttpError(409, "Connect your GitHub App first.");
    const pem = createPrivateKey(app.pem)
      .export({ format: "pem", type: "pkcs8" })
      .toString();
    const key = await importPKCS8(pem, "RS256");
    return new SignJWT({})
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer(app.client_id)
      .setIssuedAt(Math.floor(Date.now() / 1000) - 60)
      .setExpirationTime("8m")
      .sign(key);
  }
  async installation(repository: string) {
    return this.request(
      "GET",
      `/repos/${repository}/installation`,
      await this.jwt(),
      z.object({
        id: z.number().int().positive(),
        app_id: z.number().int().positive(),
      }),
    );
  }
  async token(
    installationId: number,
    repositoryId: number,
    permissions: Record<string, "read" | "write">,
  ): Promise<string> {
    const result = await this.request(
      "POST",
      `/app/installations/${installationId}/access_tokens`,
      await this.jwt(),
      z.object({ token: z.string().min(1) }),
      { repository_ids: [repositoryId], permissions },
    );
    return result.token;
  }
  async revoke(token: string): Promise<void> {
    try {
      await this.request("DELETE", "/installation/token", token, z.null());
    } catch (error) {
      if (!(error instanceof ProviderError && error.status === 401))
        throw error;
    }
  }
  async repository(repository: string, token: string) {
    const result = await this.request(
      "GET",
      `/repos/${repository}`,
      token,
      repositoryDetailSchema,
    );
    if (
      result.archived ||
      result.disabled ||
      result.full_name.toLowerCase() !== repository.toLowerCase()
    )
      throw new HttpError(422, "Choose an active repository.");
    return result;
  }
  async ref(
    repository: string,
    branch: string,
    token: string,
  ): Promise<string> {
    return (
      await this.request(
        "GET",
        `/repos/${repository}/commits/${encodeURIComponent(branch)}`,
        token,
        z.object({ sha: shaSchema }),
      )
    ).sha;
  }
  async botId(token: string): Promise<number> {
    const app = configuredApp(this.context);
    if (!app) throw new HttpError(409, "Connect your GitHub App first.");
    return (
      await this.request(
        "GET",
        `/users/${encodeURIComponent(app.slug + "[bot]")}`,
        token,
        z.object({ id: z.number().int().positive() }),
      )
    ).id;
  }
}
