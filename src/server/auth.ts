import { createHash, createHmac } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  accountSchema,
  type Account,
  type SessionView,
} from "../shared/contracts.js";
import { nonce, digest, equalSecret, passwordKey } from "./crypto.js";
import {
  configuredApp,
  identityFor,
  HttpError,
  ownerId,
  requireIdentity,
  requireOwner,
  requireSetup,
  sessionFor,
  setSessionCookie,
  type Context,
} from "./context.js";
import { tokenSchema } from "./providers/github.js";
import { currentPeriod } from "./routing.js";

const tokenQuery = z.string().min(1).max(1024);
const sessionSeconds = 8 * 60 * 60;

export function newAccount(
  id: number,
  login: string,
  role: "owner" | "member",
): Account {
  return {
    id,
    login,
    role,
    settings: {
      includedMinutes: 2000,
      contributionMinutes: 2000,
      reserveMinutes: 200,
      priority: 1,
      weight: 1,
      concurrency: 1,
      state: "active",
      workerRepository: "",
      allowanceConfirmed: false,
    },
    usedMinutes: null,
    period: currentPeriod(),
    verifiedAt: null,
    repositoryVerified: false,
    message: "Set monthly minutes and finish worker setup.",
  };
}

function sessionView(request: FastifyRequest, context: Context): SessionView {
  const session = sessionFor(request, context);
  const app = configuredApp(context);
  const user = identityFor(session, context);
  let stage: SessionView["stage"] = "login";
  if (user) stage = user.role === "owner" ? "dashboard" : "connected";
  else if (session?.setup && ownerId(context) === null) stage = "setup";
  else if (ownerId(context) === null && !context.config.admin) stage = "claim";
  return {
    stage,
    csrf: session?.csrf ?? "",
    demo: context.config.demo,
    passwordLogin: Boolean(context.config.admin),
    user: user ? { id: user.id, login: user.login, role: user.role } : null,
    app:
      app && session
        ? {
            slug: app.slug,
            installUrl: `https://github.com/apps/${encodeURIComponent(app.slug)}/installations/new`,
          }
        : null,
    publicUrl: context.config.publicUrl,
  };
}

function createManifest(context: Context, name: string) {
  const base = context.config.publicUrl;
  return {
    name,
    url: base,
    public: true,
    redirect_url: `${base}/setup/github/callback`,
    callback_urls: [`${base}/auth/callback`],
    setup_url: `${base}/`,
    hook_attributes: { url: `${base}/api/github/webhook`, active: true },
    default_permissions: {
      actions: "write",
      contents: "write",
      checks: "write",
      workflows: "write",
      metadata: "read",
      plan: "read",
      repository_creation: "write",
    },
    // GitHub delivers installation events automatically; listing them rejects setup.
    default_events: ["push"],
    request_oauth_on_install: false,
  };
}

function authorizeUser(
  request: FastifyRequest,
  context: Context,
  state: { sessionHash: string; invite: string },
  id: number,
) {
  const existing = context.store.get("account", String(id), accountSchema);
  const initial = ownerId(context) === null;
  if (initial) {
    const setup = sessionFor(request, context);
    if (
      !setup?.setup ||
      state.sessionHash !== digest(request.cookies.bf_session ?? "") ||
      id !== configuredApp(context)?.owner.id
    ) {
      throw new HttpError(
        403,
        "Complete setup with the account that registered this GitHub App.",
      );
    }
  } else if (!existing && !context.store.hasInvite(state.invite)) {
    throw new HttpError(403, "Ask the instance owner for an invitation.");
  }
  return { existing, initial };
}

async function finishLogin(
  request: FastifyRequest,
  reply: FastifyReply,
  context: Context,
) {
  const query = z
    .object({ code: tokenQuery, state: tokenQuery })
    .parse(request.query);
  if (!equalSecret(query.state, request.cookies.bf_oauth ?? ""))
    throw new HttpError(403, "The sign-in request has expired. Try again.");
  const state = context.store.takeState(query.state);
  const app = configuredApp(context);
  if (state?.kind !== "oauth" || !app)
    throw new HttpError(403, "The sign-in request has expired. Try again.");
  const token = await context.github.exchange(app, {
    code: query.code,
    redirect_uri: `${context.config.publicUrl}/auth/callback`,
    code_verifier: state.verifier,
  });
  const user = await context.github.user(token.access_token);
  const { existing, initial } = authorizeUser(request, context, state, user.id);
  const initiatingSession = sessionFor(request, context);
  const admin =
    state.sessionHash === digest(request.cookies.bf_session ?? "")
      ? initiatingSession?.admin
      : undefined;
  const role = initial ? "owner" : "member";
  context.store.transaction(() => {
    if (
      !initial &&
      !existing &&
      context.store.takeState(state.invite)?.kind !== "invite"
    )
      throw new HttpError(403, "This invitation has expired.");
    if (initial) context.store.put("config", "owner", user.id);
    context.store.put(
      "account",
      String(user.id),
      existing
        ? { ...existing, login: user.login }
        : newAccount(user.id, user.login, role),
    );
    context.store.setSecret(`github-user:${user.id}`, token);
    context.store.deleteSession(request.cookies.bf_session ?? "");
  });
  const sessionToken = nonce();
  context.store.saveSession(
    sessionToken,
    {
      csrf: nonce(),
      githubId: admin ? ownerId(context) : user.id,
      setup: false,
      admin,
    },
    Date.now() + sessionSeconds * 1000,
  );
  setSessionCookie(reply, context, sessionToken, sessionSeconds);
  reply.clearCookie("bf_oauth", { path: "/" });
  context.store.audit(`${user.login} connected their GitHub account.`);
  return reply.redirect("/");
}

/** Bootstrap and authorization routes keep GitHub credentials off the dashboard boundary. */
export function registerAuth(
  server: FastifyInstance,
  context: Context,
  claimCode: string,
): void {
  server.get("/api/session", async (request) => sessionView(request, context));
  server.post(
    "/api/login",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const admin = context.config.admin;
      if (!admin || context.config.demo)
        throw new HttpError(404, "Password sign-in is not configured.");
      const input = z
        .object({
          username: z.string().min(1).max(100),
          password: z.string().min(1).max(1024),
        })
        .strict()
        .parse(request.body);
      const supplied = await passwordKey(input.password, admin.salt);
      if (
        !equalSecret(input.username, admin.username) ||
        !equalSecret(
          supplied.toString("hex"),
          admin.passwordHash.toString("hex"),
        )
      )
        throw new HttpError(401, "The username or password is incorrect.");
      const token = nonce();
      context.store.transaction(() => {
        context.store.deleteSession(request.cookies.bf_session ?? "");
        context.store.saveSession(
          token,
          {
            csrf: nonce(),
            githubId: ownerId(context),
            setup: ownerId(context) === null,
            admin: admin.passwordHash.toString("hex"),
          },
          Date.now() + sessionSeconds * 1000,
        );
      });
      setSessionCookie(reply, context, token, sessionSeconds);
      context.store.audit(`${admin.username} signed in as administrator.`);
      return { ok: true };
    },
  );
  server.post("/api/claim", async (request, reply) => {
    if (
      context.config.demo ||
      context.config.admin ||
      ownerId(context) !== null
    )
      throw new HttpError(409, "This installation is already claimed.");
    const { code } = z
      .object({ code: z.string().min(1).max(256) })
      .strict()
      .parse(request.body);
    const sessionToken = nonce();
    context.store.transaction(() => {
      const expected = context.store.get("config", "claim", z.string());
      if (!expected || !equalSecret(digest(code), expected))
        throw new HttpError(
          403,
          "The setup code is incorrect or has already been used.",
        );
      context.store.put("config", "claim", "");
      context.store.saveSession(
        sessionToken,
        { csrf: nonce(), githubId: null, setup: true },
        Date.now() + 30 * 60_000,
      );
    });
    setSessionCookie(reply, context, sessionToken, 30 * 60);
    return { ok: true };
  });
  server.post("/api/setup/manifest", async (request) => {
    requireSetup(request, context);
    if (configuredApp(context))
      throw new HttpError(409, "The GitHub App is already registered.");
    if (!context.config.publicUrl.startsWith("https:"))
      throw new HttpError(
        422,
        "Set a public HTTPS address before connecting GitHub.",
      );
    const { name } = z
      .object({
        name: z
          .string()
          .trim()
          .min(3)
          .max(34)
          .regex(/^[a-zA-Z0-9 -]+$/),
      })
      .strict()
      .parse(request.body);
    const state = nonce();
    context.store.state(
      state,
      {
        kind: "manifest",
        sessionHash: digest(request.cookies.bf_session ?? ""),
        verifier: "",
        invite: "",
      },
      Date.now() + 10 * 60_000,
    );
    return {
      url: `https://github.com/settings/apps/new?state=${encodeURIComponent(state)}`,
      manifest: createManifest(context, name),
    };
  });
  server.get("/setup/github/callback", async (request, reply) => {
    requireSetup(request, context);
    const query = z
      .object({ code: tokenQuery, state: tokenQuery })
      .parse(request.query);
    const state = context.store.takeState(query.state);
    if (
      configuredApp(context) ||
      state?.kind !== "manifest" ||
      state.sessionHash !== digest(request.cookies.bf_session ?? "")
    )
      throw new HttpError(403, "The app registration request has expired.");
    const app = await context.github.convertManifest(query.code);
    requireSetup(request, context);
    if (configuredApp(context))
      throw new HttpError(409, "The GitHub App is already registered.");
    context.store.setSecret("github-app", app);
    return reply.redirect("/");
  });
  server.get("/auth/github", async (request, reply) => {
    const app = configuredApp(context);
    if (!app) throw new HttpError(409, "Register a GitHub App first.");
    if (ownerId(context) === null) requireSetup(request, context);
    const { invite = "" } = z
      .object({ invite: z.string().max(256).optional() })
      .parse(request.query);
    if (invite && !context.store.hasInvite(invite))
      throw new HttpError(403, "This invitation has expired.");
    const state = nonce();
    const verifier = nonce();
    context.store.state(
      state,
      {
        kind: "oauth",
        sessionHash: digest(request.cookies.bf_session ?? ""),
        verifier,
        invite,
      },
      Date.now() + 10 * 60_000,
    );
    reply.setCookie("bf_oauth", state, {
      httpOnly: true,
      secure: context.config.publicUrl.startsWith("https:"),
      sameSite: "lax",
      path: "/",
      maxAge: 600,
    });
    const url = new URL("https://github.com/login/oauth/authorize");
    url.search = new URLSearchParams({
      client_id: app.client_id,
      redirect_uri: `${context.config.publicUrl}/auth/callback`,
      state,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      scope: "offline_access",
    }).toString();
    return reply.redirect(url.toString());
  });
  server.get("/auth/callback", async (request, reply) =>
    finishLogin(request, reply, context),
  );
  server.post("/api/invitations", async (request) => {
    requireOwner(request, context);
    const token = nonce();
    context.store.state(
      token,
      { kind: "invite", sessionHash: "", verifier: "", invite: "" },
      Date.now() + 60 * 60_000,
    );
    context.store.audit("A one-use team invitation was created.");
    return { url: `${context.config.publicUrl}/?invite=${token}` };
  });
  server.post("/api/logout", async (request, reply) => {
    requireIdentity(request, context);
    context.store.deleteSession(request.cookies.bf_session ?? "");
    reply.clearCookie("bf_session", { path: "/" });
    reply.clearCookie("bf_oauth", { path: "/" });
    return { ok: true };
  });
  if (claimCode) context.store.put("config", "claim", digest(claimCode));
}

export async function registerWebhook(
  server: FastifyInstance,
  context: Context,
): Promise<void> {
  await server.register(async (receiver) => {
    receiver.removeAllContentTypeParsers();
    receiver.addContentTypeParser(
      "application/json",
      { parseAs: "buffer" },
      (_request, body, done) => done(null, body),
    );
    receiver.post("/api/github/webhook", async (request, reply) => {
      const app = configuredApp(context);
      const body = z.instanceof(Buffer).parse(request.body);
      const signature = z
        .string()
        .regex(/^sha256=[a-f0-9]{64}$/)
        .safeParse(request.headers["x-hub-signature-256"]);
      const delivery = z.uuid().safeParse(request.headers["x-github-delivery"]);
      if (
        !app ||
        !signature.success ||
        !delivery.success ||
        !equalSecret(
          signature.data,
          `sha256=${createHmac("sha256", app.webhook_secret).update(body).digest("hex")}`,
        )
      ) {
        throw new HttpError(403, "The webhook signature is invalid.");
      }
      const previous = context.store.get("delivery", delivery.data, z.number());
      context.store.transaction(() => {
        if (previous === null) {
          context.store.put("delivery", delivery.data, Date.now());
          if (request.headers["x-github-event"] === "push") {
            const push = z
              .object({
                ref: z.string(),
                after: z.string().regex(/^[a-f0-9]{40}$/),
                deleted: z.boolean(),
                repository: z.object({ id: z.number() }),
                installation: z.object({ id: z.number() }),
              })
              .safeParse(JSON.parse(body.toString("utf8")));
            if (push.success && !push.data.deleted)
              context.store.put("push", delivery.data, {
                ...push.data,
                receivedAt: Date.now(),
              });
          }
          context.store.db
            .prepare(
              "DELETE FROM records WHERE kind='delivery' AND CAST(body AS INTEGER) < ?",
            )
            .run(Date.now() - 7 * 86_400_000);
        }
      });
      return reply
        .code(202)
        .send({ received: true, duplicate: previous !== null });
    });
  });
}

/** Single-flight refresh prevents two requests from rotating the same token concurrently. */
export class Credentials {
  private static readonly stores = new WeakMap<
    Context["store"],
    Map<number, Promise<string>>
  >();
  private readonly flights: Map<number, Promise<string>>;
  constructor(private readonly context: Context) {
    this.flights = Credentials.stores.get(context.store) ?? new Map();
    Credentials.stores.set(context.store, this.flights);
  }
  token(id: number): Promise<string> {
    const existing = this.flights.get(id);
    if (existing) return existing;
    const pending = this.refresh(id);
    this.flights.set(id, pending);
    pending.finally(() => this.flights.delete(id)).catch(() => undefined);
    return pending;
  }
  private async refresh(id: number): Promise<string> {
    const stored = this.context.store.secret(`github-user:${id}`, tokenSchema);
    if (!stored) throw new HttpError(409, "Reconnect this GitHub account.");
    if (stored.expires_at === null || stored.expires_at > Date.now() + 60_000)
      return stored.access_token;
    const app = configuredApp(this.context);
    if (!app || !stored.refresh_token)
      throw new HttpError(409, "Reconnect this GitHub account.");
    const token = await this.context.github.exchange(app, {
      grant_type: "refresh_token",
      refresh_token: stored.refresh_token,
    });
    if (!this.context.store.get("account", String(id), accountSchema))
      throw new HttpError(409, "This account has been disconnected.");
    this.context.store.setSecret(`github-user:${id}`, token);
    return token.access_token;
  }
}
