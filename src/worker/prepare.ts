import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

type Claim = {
  sourceRepository: string;
  sourceRepositoryId: number;
  sourceSha: string;
  sourceToken: string;
  recipeHash: string;
  directory: string;
  commands: string[];
};
const base = new URL(required("BUILDFERRY_URL"));
if (base.protocol !== "https:") throw new Error("BuildFerry requires HTTPS.");
const requestId = required("BUILDFERRY_REQUEST_ID");
const runId = Number(required("GITHUB_RUN_ID"));
if (!/^[0-9a-f-]{36}$/.test(requestId) || !Number.isSafeInteger(runId))
  throw new Error("Invalid request identity.");

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}
async function identity(): Promise<string> {
  const endpoint = new URL(required("ACTIONS_ID_TOKEN_REQUEST_URL"));
  endpoint.searchParams.set("audience", base.origin);
  const response = await fetch(endpoint, {
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
    headers: {
      Authorization: `Bearer ${required("ACTIONS_ID_TOKEN_REQUEST_TOKEN")}`,
    },
  });
  if (!response.ok) throw new Error("Could not establish the worker identity.");
  const result = (await response.json()) as { value: string };
  if (typeof result.value !== "string")
    throw new Error("Missing worker identity.");
  return result.value;
}
async function call(endpoint: string, body: object): Promise<Response> {
  return fetch(new URL(endpoint, base), {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
    headers: {
      Authorization: `Bearer ${await identity()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

let claimed: Response | null = null;
for (let attempt = 0; attempt < 20; attempt++) {
  const response = await call("/api/worker/claim", { requestId, runId });
  if (response.status !== 425) {
    claimed = response;
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
if (!claimed?.ok)
  throw new Error("The worker was not admitted to this request.");
const claim = (await claimed.json()) as Claim;
if (
  !/^[0-9a-f]{40}$/.test(claim.sourceSha) ||
  !/^[0-9a-f]{64}$/.test(claim.recipeHash) ||
  !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(claim.sourceRepository)
)
  throw new Error("Invalid immutable source request.");
if (
  !Array.isArray(claim.commands) ||
  !claim.commands.every((command) => typeof command === "string")
)
  throw new Error("Invalid approved commands.");
const temporary = required("RUNNER_TEMP");
const directory = path.join(temporary, "buildferry-source");
mkdirSync(directory, { recursive: false });
function git(args: readonly string[], authenticated = false): string {
  const env = { ...process.env };
  if (authenticated) {
    env.GIT_CONFIG_COUNT = "1";
    env.GIT_CONFIG_KEY_0 = "http.https://github.com/.extraheader";
    const credential = Buffer.from(
      "x-access-token:" + claim.sourceToken,
    ).toString("base64");
    env.GIT_CONFIG_VALUE_0 = "AUTHORIZATION: basic " + credential;
  }
  return execFileSync("/usr/bin/git", [...args], {
    cwd: directory,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
let checkedOut = false;
try {
  git(["init"]);
  git([
    "remote",
    "add",
    "origin",
    `https://github.com/${claim.sourceRepository}.git`,
  ]);
  git(["fetch", "--no-tags", "--depth=1", "origin", claim.sourceSha], true);
  git(["checkout", "--detach", "FETCH_HEAD"]);
  if (git(["rev-parse", "HEAD"]) !== claim.sourceSha)
    throw new Error("Checkout does not match the approved revision.");
  checkedOut = true;
} catch {
  // Do not expose git's error object, which could contain authentication details.
}
const revoked = await call("/api/worker/prepared", { requestId, runId });
claim.sourceToken = "";
if (!revoked.ok)
  throw new Error(
    "Source access could not be revoked. Project code will not run.",
  );
if (!checkedOut)
  throw new Error("The requested source revision could not be checked out.");
const workingDirectory = path.resolve(directory, claim.directory);
if (
  workingDirectory !== directory &&
  !workingDirectory.startsWith(directory + path.sep)
)
  throw new Error("The working directory escapes the checkout.");
writeFileSync(
  path.join(temporary, "buildferry-recipe.json"),
  JSON.stringify({ directory: workingDirectory, commands: claim.commands }),
  { mode: 0o600 },
);
writeFileSync(
  path.join(temporary, "buildferry-audit.json"),
  JSON.stringify({
    version: 1,
    requestId,
    sourceRepositoryId: claim.sourceRepositoryId,
    sourceSha: claim.sourceSha,
    recipeHash: claim.recipeHash,
    workerRepositoryId: Number(required("GITHUB_REPOSITORY_ID")),
    workerSha: required("GITHUB_SHA"),
    runId,
    attempt: Number(required("GITHUB_RUN_ATTEMPT")),
  }),
  { mode: 0o600 },
);
console.log(
  "Immutable source prepared. Its checkout credential has been revoked.",
);
