import type { z } from "zod";
import { sessionSchema } from "../shared/contracts.js";

let csrf = "";

export async function api<S extends z.ZodType>(
  path: string,
  schema: S,
  method = "GET",
  body?: object,
): Promise<z.infer<S>> {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    signal: AbortSignal.timeout(40_000),
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      "X-BuildFerry-CSRF": csrf,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.status === 204) return schema.parse(null);
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error =
      data &&
      typeof data === "object" &&
      "error" in data &&
      typeof data.error === "string"
        ? data.error
        : "The request could not be completed.";
    throw new Error(error);
  }
  const parsed = schema.safeParse(data);
  if (!parsed.success)
    throw new Error(
      "Your workspace returned an unexpected response. Refresh and try again.",
    );
  return parsed.data;
}

export async function loadSession() {
  const session = await api("/api/session", sessionSchema);
  csrf = session.csrf;
  return session;
}

export const money = (micros: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 3,
  }).format(micros / 1_000_000);
export const number = (value: number) =>
  new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(value);
