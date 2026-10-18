import type { FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { accountSchema, type Account } from "../shared/contracts.js";
import type { Config } from "./config.js";
import { appSchema, type GitHub } from "./providers/github.js";
import type { Store, StoredSession } from "./store.js";
import { equalSecret } from "./crypto.js";

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
  const session = context.store.session(request.cookies.bf_session ?? "");
  if (
    session?.admin &&
    (!context.config.admin ||
      !equalSecret(
        session.admin,
        context.config.admin.passwordHash.toString("hex"),
      ))
  )
    return null;
  return session;
}

export function identityFor(session: StoredSession | null, context: Context) {
  const id = session?.admin ? ownerId(context) : session?.githubId;
  if (!id) return null;
  const identity = context.store.get("account", String(id), accountSchema);
  if (!identity) return null;
  const administrator =
    Boolean(session?.admin) ||
    (!context.config.admin && id === ownerId(context));
  return {
    ...identity,
    login: session?.admin
      ? (context.config.admin?.username ?? identity.login)
      : identity.login,
    role: administrator ? ("owner" as const) : ("member" as const),
  };
}

export function requireIdentity(request: FastifyRequest, context: Context) {
  const identity = identityFor(sessionFor(request, context), context);
  if (!identity) throw new HttpError(401, "Sign in to continue.");
  return identity;
}

export function requireOwner(request: FastifyRequest, context: Context): void {
  const identity = requireIdentity(request, context);
  if (identity.id !== ownerId(context) || identity.role !== "owner")
    throw new HttpError(
      403,
      "Only the instance owner can change this setting.",
    );
}

/** The single instance administrator manages all connected capacity accounts. */
export function requireAccountManager(
  request: FastifyRequest,
  context: Context,
  account: Account,
) {
  const identity = requireIdentity(request, context);
  if (identity.id !== account.id && identity.role !== "owner")
    throw new HttpError(
      403,
      "Only the administrator or this account's owner can manage its worker.",
    );
  return identity;
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
