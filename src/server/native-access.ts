import { z } from "zod";
import { accountSchema } from "../shared/contracts.js";
import { configuredApp, HttpError, type Context } from "./context.js";
import { AppGitHub } from "./providers/app-github.js";
import { ProviderError } from "./providers/http.js";

/** Sign-in and installation grants are separate; inspect GitHub's actual account installation. */
export async function nativeAccountAccess(context: Context, accountId: number) {
  const account = context.store.get(
    "account",
    String(accountId),
    accountSchema,
  );
  const app = configuredApp(context);
  if (!account || !app)
    throw new HttpError(404, "This account is not connected.");
  const github = new AppGitHub(context);
  try {
    const installation = await github.request(
      "GET",
      `/users/${account.login}/installation`,
      await github.jwt(),
      z.object({
        id: z.number().int().positive(),
        account: z.object({ id: z.number() }),
        permissions: z.record(z.string(), z.string()),
        suspended_at: z.string().nullable(),
      }),
    );
    if (installation.account.id !== accountId)
      throw new HttpError(409, "GitHub returned a different account.");
    const ready =
      installation.suspended_at === null &&
      ["repository_creation", "contents", "actions", "workflows"].every(
        (permission) => installation.permissions[permission] === "write",
      );
    return {
      state: ready ? ("ready" as const) : ("approval" as const),
      url: `https://github.com/settings/installations/${installation.id}`,
      message: ready
        ? "GitHub App access is ready."
        : `Sign in as ${account.login} on GitHub and approve the App's updated access on its installation page.`,
    };
  } catch (error) {
    if (!(error instanceof ProviderError && error.status === 404)) throw error;
    return {
      state: "missing" as const,
      url: `https://github.com/apps/${app.slug}/installations/new`,
      message: `The App is not installed for ${account.login}. Sign in as that account on GitHub and install the App first.`,
    };
  }
}
