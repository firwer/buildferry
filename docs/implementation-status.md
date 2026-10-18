# Implementation status

BuildFerry now implements the actual execution path. Deployment and a real two-owner pilot remain unverified; this document does not claim they have happened. No existing Wisbid workflow, worker repository, branch rule, required check, environment approval, database release or deployment has been changed.

| Area | Implemented | Validation or work still required |
| --- | --- | --- |
| Self hosting | One container and persistent volume; automatic encryption key; one-use claim; HTTPS setup; backup and restore tooling | Deploy separately on the selected Coolify server and exercise real HTTPS onboarding and recovery |
| GitHub | Manifest App setup, invited PKCE sign-in, token rotation, owner-wide usage, scoped installation tokens | Live owner and cofounder authorization with the execution permission set |
| Workers | Explicit per-owner project approvals; fresh private repository guard; atomic launcher commit and pinned tag; signed, single-use worker claim; checkout credential revoked before commands | Install on fresh, consenting worker repositories; prove live OIDC claim shape and revocation |
| Routing | Durable priority queue, fair reconciliation, transactional runtime reservations, owner caps/reserves/slots, pause/drain, UTC period accounting, bounded paid fallback | Billing settlement currently remains conservative and can double-count completed local usage already present in the owner-wide report |
| Ubicloud | Project and installation checks; exact worker-repository preflight; monthly and per-job spend reservations; configured rate | Real worker dispatch and matched benchmark against native GitHub; invoice reconciliation is not implemented |
| Results | Independent run, actor, attempt, revision, step and immutable pre-command audit checks; additional GitHub check; restart-safe finalization; cancellation race handling | Live success, failure, cancellation and uncertain-response pilot evidence |
| Dashboard | Real workload setup, worker consent, queue/run/cancel controls, worker logs, measured queue/command time and rounded usage | Live provider usability exercise; logs require the viewer's normal GitHub repository access |
| Existing checks | Original workflows, required checks, approvals and release jobs untouched | Trusted source bridge, original check-producer parity, automatic test sharding and merged coverage before replacing any original check |

## Scope and limits

Normal startup has no example accounts, fabricated runs or sample timings. Synthetic accounts and credentials exist only in automated test fixtures. The separate fixture server requires the test environment and loopback; it cannot dispatch or modify provider connections.

The source owner defines approved command recipes. Each named workload is independent, with no implicit dependency graph. Several workloads on the same source repository can run concurrently across separately consenting owners. Manual runs pin an exact commit; optional signed default-branch pushes enqueue the configured workloads idempotently. Pull-request automation is not enabled.

The controller records intent before external mutations. A lost dispatch response is reconciled; it is never blindly retried or routed elsewhere. Unknown acceptance keeps its capacity reserved. A failed application command stays failed. Cancellation and publication have durable states so cancellation cannot race into a false success. Provider identity mismatches fail closed and retain uncertain capacity for investigation.

The worker launcher, source revision and recipe are snapshotted per run. Its one-use GitHub identity must match the immutable repository IDs, approved worker revision, tag, accepted run ID and first attempt. The server revokes a fresh source-only read token before project commands run. The audit is uploaded as an immutable artifact before project code and is verified independently alongside GitHub's job and step results. Callback responses and project output cannot report success.

Account usage must be current for the UTC month and verified within 15 minutes. Queued work refreshes eligible connections roughly every five minutes, with retry backoff. Unsupported minute SKUs fail closed. The owner confirms their included allowance; this API does not provide a complete remaining-allowance contract. Other workflows can spend concurrently. Retain GitHub spending controls and a reserve. Local completed usage remains counted conservatively until billing settlement is proved, which can reduce usable capacity temporarily.

All invited members can view team account usage and workload configuration. Only the account owner can change their contribution or worker approvals. The instance owner controls workload commands, invitations and paid providers. There are no viewer roles or project-level dashboard isolation yet; invite trusted teammates only.

App permissions are Plan and Metadata read, plus Actions, Contents, Workflows and Checks write. Tokens issued for checkout are narrowed to one source repository and Contents read only; worker dispatch tokens are narrowed to one worker repository. No administration, branch bypass, deployments or production secrets are requested.

## Acceptance still pending

1. Restore the desktop browser/Coolify connection, inspect actual existing server load, and deploy a new independent app at the chosen HTTPS origin.
2. Complete real App registration, owner and cofounder consent, billing verification and fresh worker installation without changing an existing CI worker.
3. Run real success, failure and cancellation cases on both owners, plus a budgeted Ubicloud run. Verify results, billing ownership and restart recovery.
4. Compare repeated identical workloads before making speed or cost claims. Retain original source checks until a reviewed bridge proves complete test and coverage parity.

The [MVP plan](mvp-plan.md) remains the broader acceptance contract. Implemented execution is not evidence that live acceptance, automatic shard/coverage aggregation, original check migration or a measured speed improvement has passed.
