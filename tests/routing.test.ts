import { describe, expect, it } from "vitest";
import {
  candidatesFor,
  currentPeriod,
  planShards,
  previewRouting,
} from "../src/server/routing.js";
import { newAccount } from "../src/server/auth.js";
import {
  previewInputSchema,
  shardInputSchema,
  type Candidate,
} from "../src/shared/contracts.js";

const candidate = (changes: Partial<Candidate> = {}): Candidate => ({
  id: "one",
  name: "one",
  kind: "github",
  runner: "ubuntu-24.04",
  priority: 1,
  weight: 1,
  concurrency: 2,
  availableMinutes: 100,
  availableMicros: 0,
  rateMicros: 0,
  memoryGiB: 8,
  reason: null,
  ...changes,
});
const input = { jobs: 1, maxMinutes: 20, memoryGiB: 8, maxCostMicros: 0 };

describe("routing priorities and limits", () => {
  it("respects strict priority before available quota or price", () => {
    const result = previewRouting(
      [
        candidate({ id: "later", priority: 2, availableMinutes: 2000 }),
        candidate(),
      ],
      input,
    );
    expect(result.assignments[0]?.candidateId).toBe("one");
  });
  it("shares jobs across weighted capacity without changing its inputs", () => {
    const pool = [
      candidate({ id: "a", concurrency: 1 }),
      candidate({ id: "b", concurrency: 1 }),
    ];
    const result = previewRouting(pool, { ...input, jobs: 3 });
    expect(result.assignments.map((job) => job.candidateId)).toEqual([
      "a",
      "b",
      null,
    ]);
    expect(pool[0]?.availableMinutes).toBe(100);
  });
  it("uses configured weights within a shared tier", () => {
    expect(
      previewRouting(
        [candidate({ id: "a" }), candidate({ id: "b", weight: 2 })],
        input,
      ).assignments[0]?.candidateId,
    ).toBe("b");
  });
  it("backfills short jobs instead of assuming a large job will finish early", () => {
    const pool = [candidate({ availableMinutes: 10 })];
    expect(previewRouting(pool, input).assignments[0]?.candidateId).toBeNull();
    expect(
      previewRouting(pool, { ...input, maxMinutes: 10 }).assignments[0]
        ?.candidateId,
    ).toBe("one");
  });
  it("permits Ubicloud only within both the provider and request budgets", () => {
    const paid = candidate({
      id: "paid",
      kind: "ubicloud",
      rateMicros: 4000,
      availableMicros: 100_000,
      priority: 2,
      memoryGiB: 16,
    });
    expect(
      previewRouting([paid], input).assignments[0]?.candidateId,
    ).toBeNull();
    const result = previewRouting([paid], {
      ...input,
      jobs: 2,
      maxCostMicros: 100_000,
    });
    expect(result.assignments.map((job) => job.candidateId)).toEqual([
      "paid",
      null,
    ]);
    expect(result.estimatedCostMicros).toBe(80_000);
  });
  it("does not combine small workers to meet one job's memory requirement", () => {
    const pool = [candidate(), candidate({ id: "two" })];
    expect(
      previewRouting(pool, { ...input, memoryGiB: 16 }).assignments[0]
        ?.candidateId,
    ).toBeNull();
  });
  it("does not retry unavailable connections as another success", () => {
    const result = previewRouting(
      [candidate({ reason: "Account is paused." })],
      input,
    );
    expect(result.assignments[0]?.name).toBe("Waiting for capacity");
    expect(result.candidates[0]?.reason).toBe("Account is paused.");
  });
  it("prefers lower compute cost within equal priorities", () => {
    expect(
      previewRouting(
        [
          candidate({ id: "paid", rateMicros: 10, availableMicros: 10_000 }),
          candidate(),
        ],
        { ...input, maxCostMicros: 10_000 },
      ).assignments[0]?.candidateId,
    ).toBe("one");
  });
  it.each([
    { jobs: 0 },
    { jobs: 13 },
    { maxMinutes: -1 },
    { maxCostMicros: -1 },
    { memoryGiB: 0 },
  ])("rejects invalid planning inputs %o", (changes) => {
    expect(previewInputSchema.safeParse({ ...input, ...changes }).success).toBe(
      false,
    );
  });
});

describe("verified account capacity", () => {
  function readyAccount() {
    const account = newAccount(1, "owner", "owner");
    account.usedMinutes = 400;
    account.repositoryVerified = true;
    account.verifiedAt = Date.now();
    account.settings.allowanceConfirmed = true;
    account.settings.contributionMinutes = 1000;
    return account;
  }
  it("subtracts owner-wide use and personal reserves, then applies the contribution cap", () => {
    const account = readyAccount();
    expect(candidatesFor([account], [])[0]?.availableMinutes).toBe(1000);
    account.usedMinutes = 1500;
    expect(candidatesFor([account], [])[0]?.availableMinutes).toBe(300);
  });
  it("clamps exhausted capacity to zero", () => {
    const account = readyAccount();
    account.usedMinutes = 2500;
    expect(candidatesFor([account], [])[0]?.availableMinutes).toBe(0);
  });
  it.each(["paused", "draining"] as const)("excludes %s accounts", (state) => {
    const account = readyAccount();
    account.settings.state = state;
    expect(candidatesFor([account], [])[0]?.reason).toContain(state);
  });
  it("requires owner confirmation, a verified repository, and current fresh usage", () => {
    const account = readyAccount();
    account.settings.allowanceConfirmed = false;
    expect(candidatesFor([account], [])[0]?.reason).toContain("confirmed");
    account.settings.allowanceConfirmed = true;
    account.repositoryVerified = false;
    expect(candidatesFor([account], [])[0]?.reason).toContain("repository");
    account.repositoryVerified = true;
    account.verifiedAt = Date.now() - 16 * 60_000;
    expect(candidatesFor([account], [])[0]?.reason).toContain("fresh");
    account.period = "2000-01";
    expect(candidatesFor([account], [])[0]?.reason).toContain("month");
  });
  it("uses UTC calendar periods", () => {
    expect(currentPeriod(Date.parse("2026-01-31T23:59:59Z"))).toBe("2026-01");
  });
});

describe("balanced test groups", () => {
  const suites = [
    { name: "a", seconds: 100 },
    { name: "b", seconds: 80 },
    { name: "c", seconds: 50 },
    { name: "d", seconds: 30 },
  ];
  it("preserves every suite exactly once and balances independent durations", () => {
    const result = planShards({ suites, groups: 2 });
    expect(result.groups.flatMap((group) => group.suites).sort()).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
    expect(result.parallelSeconds).toBe(130);
    expect(result.serialSeconds).toBe(260);
  });
  it("does not generate empty groups or mutate caller order", () => {
    const result = planShards({ suites, groups: 8 });
    expect(result.groups).toHaveLength(4);
    expect(suites[0]?.name).toBe("a");
  });
  it("has deterministic tie ordering", () => {
    const first = planShards({
      suites: [
        { name: "z", seconds: 10 },
        { name: "a", seconds: 10 },
      ],
      groups: 2,
    });
    expect(first.groups[0]?.suites).toEqual(["a"]);
  });
  it.each([
    { suites: [], groups: 2 },
    { suites, groups: 0 },
    { suites: [suites[0], suites[0]], groups: 2 },
    { suites: [{ name: "a", seconds: -1 }], groups: 2 },
  ])("rejects missing, repeated or invalid suite plans %o", (value) => {
    expect(shardInputSchema.safeParse(value).success).toBe(false);
  });
  it("refuses an unchecked empty input", () => {
    expect(() => planShards({ suites: [], groups: 2 })).toThrow("At least one");
  });
});
