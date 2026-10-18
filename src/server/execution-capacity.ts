import type { Account, Candidate, Provider } from "../shared/contracts.js";
import type { Job, Worker } from "../shared/execution.js";
import { candidatesFor, currentPeriod } from "./routing.js";

export const activeJob = (job: Job) =>
  !["succeeded", "failed", "cancelled"].includes(job.state);
export const holdsSlot = (job: Job) =>
  job.accountId !== null && !job.cancellationConfirmed;

/** Admission uses current owner consent and the immutable, separately approved worker. */
export function eligibleWorkers(
  job: Job,
  workers: readonly Worker[],
  accounts: readonly Account[],
  jobs: readonly Job[],
): Worker[] {
  return workers.filter((worker) => {
    const account = accounts.find((value) => value.id === worker.accountId);
    return (
      worker.ready &&
      worker.allowedProjects.includes(job.projectId) &&
      account?.settings.state === "active" &&
      account.repositoryVerified &&
      worker.repository.toLowerCase() ===
        `${account.login}/${account.settings.workerRepository}`.toLowerCase() &&
      jobs.filter((value) => value.accountId === account.id && holdsSlot(value))
        .length < account.settings.concurrency
    );
  });
}

/** Unsettled reservations stay charged locally even when provider billing has not caught up. */
export function executionCapacity(
  job: Job,
  workers: readonly Worker[],
  accounts: readonly Account[],
  providers: readonly Provider[],
  jobs: readonly Job[],
): { candidates: Candidate[]; eligible: Worker[] } {
  const eligible = eligibleWorkers(job, workers, accounts, jobs);
  const periodJobs = jobs.filter(
    (value) => value.period === currentPeriod() || holdsSlot(value),
  );
  const candidates = candidatesFor(
    accounts,
    providers,
    Date.now(),
    job.ubicloudRunner ?? job.recipe.ubicloudRunner,
  ).map((candidate) => {
    const id = candidate.id.split(":")[1];
    if (candidate.kind === "github") {
      const accountId = Number(id);
      const ownerJobs = periodJobs.filter(
        (value) => value.accountId === accountId && value.providerId === null,
      );
      const spent = ownerJobs.reduce(
        (sum, value) => sum + (value.actualMinutes ?? value.reservedMinutes),
        0,
      );
      // Potential releases defer paid fallback; they never increase spendable capacity.
      const unsettled = ownerJobs
        .filter((value) => value.actualMinutes === null && holdsSlot(value))
        .reduce((sum, value) => sum + value.reservedMinutes, 0);
      const slotAvailable = eligible.some(
        (worker) => worker.accountId === accountId,
      );
      if (!slotAvailable)
        candidate.reason ??=
          "No approved worker slot is available for this project.";
      if (
        accounts.find((account) => account.id === accountId)?.settings.state ===
          "active" &&
        (candidate.pendingMinutes !== undefined ||
          !slotAvailable ||
          unsettled > 0)
      )
        candidate.pendingMinutes = Math.max(
          0,
          (candidate.pendingMinutes ?? candidate.availableMinutes) -
            spent +
            unsettled,
        );
      candidate.availableMinutes = Math.max(
        0,
        candidate.availableMinutes - spent,
      );
      candidate.concurrency = 1;
    } else {
      const provider = providers.find((value) => value.projectId === id);
      const spend = periodJobs
        .filter((value) => value.providerId === id)
        .reduce(
          (sum, value) => sum + (value.actualMicros ?? value.reservedMicros),
          0,
        );
      candidate.availableMicros = Math.max(
        0,
        candidate.availableMicros - spend,
      );
      candidate.concurrency = Math.max(
        0,
        candidate.concurrency -
          jobs.filter((value) => value.providerId === id && holdsSlot(value))
            .length,
      );
      if (
        !eligible.some((worker) =>
          provider?.installations.some(
            (installation) =>
              installation.name.toLowerCase() ===
              worker.repository.split("/")[0]?.toLowerCase(),
          ),
        )
      )
        candidate.reason =
          "No approved worker is linked to this Ubicloud project.";
    }
    return candidate;
  });
  return { candidates, eligible };
}
