import { newAccount } from "./auth.js";
import type { Store } from "./store.js";
import { currentPeriod } from "./routing.js";

/** Isolated sample data: no token, repository, or worker can execute from demo mode. */
export function seedDemo(store: Store): void {
  store.put("config", "owner", 1);
  for (const [index, login] of ["avery", "morgan", "samira"].entries()) {
    const account = newAccount(
      index + 1,
      login,
      index === 0 ? "owner" : "member",
    );
    account.settings.includedMinutes = index === 0 ? 3000 : 2000;
    account.settings.allowanceConfirmed = true;
    account.settings.workerRepository = "buildferry-ci";
    account.usedMinutes = [940, 420, 1870].at(index) ?? 0;
    account.verifiedAt = Date.now();
    account.repositoryVerified = true;
    account.message = "Sample account. No GitHub connection or runner exists.";
    store.put("account", String(account.id), account);
  }
  store.put("provider", "pj000000000000000000000000", {
    projectId: "pj000000000000000000000000",
    name: "Team build cloud",
    runner: "ubicloud-standard-4",
    priority: 2,
    rateMicros: 4000,
    budgetMicros: 5_000_000,
    verifiedAt: Date.now(),
    installations: [{ id: "demo", name: "Sample team" }],
  });
  store.audit(
    `Sample capacity prepared for ${currentPeriod()}. No jobs have been submitted.`,
  );
}
