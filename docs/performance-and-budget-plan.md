# Performance and budget rollout

This is the next implementation plan, not a statement that these optimizations are already enabled. The objective is the shortest useful feedback time within contributed GitHub allowances and explicit paid limits. Account count alone is not a speed improvement.

## Starting point

Real private-source build and full active test runs have passed on Ubicloud. Multiple account connections, approved private workers, runtime reservations and bounded paid routing exist. The next contributing owner's worker setup is still pending. Automatic test execution across shards, coverage merging, cache reuse, normalized allowance balancing and original-check integration remain work to do.

The current router ranks eligible accounts by remaining minutes and weight. A temporarily busy or unverified free account can be excluded while a paid provider remains eligible. Completed local minutes are also retained conservatively on top of owner-wide billing, which can understate remaining capacity. Both behaviors need explicit treatment before claiming optimal free-first routing.

## Operating policy

| Decision                                            | Planned default                                                                                                          |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| GitHub accounts                                     | All consenting owners in priority 1; standard Linux workers only                                                         |
| Paid fallback                                       | Ubicloud in priority 2, subject to a separate opt-in per workload and monthly cap                                        |
| Free slots busy                                     | Queue for the next free slot; do not spill into paid workers                                                             |
| Billing stale, connection broken or consent missing | Refresh or request attention; this is not proof of exhausted allowance                                                   |
| Free minutes insufficient                           | First assign any smaller eligible required jobs that fit; paid fallback requires its configured authorization and budget |
| Paid limit exhausted                                | Wait visibly; required results remain pending and eventually fail at their overall deadline                              |
| Faster paid mode                                    | Optional, explicitly priced; never enabled by the optimizer itself                                                       |
| AWS and native GitHub overage                       | Disabled for this rollout                                                                                                |

Three owners with 3,000 + 2,000 + 2,000 included minutes offer a nominal 7,000 minutes per month. These are separate owner allowances. Usage in other repositories, personal reserves, active reservations and billing settlement reduce what BuildFerry can actually use. Each job must run in its consenting owner's private worker repository to use that owner's allowance. See [GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions).

Keep current owner reserves until settlement and provider spending controls are verified. Reserves are already visible and owner-editable; the default of 200 minutes per account would retain 600 minutes across three accounts. A lower reserve needs that owner's confirmation. A zero reserve cannot guarantee zero charges when another workflow spends concurrently. Verify GitHub's applicable spending stop on every contributing account; alerts alone do not stop usage. Retain the existing Ubicloud cap during development, with no automatic increase. [GitHub budget controls](https://docs.github.com/en/billing/how-tos/set-up-budgets).

## Delivery order and acceptance

### 1. Finish account setup and close paid-routing gaps

- Invite the third owner through a fresh one-use link. The existing second owner can use their current login.
- Each owner creates a fresh private `buildferry-ci` repository with a README, installs this instance's App on that repository, confirms their allowance and contribution, and approves the intended workloads. Existing CI repositories remain unchanged.
- Give each owner priority 1 and initially allow at most two concurrent jobs after their consent. Owners retain control of contribution, reserve and approvals.
- Distinguish busy, temporarily unverified, not configured and genuinely exhausted accounts. Add a free-first policy that waits through temporary free-capacity shortages. Paid-only benchmarks stay explicitly separate.
- Test concurrent reservations, stale billing, outside usage, unknown dispatch acceptance, month rollover, paused owners and paid-cap exhaustion. No case may become a duplicate dispatch, unapproved paid run or false passing check.
- Replace conservative double counting only after proving which completed runs a billing snapshot includes. Ambiguous usage stays reserved; an aggregate report increase alone is not sufficient evidence to release a particular reservation.

Acceptance: each newly configured owner executes an actual private-source job; simulated busy/free and stale/free cases create no paid dispatch; denied paid admission remains visible in the dashboard.

### 2. Remove repeated work before increasing parallelism

- Measure dependency installation, package compilation, typechecking, test execution, artifact transfer and cleanup separately on native GitHub. Capture cold and warm runs for the same revision and approved commands.
- Start with bounded provider-native dependency and compiler caches within each private worker repository. Reuse caches across compatible revisions, keyed by dependencies, toolchain, platform, recipe and trust boundary. Give exact build outputs the source revision as an additional identity.
- Reuse compiled shared packages for compatible build and test consumers where the dependency graph permits. Compare immutable artifact transfer against a local cached rebuild; do not assume cross-repository transfer is faster or cheaper.
- Maintain cache affinity: prefer a warm eligible owner when the setup saving outweighs the queue delay. Move work when capacity or allowance makes that necessary. Avoid rotating every job just to make account usage look equal.
- Bound retention and artifact size. GitHub storage can cost money separately from compute minutes. Do not add shared object storage or a permanently running build worker without measured justification.

Acceptance: cold, warm, cache-miss and changed-dependency paths all run correctly; no untrusted cache can affect trusted results; reuse demonstrably saves elapsed time or total minutes after transfer and storage costs.

### 3. Split tests using real durations and available free capacity

- Collect the complete required suite inventory and measured per-suite durations. Raise and test the current planner's 2,000-suite input ceiling before using it with a larger real suite.
- Start with two balanced test groups. Compare three and four only after measuring repeated setup and total rounded minutes. Fit test-process concurrency to actual CPU and memory; a standard private Linux worker has fewer CPUs than the current four-CPU Ubicloud profile. [Runner specifications](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).
- Build prerequisites once where useful, then run independent groups across ready accounts. Run an independent application build in parallel where resources permit. A dependency-bound build or typecheck is not made parallel merely by adding accounts.
- Aggregate every group for the exact revision and attempt. Require every required suite exactly once, retain the existing active-profile scope and skips, and merge coverage before evaluating the original thresholds. Missing groups, failures, timeouts or stale results fail the aggregate.
- Retry only a failed group for an identified infrastructure failure. Keep application failures visible and retain every attempt's cost. Cancel obsolete unprotected PR work only after verified stop; protected releases are excluded.

Acceptance: sharded and unsplit runs have matching required suite inventories, results and coverage policy. Choose the smallest group count that provides useful measured speed within the minute budget. Initial target: at least 25% lower median warm feedback time with no more than 10% extra rounded compute minutes. These are selection targets, not achieved results. Offer any more expensive speed setting separately.

### 4. Balance allowance consumption and expose the tradeoffs

- Allocate according to remaining contributed capacity, not equal raw job counts. At a clean month with no other usage, 3:2:2 is a reasonable starting distribution; outside usage and owner settings change the target.
- Rank within the free tier using measured queue delay, warm setup time, expected runtime and remaining-capacity balance. Keep deterministic tie breaking. Cache affinity may temporarily outweigh perfect balance; an owner must never exceed their approved limits.
- Preserve transactional worst-case reservations for admission. Use measured durations for choosing and sizing work, not as permission to spend beyond the bounded runtime.
- Show each owner's usable minutes, reservations, billing freshness, expected exhaustion date and reason a job is waiting. Show pipeline feedback time, total rounded worker minutes, cache-hit rate and estimated paid spend separately.
- Forecast demand against remaining days and capacity. Use the forecast to recommend a leaner parallel configuration before paid usage becomes necessary; do not impose a daily limit that strands usable monthly minutes.

Acceptance: deterministic scheduling scenarios cover three or more accounts, uneven external usage, warm-cache affinity, depleted accounts and recovery. Every route has an understandable explanation, and no scheduler score can promote an unauthorized paid tier.

### 5. Integrate once, keeping the original protections

- Keep pilots manual and bounded while proving parity. Running a duplicate full pipeline on every push would add cost before delivering savings.
- Prepare one reviewed source integration retaining existing check names, trusted producers, test and coverage scope, database validation, image publication and release dependencies. Keep production credentials and environment approvals in the protected source workflow.
- Replace a compute path only after the original check readers and branch rules recognize the verified delegated result. Avoid recurring full shadow runs once parity has been established.
- Subsequent account, contribution and fallback changes belong in BuildFerry; they should not require editing the source YAML.

Acceptance: missing or failed delegated work cannot pass any original gate; release and database protections remain identical; the migrated compute path runs once.

## Benchmark budget and evidence

Use available included GitHub minutes for repeated native measurements. Existing paid pilot results are a baseline only, not proof of a provider speed difference. Do not queue more paid comparisons when the current cap cannot admit them. A matched paid comparison needs an explicit remaining budget, the same revision, commands and scope, and separate cold/warm results.

Follow the [MVP evidence requirements](mvp-plan.md#faster-builds-and-tests): at least ten matched warm observations before a median speed claim and twenty before a p95 claim. Report inconclusive results as inconclusive. Development requires focused local tests; BuildFerry's optional full CI remains manual. This plan adds no new CI ceremony to the adopting project.
