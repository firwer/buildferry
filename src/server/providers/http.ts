import type { z } from "zod";

export class ProviderError extends Error {
  constructor(
    readonly status: number,
    message = "The provider could not verify this connection. Check its access and try again.",
  ) {
    super(message);
  }
}

/** Stop reading at the limit so an upstream response cannot exhaust dashboard memory. */
export async function boundedBytes(
  response: Response,
  maximum: number,
): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const parts: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.length;
      if (length > maximum) {
        await reader.cancel();
        throw new ProviderError(
          502,
          "The provider returned an oversized response.",
        );
      }
      parts.push(chunk.value);
    }
    return Buffer.concat(parts, length);
  } finally {
    reader.releaseLock();
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
    const bytes = await boundedBytes(response, 8_000_000);
    return schema.parse(JSON.parse(Buffer.from(bytes).toString("utf8")));
  } catch {
    throw new ProviderError(
      502,
      "The provider returned an unsupported response. No capacity was approved.",
    );
  }
}
