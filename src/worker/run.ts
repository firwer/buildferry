import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const temporary = process.env.RUNNER_TEMP;
if (!temporary) throw new Error("Runner temporary directory is missing.");
const recipe = JSON.parse(
  readFileSync(path.join(temporary, "buildferry-recipe.json"), "utf8"),
) as { directory: string; commands: string[] };
if (
  typeof recipe.directory !== "string" ||
  !Array.isArray(recipe.commands) ||
  !recipe.commands.every((command) => typeof command === "string")
)
  throw new Error("The approved recipe is invalid.");
// No billing, app, provider, or source checkout credentials are inherited by project code.
const environment = { ...process.env };
delete environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
delete environment.ACTIONS_ID_TOKEN_REQUEST_URL;
for (const command of recipe.commands) {
  const result = spawnSync(
    "/bin/bash",
    ["--noprofile", "--norc", "-euo", "pipefail", "-c", command],
    { cwd: recipe.directory, env: environment, stdio: "inherit" },
  );
  if (result.error || result.status !== 0) {
    process.exitCode = 1;
    break;
  }
}
