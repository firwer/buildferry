import type {
  Candidate,
  Provider,
  UbicloudRunner,
} from "../shared/contracts.js";
import type { NativeLease, RoutePolicy } from "../shared/native.js";

type Family = "standard" | "premium";
const familyOf = (runner: UbicloudRunner): Family =>
  runner.startsWith("ubicloud-premium-") ? "premium" : "standard";
const rateFor = (provider: Provider, runner: string) =>
  provider.runner === runner
    ? provider.rateMicros
    : provider.machineRates?.find((machine) => machine.runner === runner)
        ?.rateMicros;

/** Machine labels select a family explicitly; legacy defaults retain the Ubicloud account setting. */
export function machineChoice(policy: RoutePolicy, provider: Provider) {
  let family = policy.ubicloudFamily;
  if (family === "account") family = provider.family ?? "account";
  if (policy.ubicloudRunner) family = familyOf(policy.ubicloudRunner);
  const size = (policy.ubicloudRunner ?? provider.runner).split("-").at(-1);
  const runner =
    policy.ubicloudRunner ??
    (family === "account" ? provider.runner : `ubicloud-${family}-${size}`);
  const rate = rateFor(provider, runner);
  // Premium auto-upgrade can override a Standard label. Hold enough for either
  // family until the pinned bootstrap reports its CPU, before source work starts.
  const standard = rateFor(provider, `ubicloud-standard-${size}`) ?? rate ?? 0;
  const premium =
    rateFor(provider, `ubicloud-premium-${size}`) ??
    Math.max(rate ?? 0, standard * 2);
  return { family, runner, rate, standard, premium };
}

export function nativeMachine(
  candidate: Candidate,
  policy: RoutePolicy,
  providers: Provider[],
): Candidate {
  if (candidate.kind !== "ubicloud") return candidate;
  const provider = providers.find(
    (value) => candidate.id.split(":")[1] === value.projectId,
  );
  if (!provider) return { ...candidate, reason: "Reconnect Ubicloud." };
  const choice = machineChoice(policy, provider);
  let reason = candidate.reason?.startsWith("Set a rate")
    ? null
    : candidate.reason;
  if (choice.rate === undefined)
    reason = "Set a rate for the selected Ubicloud machine in Connections.";
  return {
    ...candidate,
    runner: choice.runner,
    memoryGiB: Number(choice.runner.split("-").at(-1)) * 4,
    rateMicros:
      choice.family === "account"
        ? (choice.rate ?? 0)
        : Math.max(choice.standard, choice.premium),
    reason,
  };
}

/** Ubicloud documents EPYC for Standard x64 and Ryzen for Premium x64. Unknown hardware fails closed. */
export function cpuFamily(model: string): Family | "unknown" {
  if (/\bAMD\b.*\bEPYC\b/i.test(model)) return "standard";
  if (/\bAMD\b.*\bRyzen\b/i.test(model)) return "premium";
  return "unknown";
}

export function hostCost(lease: NativeLease, minutes: number): number {
  let rate = lease.reservedMicros / (lease.policy.maxMinutes + 5);
  if (lease.expectedFamily && lease.expectedFamily !== "account") {
    if (lease.hostFamily === "standard")
      rate = lease.standardRateMicros ?? rate;
    if (lease.hostFamily === "premium") rate = lease.premiumRateMicros ?? rate;
  }
  return Math.ceil(minutes * rate);
}
