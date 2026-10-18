# Implementation status

This first pull request implements connections and previews from the [MVP plan](mvp-plan.md). The full MVP is still in progress. No source project is migrated, and no existing workflow, branch rule, required check, environment approval, database release, or deployment is changed.

| Area | Implemented | Still required before live execution |
| --- | --- | --- |
| Self hosting | Single container, React dashboard, SQLite, automatic key creation, claim code, health checks, backup command | Real HTTPS onboarding and restore exercise on the chosen host |
| GitHub | Manifest registration, invited sign-in with PKCE, encrypted credentials, refresh, personal usage and private repository probes | Live two-owner probes, worker provisioning, short-lived installation tokens, source access, provider policy clarification |
| Accounts | Owner-managed allowance, contribution, reserve, state, priority, weight, parallel slots | Contribution spending ledger, transactional reservations, settling delayed billing, allowed projects, active-run draining |
| Ubicloud | Verify project and GitHub installations; one selected runner profile per project; entered rate and preview budget | Repository runner-access probe, actual dispatch, period spending ledger, invoice reconciliation |
| Routing | Stateless capacity preview, strict tiers, weighted remaining capacity, runtime/memory/budget/slot constraints | Durable queue, urgency, deadlines, reservations, dispatch correlation, leases, reconciliation, cancellation |
| Performance | Deterministic grouping from supplied independent-suite timings; every suite retained once | Real duration collection, worker sharding, coverage merge, artifact reuse, matched cold/warm runner benchmarks |
| Required checks | Existing project CI remains untouched; no check-write or dispatch permissions requested | Trusted source integration and independent verification retaining the original check producer and every release gate |

## Limits of the preview

Preview budgets and contribution caps are estimates for each preview. They are not a live spending ledger or an enforceable monthly budget. Two previews do not reserve capacity from each other. Paused and draining accounts both stop receiving preview assignments because there are no active jobs yet.

Usage must have been verified within 15 minutes for the current UTC month. This adapter counts owner-wide standard Linux Actions minute records. Unsupported minute SKUs fail closed, including other operating systems and larger runners. Storage is not counted as minutes. The included allowance is owner-confirmed because this endpoint does not provide a complete remaining-allowance contract. Usage can lag and other workflows can spend concurrently. Retain provider-side spending controls.

All invited members can see the team's connected account usage and configuration. Invite only teammates permitted to see those totals. Only an account owner can increase or change their contribution. The instance owner manages invitations and provider connections. This release has no viewer or project-level access roles.

The app requests read-only Actions, Contents, Metadata, and Plan permissions. Those permissions support observation; they cannot provision a worker workflow or dispatch a run. The next execution milestone must explicitly review the larger permission set. Ubicloud project access does not prove per-repository runner eligibility.

The test coverage report includes the service, shared contracts, and dashboard components and API client. Process entrypoints and the backup CLI are smoke-tested separately. Browser tests cover desktop and mobile layouts, routing previews and test grouping. Sample timings show a planning estimate, not a measured performance improvement.

## Next implementation sequence

1. Complete live provider investigation with consenting owners, without changing adopter CI. Record supported usage responses, billing lag, account permissions, worker source access, OIDC identities, cancellation and Ubicloud access.
2. Implement the reservation ledger and durable execution lifecycle with duplicate, restart, cancellation and uncertain-dispatch tests. Keep source credentials out of project code.
3. Add the stable source integration and trusted result verifier. Reject stale revisions, unexpected workers, altered audits, missing suites, or incomplete coverage. Keep release jobs in the original repository and its protected environments.
4. Benchmark identical workloads on standard GitHub and compatible Ubicloud workers, then roll out a reviewed opt-in pilot. Enable sharding only with complete-suite and merged-coverage evidence.
