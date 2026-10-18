import { z } from "zod";
import type { Provider } from "../../shared/contracts.js";
import { providerJson, ProviderError } from "./http.js";

/** Verify project access and its GitHub connections without creating compute resources. */
export async function verifyUbicloud(
  projectId: string,
  token: string,
  fetcher: typeof fetch = fetch,
) {
  const options = {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  };
  const project = await providerJson(
    fetcher,
    `https://api.ubicloud.com/project/${encodeURIComponent(projectId)}`,
    z.object({ id: z.string(), name: z.string().min(1).max(200) }),
    options,
  );
  if (project.id !== projectId)
    throw new ProviderError(422, "The provider returned a different project.");
  const connections = await providerJson(
    fetcher,
    `https://api.ubicloud.com/project/${encodeURIComponent(projectId)}/github`,
    z.object({
      count: z.number().int().nonnegative(),
      items: z.array(z.object({ id: z.string(), name: z.string() })),
    }),
    options,
  );
  if (
    connections.count !== connections.items.length ||
    connections.count === 0
  ) {
    throw new ProviderError(
      422,
      "Connect a GitHub account in Ubicloud first, or narrow the project connections.",
    );
  }
  return {
    name: project.name,
    installations: connections.items,
  } satisfies Pick<Provider, "name" | "installations">;
}
