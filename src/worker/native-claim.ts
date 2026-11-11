import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { cpus, homedir } from "node:os";

function ubicloudVmFamily(): "standard" | "premium" | undefined {
  try {
    // Ubicloud writes the same VM metadata here that it shows in the job log.
    const setup: unknown = JSON.parse(
      readFileSync(
        path.join(homedir(), "actions-runner", ".setup_info"),
        "utf8",
      ),
    );
    if (!Array.isArray(setup)) return;
    const runner = setup.find(
      (entry) => entry?.group === "Ubicloud Managed Runner",
    );
    if (typeof runner?.detail !== "string") return;
    const family = /^VM Family: (standard|premium)\r?$/m.exec(
      runner.detail,
    )?.[1];
    if (family === "standard" || family === "premium") return family;
  } catch {
    // Other runner images may not provide this file.
  }
}

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};
const base = new URL(required("BUILDFERRY_URL"));
if (base.protocol !== "https:" || base.pathname !== "/")
  throw new Error("Invalid BuildFerry origin.");
const requestId = required("BUILDFERRY_REQUEST_ID");
const runId = Number(required("GITHUB_RUN_ID"));
if (
  !/^[0-9a-f-]{36}$/.test(requestId) ||
  !Number.isSafeInteger(runId) ||
  runId < 1
)
  throw new Error("Invalid host identity.");
const oidcUrl = new URL(required("ACTIONS_ID_TOKEN_REQUEST_URL"));
if (
  oidcUrl.protocol !== "https:" ||
  !oidcUrl.hostname.endsWith(".actions.githubusercontent.com")
)
  throw new Error("Invalid GitHub identity endpoint.");
oidcUrl.searchParams.set("audience", base.origin);
const identityResponse = await fetch(oidcUrl, {
  headers: {
    Authorization: `Bearer ${required("ACTIONS_ID_TOKEN_REQUEST_TOKEN")}`,
  },
  redirect: "error",
  signal: AbortSignal.timeout(15_000),
});
if (!identityResponse.ok)
  throw new Error("GitHub host identity could not be obtained.");
const identity: { value?: string } = await identityResponse.json();
if (typeof identity.value !== "string")
  throw new Error("GitHub host identity is missing.");
const vmFamily = ubicloudVmFamily();
let result: Response | undefined;
for (let attempt = 0; attempt < 30; attempt++) {
  result = await fetch(new URL("/api/native/claim", base), {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
    headers: {
      Authorization: `Bearer ${identity.value}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      requestId,
      runId,
      cpuModel: cpus()[0]?.model ?? "",
      vmFamily,
    }),
  });
  if (result.status !== 425) break;
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
if (!result?.ok) throw new Error("BuildFerry did not authorize this host.");
const claim: { jit?: string } = await result.json();
if (
  typeof claim.jit !== "string" ||
  !/^[A-Za-z0-9+/=]+$/.test(claim.jit) ||
  claim.jit.length > 65_536
)
  throw new Error("Invalid single-use runner response.");
console.log(`::add-mask::${claim.jit}`);
writeFileSync(
  path.join(required("RUNNER_TEMP"), "buildferry-native-jit"),
  claim.jit,
  { mode: 0o600, flag: "wx" },
);
