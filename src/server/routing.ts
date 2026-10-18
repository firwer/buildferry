import type {
  Account,
  Candidate,
  PreviewInput,
  PreviewResult,
  Provider,
  ShardInput,
  ShardResult,
  UbicloudRunner,
} from "../shared/contracts.js";

export const currentPeriod = (now = Date.now()) =>
  new Date(now).toISOString().slice(0, 7);
const freshnessMs = 15 * 60_000;

function accountReason(account: Account, now: number): string | null {
  if (account.settings.state !== "active")
    return `Account is ${account.settings.state}.`;
  if (!account.settings.allowanceConfirmed)
    return "Confirm this account's monthly minutes.";
  if (account.period !== currentPeriod(now))
    return "Refresh usage for this month.";
  if (
    account.usedMinutes === null ||
    account.verifiedAt === null ||
    now - account.verifiedAt > freshnessMs
  )
    return "Usage needs a fresh verification.";
  if (!account.repositoryVerified)
    return "Verify a private CI repository first.";
  return null;
}

/** Build capacity estimates only. These candidates never authorize or dispatch a worker. */
export function candidatesFor(
  accounts: readonly Account[],
  providers: readonly Provider[],
  now = Date.now(),
  ubicloudRunner?: UbicloudRunner,
): Candidate[] {
  const native = accounts.map((account) => ({
    id: `github:${account.id}`,
    name: account.login,
    kind: "github" as const,
    runner: "ubuntu-24.04",
    priority: account.settings.priority,
    weight: account.settings.weight,
    concurrency: account.settings.concurrency,
    capacityMinutes: Math.max(
      0,
      Math.min(
        account.settings.contributionMinutes,
        account.settings.includedMinutes - account.settings.reserveMinutes,
      ),
    ),
    availableMinutes: Math.max(
      0,
      Math.min(
        account.settings.contributionMinutes,
        account.settings.includedMinutes -
          (account.usedMinutes ?? account.settings.includedMinutes) -
          account.settings.reserveMinutes,
      ),
    ),
    availableMicros: 0,
    pendingMinutes:
      account.settings.state === "active" && accountReason(account, now)
        ? Math.max(
            0,
            Math.min(
              account.settings.contributionMinutes,
              account.settings.includedMinutes -
                account.settings.reserveMinutes,
            ),
          )
        : undefined,
    rateMicros: 0,
    memoryGiB: 8,
    reason: accountReason(account, now),
  }));
  const external = providers.map((provider) => {
    const runner = ubicloudRunner ?? provider.runner;
    const rateMicros =
      runner === provider.runner
        ? provider.rateMicros
        : provider.machineRates?.find((machine) => machine.runner === runner)
            ?.rateMicros;
    return {
      id: `ubicloud:${provider.projectId}:${runner}`,
      name: provider.name,
      kind: "ubicloud" as const,
      runner,
      priority: provider.priority,
      weight: 1,
      concurrency: 4,
      availableMinutes: 1_000_000,
      availableMicros: provider.budgetMicros,
      rateMicros: rateMicros ?? 0,
      memoryGiB: Number(runner.split("-").at(-1)) * 4,
      reason:
        rateMicros === undefined
          ? "Set a rate for the selected Ubicloud machine in Connections."
          : now - provider.verifiedAt > freshnessMs
            ? "Refresh this provider connection."
            : null,
    };
  });
  return [...native, ...external];
}

function exclusion(
  candidate: Candidate,
  input: PreviewInput,
  count: number,
  budget: number,
): string | null {
  if (candidate.reason) return candidate.reason;
  if (candidate.memoryGiB < input.memoryGiB)
    return "This job needs more memory.";
  if (count >= candidate.concurrency)
    return "All configured parallel slots are assigned.";
  if (candidate.availableMinutes < input.maxMinutes)
    return "The job does not fit the remaining minutes.";
  const cost = candidate.rateMicros * input.maxMinutes;
  if (cost > Math.min(budget, candidate.availableMicros))
    return "The estimated cost exceeds the budget.";
  return null;
}

/** Respect tiers and price, then balance the fraction of each owner's contributed allowance. */
function compareCandidates(left: Candidate, right: Candidate): number {
  return (
    left.priority - right.priority ||
    left.rateMicros - right.rateMicros ||
    (right.availableMinutes * right.weight) /
      Math.max(1, right.capacityMinutes ?? 1) -
      (left.availableMinutes * left.weight) /
        Math.max(1, left.capacityMinutes ?? 1) ||
    left.id.localeCompare(right.id, "en")
  );
}

/** Temporary free-capacity shortages must not silently authorize paid overflow. */
function pendingFreeReason(
  candidate: Candidate,
  input: PreviewInput,
  assigned: number,
): string | null {
  if (candidate.kind !== "github" || candidate.memoryGiB < input.memoryGiB)
    return null;
  const pending =
    candidate.pendingMinutes ??
    (!candidate.reason && assigned >= candidate.concurrency
      ? candidate.availableMinutes + assigned * input.maxMinutes
      : 0);
  if (pending < input.maxMinutes) return null;
  return `Waiting for ${candidate.name}'s free capacity. ${candidate.reason ?? "Current jobs still hold its free capacity."} Paid runners are on hold.`;
}

export function previewRouting(
  candidates: readonly Candidate[],
  input: PreviewInput,
): PreviewResult {
  const available = candidates.map((candidate) => ({ ...candidate }));
  const slots = new Map<string, number>();
  let budget = input.maxCostMicros;
  const assignments: PreviewResult["assignments"] = [];
  for (let job = 1; job <= input.jobs; job++) {
    const eligible = available.filter(
      (candidate) =>
        !exclusion(candidate, input, slots.get(candidate.id) ?? 0, budget),
    );
    eligible.sort(compareCandidates);
    let chosen = eligible.at(0);
    const waiting = available
      .filter(
        (candidate) =>
          (!chosen || candidate.priority <= chosen.priority) &&
          pendingFreeReason(candidate, input, slots.get(candidate.id) ?? 0),
      )
      .sort(compareCandidates)
      .at(0);
    if (chosen?.kind === "ubicloud" && waiting) chosen = undefined;
    if (!chosen) {
      assignments.push({
        job,
        candidateId: null,
        name: "Waiting for capacity",
        runner: null,
        costMicros: 0,
        reason: waiting
          ? (pendingFreeReason(waiting, input, slots.get(waiting.id) ?? 0) ??
            "Waiting for free capacity.")
          : "No allowed account or provider fits the remaining capacity, memory and budget.",
      });
      continue;
    }
    const costMicros = chosen.rateMicros * input.maxMinutes;
    assignments.push({
      job,
      candidateId: chosen.id,
      name: chosen.name,
      runner: chosen.runner,
      costMicros,
      reason: `Priority ${chosen.priority}; fits the maximum runtime and configured limits.`,
    });
    slots.set(chosen.id, (slots.get(chosen.id) ?? 0) + 1);
    chosen.availableMinutes -= input.maxMinutes;
    chosen.availableMicros -= costMicros;
    budget -= costMicros;
  }
  return {
    assignments,
    estimatedCostMicros: input.maxCostMicros - budget,
    candidates: candidates.map((candidate) => ({
      ...candidate,
      reason: exclusion(candidate, input, 0, input.maxCostMicros),
    })),
  };
}

/** Balance independent suites by duration, preserving every suite exactly once. */
export function planShards(input: ShardInput): ShardResult {
  if (input.suites.length === 0 || input.groups < 1)
    throw new Error("At least one test suite and group are required.");
  const groups = Array.from(
    { length: Math.min(input.groups, input.suites.length) },
    (_, index) => ({ id: index + 1, seconds: 0, suites: [] as string[] }),
  );
  const ordered = [...input.suites].sort(
    (left, right) =>
      right.seconds - left.seconds || left.name.localeCompare(right.name, "en"),
  );
  for (const suite of ordered) {
    const first = groups.at(0);
    if (!first) throw new Error("At least one test suite is required.");
    const target = groups.reduce(
      (best, group) => (group.seconds < best.seconds ? group : best),
      first,
    );
    target.suites.push(suite.name);
    target.seconds += suite.seconds;
  }
  return {
    groups,
    serialSeconds: input.suites.reduce((sum, suite) => sum + suite.seconds, 0),
    parallelSeconds: Math.max(...groups.map((group) => group.seconds)),
  };
}
