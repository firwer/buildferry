import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import assets from "@fastify/static";
import { z } from "zod";
import type { Config } from "./config.js";
import { Store } from "./store.js";
import { GitHub } from "./providers/github.js";
import { ProviderError } from "./providers/http.js";
import {
  HttpError,
  ownerId,
  requireIdentity,
  sessionFor,
  type Context,
} from "./context.js";
import { equalSecret, nonce } from "./crypto.js";
import { registerAuth, registerWebhook } from "./auth.js";
import { registerApi } from "./api.js";
import { seedDemo } from "./demo.js";

type Options = Readonly<{
  store?: Store;
  fetcher?: typeof fetch;
  claimCode?: string;
}>;

function errorStatus(error: unknown): number {
  if (error instanceof z.ZodError) return 400;
  if (error instanceof HttpError) return error.statusCode;
  if (error instanceof ProviderError)
    return error.status >= 400 && error.status < 500 ? 422 : 502;
  if (
    error instanceof Error &&
    "statusCode" in error &&
    typeof error.statusCode === "number"
  )
    return error.statusCode;
  return 500;
}

/** A read-only provider integration: the only writes are local configuration and OAuth. */
export async function createApp(config: Config, options: Options = {}) {
  if (!config.demo) mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const store =
    options.store ??
    new Store(
      config.demo ? ":memory:" : path.join(config.dataDir, "buildferry.sqlite"),
      config.key,
    );
  const fetcher = options.fetcher ?? fetch;
  const context: Context = {
    config,
    store,
    fetcher,
    github: new GitHub(fetcher),
  };
  if (config.demo) seedDemo(store);
  const claimCode =
    ownerId(context) === null ? (options.claimCode ?? nonce()) : "";
  const server = Fastify({
    logger: false,
    bodyLimit: 64 * 1024,
    requestTimeout: 20_000,
  });
  await server.register(cookie);
  await server.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        fontSrc: ["'self'"],
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        formAction: ["'self'", "https://github.com"],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
        upgradeInsecureRequests: config.publicUrl.startsWith("https:")
          ? []
          : null,
      },
    },
    strictTransportSecurity: config.publicUrl.startsWith("https:")
      ? { maxAge: 31536000 }
      : false,
  });
  await server.register(rateLimit, { max: 120, timeWindow: "1 minute" });
  server.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/assets/"))
      reply.header("Cache-Control", "no-store");
  });
  server.setErrorHandler((error, _request, reply) => {
    const status = errorStatus(error);
    let message = "The request could not be completed. Try again.";
    if (error instanceof z.ZodError)
      message = error.issues.at(0)?.message ?? "Check the form values.";
    else if (error instanceof HttpError || error instanceof ProviderError)
      message = error.message;
    return reply.code(status).send({ error: message });
  });
  server.addHook("preHandler", async (request) => {
    const pathname = request.url.split("?").at(0) ?? "";
    if (!pathname.startsWith("/api/") || pathname === "/api/github/webhook")
      return;
    const mutation = !["GET", "HEAD", "OPTIONS"].includes(request.method);
    if (mutation && request.headers.origin !== config.publicUrl)
      throw new HttpError(
        403,
        "This request did not come from your dashboard.",
      );
    if (pathname === "/api/session" || pathname === "/api/claim") return;
    const session = sessionFor(request, context);
    if (!session) throw new HttpError(401, "Sign in to continue.");
    if (pathname !== "/api/setup/manifest") requireIdentity(request, context);
    if (
      mutation &&
      !equalSecret(
        String(request.headers["x-buildferry-csrf"] ?? ""),
        session.csrf,
      )
    )
      throw new HttpError(403, "Refresh this page before making changes.");
    if (
      mutation &&
      config.demo &&
      !["/api/routing/preview", "/api/tests/plan"].includes(pathname)
    )
      throw new HttpError(
        403,
        "The sample demo cannot change connections or contact providers.",
      );
  });
  server.get("/healthz", async () => ({ status: "ok" }));
  server.get("/readyz", async () => {
    store.db.prepare("SELECT 1").get();
    return { status: "ready", execution: "disabled" };
  });
  registerAuth(server, context, claimCode);
  registerApi(server, context);
  await registerWebhook(server, context);
  const webRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../web",
  );
  if (existsSync(path.join(webRoot, "index.html"))) {
    await server.register(assets, {
      root: webRoot,
      index: "index.html",
      maxAge: 0,
    });
  }
  const pruning = setInterval(() => store.prune(), 60_000);
  pruning.unref();
  server.addHook("onClose", async () => {
    clearInterval(pruning);
    store.close();
  });
  return { server, store, claimCode };
}
