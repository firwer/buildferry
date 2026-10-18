import type { FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { accountSchema } from "../shared/contracts.js";
import type { Config } from "./config.js";
import { appSchema, type GitHub } from "./providers/github.js";
import type { Store, StoredSession } from "./store.js";

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}
export type Context = Readonly<{
  config: Config;
  store: Store;
  github: GitHub;
  fetcher: typeof fetch;
}>;
export const ownerId = (context: Context) =>
  context.store.get("config", "owner", z.number());
export const configuredApp = (context: Context) =>
  context.store.secret("github-app", appSchema);

export function sessionFor(
  request: FastifyRequest,
  context: Context,
): StoredSession | null {
  if (context.config.demo)
    return { csrf: "demo-preview", githubId: 1, setup: false };
  return context.store.session(request.cookies.bf_session ?? "");
}

export function requireIdentity(request: FastifyRequest, context: Context) {
  const session = sessionFor(request, context);
  if (!session?.githubId) throw new HttpError(401, "Sign in to continue.");
  const identity = context.store.get(
    "account",
    String(session.githubId),
    accountSchema,
  );
  if (!identity)
    throw new HttpError(401, "Your account is no longer connected.");
  return identity;
}

export function requireOwner(request: FastifyRequest, context: Context): void {
  if (requireIdentity(request, context).id !== ownerId(context))
    throw new HttpError(
      403,
      "Only the instance owner can change this setting.",
    );
}

export function requireSetup(request: FastifyRequest, context: Context): void {
  if (
    context.config.demo ||
    ownerId(context) !== null ||
    !sessionFor(request, context)?.setup
  ) {
    throw new HttpError(
      403,
      "Use the setup code from your server to continue.",
    );
  }
}

export function setSessionCookie(
  reply: FastifyReply,
  context: Context,
  token: string,
  maxAge: number,
): void {
  reply.setCookie("bf_session", token, {
    httpOnly: true,
    secure: context.config.publicUrl.startsWith("https:"),
    sameSite: "lax",
    path: "/",
    maxAge,
  });
}
