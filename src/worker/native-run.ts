import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

const temp = process.env.RUNNER_TEMP;
if (!temp) throw new Error("Missing runner temporary directory.");
const jitFile = path.join(temp, "buildferry-native-jit");
const jit = readFileSync(jitFile, "utf8");
unlinkSync(jitFile);
if (!/^[A-Za-z0-9+/=]+$/.test(jit) || jit.length > 65_536)
  throw new Error("Invalid runner configuration.");
const directory = path.join(temp, "buildferry-native-runner");
mkdirSync(directory, { mode: 0o700 });
const archive = path.join(directory, "runner.tar.gz");
execFileSync(
  "curl",
  [
    "--fail",
    "--location",
    "--silent",
    "--show-error",
    "https://github.com/actions/runner/releases/download/v2.338.0/actions-runner-linux-x64-2.338.0.tar.gz",
    "--output",
    archive,
  ],
  { timeout: 120_000 },
);
const checksum = createHash("sha256")
  .update(readFileSync(archive))
  .digest("hex");
if (
  checksum !==
  "af4b794c1bc41d73d40535e3fe092a39f9679cd8d965954c2aca25a05ca41d32"
)
  throw new Error("The official runner download checksum did not match.");
execFileSync("tar", ["xzf", archive, "-C", directory], { timeout: 60_000 });
unlinkSync(archive);
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name]) =>
      !/^(ACTIONS_|GITHUB_|RUNNER_|BUILDFERRY_|GH_TOKEN$|GITHUB_TOKEN$)/.test(
        name,
      ),
  ),
);
const child = spawn(path.join(directory, "run.sh"), ["--jitconfig", jit], {
  cwd: directory,
  env,
  stdio: "inherit",
});
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => child.kill(signal));
child.on("error", () => {
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
