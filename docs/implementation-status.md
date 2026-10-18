# Implementation status

BuildFerry runs as an independent application on an existing Coolify server over valid HTTPS. Real GitHub App registration, owner and invited-member authorization, current-period billing reads, private worker installation and Ubicloud dispatch have passed live setup. Independent build and full-test workloads are executing against a real private source repository. Final results and the second owner's worker remain pending. No existing Wisbid workflow, worker repository, branch rule, required check, environment approval, database release or deployment has been changed.

| Area | Implemented | Validation or work still required |
| --- | --- | --- |
| Self hosting | One container and persistent volume; automatic encryption key; one-use claim; HTTPS setup; backup and restore tooling; successful independent Coolify deployment and live instance claim; controller upgrade during a running worker without duplicate dispatch | Exercise live backup/recovery |
| GitHub | Manifest App setup, invited PKCE sign-in, token rotation, owner-wide usage, scoped installation tokens; two real account authorizations and billing reads | Exercise live authorization expiry and reconnection |
| Workers | Explicit per-owner project approvals; fresh private repository guard; atomic launcher commit and pinned tag; signed, single-use worker claim; checkout credential revoked before commands; real private-source preparation and pre-command audit upload | Install and exercise the second owner's consenting worker |
| Routing | Durable priority queue, fair reconciliation, transactional runtime reservations, owner caps/reserves/slots, pause/drain, UTC period accounting, bounded paid fallback | Billing settlement currently remains conservative and can double-count completed local usage already present in the owner-wide report |
| Ubicloud | Project and installation checks; exact worker-repository preflight; monthly and per-job spend reservations; configured rate; real runners executing separate build and test recipes under a small spend cap | Matched benchmark against native GitHub; invoice reconciliation is not implemented |
| Results | Independent run, actor, attempt, revision, step and immutable pre-command audit checks; additional GitHub check; restart-safe finalization; cancellation race handling; live failed-run accounting, verified-stop reservation recovery and pre-dispatch cancellation | Live successful result publication, running cancellation and uncertain-response pilot evidence |
| Dashboard | Real workload setup, worker consent, queue/run/cancel controls, worker logs, measured queue/command time and rounded usage; live account, provider and private-source setup | Logs require the viewer's normal GitHub repository access |
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

1. Finish the second consenting account owner's fresh worker installation and workload approvals, then prove actual included-minute execution there.
2. Complete the live private-source build and full-test runs, independently verify their results and publish the additional checks.
3. Exercise running cancellation, uncertain-response recovery, authorization reconnection and live backup/restore. A stopped failed worker must be reverified before releasing held capacity; its failed result stays failed.
4. Compare repeated identical workloads on native GitHub and Ubicloud before making speed or cost claims. Current pilot workers start without the source project's existing CI caches. Retain original source checks until a reviewed bridge proves complete test and coverage parity.

The [MVP plan](mvp-plan.md) remains the broader acceptance contract. Implemented execution is not evidence that live acceptance, automatic shard/coverage aggregation, original check migration or a measured speed improvement has passed.
