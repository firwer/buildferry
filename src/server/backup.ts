import { backup, DatabaseSync } from "node:sqlite";
import path from "node:path";
import { existsSync, linkSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { loadConfig } from "./config.js";

const destination = process.argv[2];
if (!destination) throw new Error("Usage: pnpm backup <new-backup-file>");
if (existsSync(destination))
  throw new Error(
    "Choose a new backup filename; existing files are never overwritten.",
  );
const config = loadConfig();
const database = new DatabaseSync(
  path.join(config.dataDir, "buildferry.sqlite"),
  { readOnly: true },
);
try {
  const target = path.resolve(destination);
  const temporary = path.join(
    path.dirname(target),
    `.buildferry-backup-${randomUUID()}.sqlite`,
  );
  writeFileSync(temporary, "", { flag: "wx", mode: 0o600 });
  try {
    await backup(database, temporary);
    linkSync(temporary, target);
  } finally {
    unlinkSync(temporary);
  }
  console.log(
    "Database backup completed. Back up the credentials key separately.",
  );
} finally {
  database.close();
}
