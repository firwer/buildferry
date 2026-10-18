import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { digest, seal, unseal } from "./crypto.js";

export const storedSessionSchema = z.object({
  csrf: z.string(),
  githubId: z.number().nullable(),
  setup: z.boolean(),
  admin: z.string().optional(),
});
export type StoredSession = z.infer<typeof storedSessionSchema>;
export const stateSchema = z.object({
  kind: z.enum(["manifest", "oauth", "invite"]),
  sessionHash: z.string(),
  verifier: z.string(),
  invite: z.string(),
});

export class Store {
  readonly db: DatabaseSync;
  constructor(
    filename: string,
    private readonly key: Buffer,
  ) {
    this.db = new DatabaseSync(filename);
    this.db.exec(
      "PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;",
    );
    const migrations = this.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='migrations'",
      )
      .get();
    if (
      migrations &&
      Number(
        this.db.prepare("SELECT MAX(version) AS version FROM migrations").get()
          ?.version,
      ) > 1
    ) {
      this.db.close();
      throw new Error("This database requires a newer BuildFerry version.");
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS migrations (version INTEGER PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(kind, id));
      CREATE TABLE IF NOT EXISTS secrets (name TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, body TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS states (hash TEXT PRIMARY KEY, body TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS activity (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, message TEXT NOT NULL);
      INSERT OR IGNORE INTO migrations(version) VALUES (1);
    `);
    try {
      const check = this.secret(
        "encryption-check",
        z.object({ value: z.literal("buildferry") }),
      );
      if (!check) this.setSecret("encryption-check", { value: "buildferry" });
    } catch {
      this.db.close();
      throw new Error(
        "The encryption key cannot open this database. Restore the original key.",
      );
    }
  }

  close(): void {
    this.db.close();
  }

  /** Short synchronous transactions must never contain provider requests. */
  transaction<T>(operation: () => T): T {
    if (this.db.isTransaction) return operation();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  get<S extends z.ZodType>(
    kind: string,
    id: string,
    schema: S,
  ): z.infer<S> | null {
    const row = this.db
      .prepare("SELECT body FROM records WHERE kind = ? AND id = ?")
      .get(kind, id);
    return row ? schema.parse(JSON.parse(z.string().parse(row.body))) : null;
  }
  list<S extends z.ZodType>(kind: string, schema: S): z.infer<S>[] {
    return this.db
      .prepare("SELECT body FROM records WHERE kind = ? ORDER BY id")
      .all(kind)
      .map((row) => schema.parse(JSON.parse(z.string().parse(row.body))));
  }
  entries<S extends z.ZodType>(
    kind: string,
    schema: S,
  ): { id: string; value: z.infer<S> }[] {
    return this.db
      .prepare("SELECT id, body FROM records WHERE kind = ? ORDER BY id")
      .all(kind)
      .map((row) => ({
        id: z.string().parse(row.id),
        value: schema.parse(JSON.parse(z.string().parse(row.body))),
      }));
  }
  put(kind: string, id: string, value: object | string | number): void {
    this.db
      .prepare(
        "INSERT INTO records(kind,id,body) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body",
      )
      .run(kind, id, JSON.stringify(value));
  }
  secret<S extends z.ZodType>(name: string, schema: S): z.infer<S> | null {
    const row = this.db
      .prepare("SELECT body FROM secrets WHERE name = ?")
      .get(name);
    return row
      ? schema.parse(
          JSON.parse(unseal(this.key, name, z.string().parse(row.body))),
        )
      : null;
  }
  remove(kind: string, id: string): void {
    this.db
      .prepare("DELETE FROM records WHERE kind = ? AND id = ?")
      .run(kind, id);
  }
  setSecret(name: string, value: object): void {
    this.db
      .prepare(
        "INSERT INTO secrets(name,body) VALUES(?,?) ON CONFLICT(name) DO UPDATE SET body=excluded.body",
      )
      .run(name, seal(this.key, name, JSON.stringify(value)));
  }
  deleteSecret(name: string): void {
    this.db.prepare("DELETE FROM secrets WHERE name = ?").run(name);
  }
  session(token: string, now = Date.now()): StoredSession | null {
    const row = this.db
      .prepare("SELECT body FROM sessions WHERE hash = ? AND expires > ?")
      .get(digest(token), now);
    return row
      ? storedSessionSchema.parse(JSON.parse(z.string().parse(row.body)))
      : null;
  }
  saveSession(token: string, session: StoredSession, expires: number): void {
    this.db
      .prepare("INSERT INTO sessions(hash,body,expires) VALUES(?,?,?)")
      .run(digest(token), JSON.stringify(session), expires);
  }
  deleteSession(token: string): void {
    this.db.prepare("DELETE FROM sessions WHERE hash = ?").run(digest(token));
  }
  deleteIdentitySessions(id: number): void {
    this.db
      .prepare("DELETE FROM sessions WHERE json_extract(body,'$.githubId') = ?")
      .run(id);
  }
  state(
    token: string,
    state: z.infer<typeof stateSchema>,
    expires: number,
  ): void {
    this.db
      .prepare("INSERT INTO states(hash,body,expires) VALUES(?,?,?)")
      .run(
        digest(token),
        seal(this.key, `state:${digest(token)}`, JSON.stringify(state)),
        expires,
      );
  }
  takeState(
    token: string,
    now = Date.now(),
  ): z.infer<typeof stateSchema> | null {
    return this.transaction(() => {
      const row = this.db
        .prepare("SELECT body FROM states WHERE hash = ? AND expires > ?")
        .get(digest(token), now);
      this.db.prepare("DELETE FROM states WHERE hash = ?").run(digest(token));
      return row
        ? stateSchema.parse(
            JSON.parse(
              unseal(
                this.key,
                `state:${digest(token)}`,
                z.string().parse(row.body),
              ),
            ),
          )
        : null;
    });
  }
  hasInvite(token: string, now = Date.now()): boolean {
    const row = this.db
      .prepare("SELECT body FROM states WHERE hash = ? AND expires > ?")
      .get(digest(token), now);
    return row
      ? stateSchema.parse(
          JSON.parse(
            unseal(
              this.key,
              `state:${digest(token)}`,
              z.string().parse(row.body),
            ),
          ),
        ).kind === "invite"
      : false;
  }
  audit(message: string): void {
    this.db
      .prepare("INSERT INTO activity(at,message) VALUES(?,?)")
      .run(Date.now(), message);
    this.db
      .prepare(
        "DELETE FROM activity WHERE id NOT IN (SELECT id FROM activity ORDER BY id DESC LIMIT 200)",
      )
      .run();
  }
  activity() {
    return z
      .array(z.object({ id: z.number(), at: z.number(), message: z.string() }))
      .parse(
        this.db
          .prepare(
            "SELECT id,at,message FROM activity ORDER BY id DESC LIMIT 12",
          )
          .all(),
      );
  }
  prune(now = Date.now()): void {
    this.db.prepare("DELETE FROM sessions WHERE expires <= ?").run(now);
    this.db.prepare("DELETE FROM states WHERE expires <= ?").run(now);
  }
}
