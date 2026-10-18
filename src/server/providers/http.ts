import type { z } from "zod";

export class ProviderError extends Error {
  constructor(
    readonly status: number,
    message = "The provider could not verify this connection. Check its access and try again.",
  ) {
    super(message);
  }
}

/** Fixed provider hosts, no redirects, bounded requests, and validated response boundaries. */
export async function providerJson<S extends z.ZodType>(
  fetcher: typeof fetch,
  url: string,
  schema: S,
  init: RequestInit,
): Promise<z.infer<S>> {
  let response: Response;
  try {
    response = await fetcher(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new ProviderError(
      502,
      "The provider could not be reached. Try again shortly.",
    );
  }
  if (!response.ok) throw new ProviderError(response.status);
  try {
    const text = await response.text();
    if (Buffer.byteLength(text) > 8_000_000)
      throw new Error("Oversized response");
    return schema.parse(JSON.parse(text));
  } catch {
    throw new ProviderError(
      502,
      "The provider returned an unsupported response. No capacity was approved.",
    );
  }
}
