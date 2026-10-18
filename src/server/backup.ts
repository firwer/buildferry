import { backup, DatabaseSync } from "node:sqlite";
import path from "node:path";
import { existsSync } from "node:fs";
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
  await backup(database, path.resolve(destination));
  console.log(
    "Database backup completed. Back up the credentials key separately.",
  );
} finally {
  database.close();
}
