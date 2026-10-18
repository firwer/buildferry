import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHmac, randomBytes, scryptSync } from "node:crypto";
import path from "node:path";
import { z } from "zod";

export type Config = Readonly<{
  publicUrl: string;
  dataDir: string;
  port: number;
  host: string;
  key: Buffer;
  demo: boolean;
  trustProxyHops: number;
  admin?: Readonly<{ username: string; salt: Buffer; passwordHash: Buffer }>;
}>;

/** Persist one key and refuse to replace a missing key for an existing database. */
function persistentKey(dataDir: string): Buffer {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const keyFile = path.join(dataDir, "credentials.key");
  if (
    !existsSync(keyFile) &&
    existsSync(path.join(dataDir, "buildferry.sqlite"))
  ) {
    throw new Error(
      "The database exists but its encryption key is missing. Restore credentials.key or supply the original BUILDFERRY_ENCRYPTION_KEY.",
    );
  }
  try {
    writeFileSync(keyFile, randomBytes(32), { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST"))
      throw error;
  }
  return readFileSync(keyFile);
}

/** Require HTTPS off loopback; a proxy cannot override the configured trusted origin. */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  demo = process.argv.includes("--test-fixtures"),
): Config {
  if (process.argv.includes("--test-fixtures") && env.NODE_ENV !== "test")
    throw new Error("Fixture data is available only in the test environment.");
  const publicUrl = new URL(
    env.BUILDFERRY_PUBLIC_URL ?? "http://localhost:8787",
  );
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(
    publicUrl.hostname,
  );
  if (
    publicUrl.protocol !== "https:" &&
    !(loopback && publicUrl.protocol === "http:")
  )
    throw new Error("Set an HTTPS public URL outside localhost.");
  if (
    publicUrl.pathname !== "/" ||
    publicUrl.search ||
    publicUrl.hash ||
    publicUrl.username ||
    publicUrl.password
  )
    throw new Error(
      "The public URL must be an origin without a path or credentials.",
    );
  if (demo && !loopback) throw new Error("The sample demo must use localhost.");
  const dataDir = path.resolve(env.BUILDFERRY_DATA_DIR ?? ".data");
  let key: Buffer;
  if (env.BUILDFERRY_ENCRYPTION_KEY) {
    key = Buffer.from(env.BUILDFERRY_ENCRYPTION_KEY, "base64");
  } else if (demo) {
    key = randomBytes(32);
  } else {
    key = persistentKey(dataDir);
  }
  if (key.length !== 32)
    throw new Error("The encryption key must contain exactly 32 bytes.");
  let admin: Config["admin"];
  if (env.BUILDFERRY_ADMIN_USERNAME || env.BUILDFERRY_ADMIN_PASSWORD) {
    const username = z
      .string()
      .trim()
      .min(1)
      .max(100)
      .parse(env.BUILDFERRY_ADMIN_USERNAME);
    const password = z
      .string()
      .min(12)
      .max(1024)
      .parse(env.BUILDFERRY_ADMIN_PASSWORD);
    const salt = createHmac("sha256", key)
      .update(`buildferry-admin:${username}`)
      .digest();
    admin = { username, salt, passwordHash: scryptSync(password, salt, 64) };
  }
  return {
    publicUrl: publicUrl.origin,
    dataDir,
    key,
    demo,
    admin,
    trustProxyHops: z.coerce
      .number()
      .int()
      .min(0)
      .max(5)
      .parse(env.BUILDFERRY_TRUST_PROXY_HOPS ?? 0),
    port: z.coerce
      .number()
      .int()
      .min(1)
      .max(65535)
      .parse(env.PORT ?? 8787),
    host: demo ? "127.0.0.1" : (env.HOST ?? "0.0.0.0"),
  };
}
