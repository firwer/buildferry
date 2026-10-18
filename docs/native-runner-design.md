# Native GitHub runner interface

BuildFerry's target integration is a native runner broker. GitHub continues to execute the original workflow; BuildFerry provisions the machine that accepts each job. Account names and provider selection stay in the dashboard.

```yaml
jobs:
  test:
    runs-on:
      [
        buildferry,
        "buildferry-${{ github.run_id }}-${{ github.run_attempt }}-test",
      ]
    # Keep the original steps, permissions, timeouts and test groups.
  build:
    runs-on:
      [
        buildferry,
        "buildferry-${{ github.run_id }}-${{ github.run_attempt }}-build",
      ]
    # Job identity labels contain no account, provider or machine choice.
```

These are the intended production labels. The current live application still runs approved command recipes. Only isolated, manually provisioned native probes have run; installing BuildFerry does not yet make these labels available.

## Workflow and job settings

The dashboard loads a repository's real workflows and job names. Reading YAML supplies inventory and dependencies only; GitHub still interprets and executes all steps, conditions, matrices, reusable workflows and release environments. Unsupported inventory must be shown as unavailable, never guessed into a runnable substitute.

- A workflow sets its ordered providers, for example all free GitHub accounts, then Ubicloud, then explicitly budgeted paid GitHub on a designated account.
- A job override **replaces** the workflow provider list, including its own fallback list. A pinned-only job cannot escape to another provider. Capacity shortages keep it waiting, then fail visibly at the deadline.
- A job's explicit machine overrides the workflow machine, then the provider default. Only the requested size and its configured rate are eligible. No automatic upgrade or price copying between sizes.
- Budgets, account reserves and parallel limits still apply to every route. Paid GitHub overflow is a requested next adapter, not an available route today. AWS remains outside the current path.

A generic shared `buildferry` label is safe only when every matching queued job shares the same routing policy. GitHub may otherwise give a free-default job a host reserved for a paid-only job, or the reverse. Strict job overrides therefore require provider-independent labels that distinguish run, attempt and job, as above. Matrix axes must also distinguish demands when their policies or resources differ. The one-time integration adds these identity labels; subsequent provider or machine changes stay in the dashboard. Do not build the label from `github.job`: GitHub documents that property as available only inside execution steps. [GitHub contexts](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts).

## Responsibility boundary

| GitHub project workflow                                     | BuildFerry                                                          |
| ----------------------------------------------------------- | ------------------------------------------------------------------- |
| Commands, test inventory, parallel groups and dependencies  | Available worker accounts, provider tiers and resource profiles     |
| Job names, native checks and authoritative results          | Provisioning, admission, reservations and worker cleanup            |
| Environment approvals, credentials and release dependencies | Contribution limits, free-first placement and bounded paid fallback |
| Cache keys, artifacts and coverage aggregation              | Compatible machines and routing measurements                        |

Changing an account or fallback priority needs no source YAML change after initial adoption. Arbitrary sequential commands cannot automatically become independent jobs. Start with two balanced test groups in the project's existing test contract. An optional planning action can later select an approved group count from available capacity; it cannot omit required tests or raise a spend limit.

## Execution path

1. Receive a signed `workflow_job` queued event. Verify the installation, immutable source repository ID, workflow, attempt, trust policy and supported resource profile against GitHub. Maintain a durable, idempotent demand record.
2. Reserve one suitable machine. Default to included Linux capacity across consenting accounts. A busy free tier waits; missing or stale allowance data does not authorize paid usage. Ubicloud needs the configured fallback authorization and remaining budget.
3. Dispatch an approved outer launcher into the selected owner's private CI repository. For GitHub, that outer workflow consumes its owner's hosted minutes. For Ubicloud, its selected runner consumes the configured provider budget. Private source never runs in a public worker repository.
4. The launcher authenticates to BuildFerry using its independently verified GitHub identity. Deliver a single-use JIT runner configuration bound to the approved source repository, profile and launcher lease. It contains no long-lived account credential. Start the official runner in a fresh VM with a bounded lifetime.
5. GitHub assigns the original job directly to the runner. Checkout, actions, secrets, caches, logs, artifacts and job results use the source job's normal GitHub context. BuildFerry does not translate workflow steps or synthesize a passing native result.
6. Verify actual assignment by registered runner ID and the demand's identity labels. Never place incompatible job policies into one generic label pool. Record assignment and re-evaluate remaining demand; an unexpected assignment is an admission error, not a successful routing decision. Separate trust classes and resource profiles.
7. After one job, deregister the runner and terminate the outer host. Reconcile the outer provider duration, reservations and actual job assignment before releasing capacity. Persist uncertain dispatches and cancellations across restarts. Never launch a duplicate host merely because a response was lost.

GitHub documents [ephemeral runners, autoscaling events and registration permissions](https://docs.github.com/en/actions/reference/runners/self-hosted-runners). The [JIT API](https://docs.github.com/en/rest/actions/self-hosted-runners#create-configuration-for-a-just-in-time-runner-for-a-repository) returns a one-use runner configuration. These APIs are the runner lifecycle foundation; general cross-owner allowance eligibility is a separate provider-policy question retained in the MVP plan.

## Cost and performance implications

- Count the outer hosting workflow once for compute usage. Do not add the inner job duration as another hosted-minute charge.
- Original source-repository caches can be restored on fresh physical hosts. This reduces the need for separate caches for each contributing account or a new cache service. Compatible keys and trust boundaries still apply.
- Native artifacts and caches retain the source repository's storage accounting; moving compute does not move those charges. Bound artifact retention and cache size.
- Bootstrap and teardown consume host time. Prefer useful test groups over many tiny jobs; measure rounded total minutes as well as elapsed feedback time.
- Keep zero idle hosts by default. Cache reuse does not require permanently paid warm machines.
- Adding accounts increases available independent workers, not the CPU or memory of a single build process.

## Permissions and protections

The current GitHub App lacks repository Administration write. Automatic repository-scoped runner registration requires that additional permission. Prepare an explicit permission upgrade and owner approval before enabling native workers; do not quietly widen the installed App's access. Organization-scoped runners use a distinct self-hosted-runner permission, but organization billing is not part of this rollout.

Initially accept only reviewed project workflows and trusted events. Forks and untrusted jobs keep their established execution path. A worker owner must consent to the source project and native execution policy; approval of an old command recipe is not implicit approval of arbitrary project workflows. Bootstrap credentials must not survive into project commands. The dashboard never runs CI commands locally.

Keep existing production jobs and environment gates unchanged during the pilot. A later restricted release profile may supply a machine, while GitHub retains the same environment approvals, trusted workflow, permissions and dependencies. General team workers must not automatically become production workers. No native-runner change applies database DDL, changes a required check or triggers a deployment by itself.

## Evidence from real public probes

The manual [probe workflow](../.github/workflows/runner-probe.yml) uses the official runner with a verified download checksum, a one-use JIT configuration, a unique label, bounded timeouts and read-only source access. It executes public BuildFerry code only. No AWS or Ubicloud worker is used.

| Probe                                                                                             | Observed result                                                                                    |
| ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| [Native success](https://github.com/firwer/buildferry/actions/runs/39131169348)                   | Original checkout and artifact upload passed; the native job and downstream dependency gate passed |
| [Native failure](https://github.com/firwer/buildferry/actions/runs/39131474708)                   | The original job failed deliberately; the dependent job was skipped and the workflow failed        |
| [Cold cache](https://github.com/firwer/buildferry/actions/runs/39131619482)                       | A new physical host executed the original job and saved its repository cache                       |
| [Warm cache on another fresh host](https://github.com/firwer/buildferry/actions/runs/39131773078) | A different registered runner restored that cache and passed an explicit cache-hit assertion       |

The temporary probe credential was removed and the probe runners deregistered. These probes prove native job execution, result propagation and same-repository cache restore across fresh hosts. They do not prove automatic routing, another owner's private allowance consumption, provider fallback or a speed improvement on a real project. No private project workflow or release protection changed.

## Remaining implementation gates

1. Add durable native demand and host-lease handling to the existing control plane, using the current reservation and provider adapters. Keep the recipe pilot available while the native path is validated; avoid a general plugin framework or a second orchestration service.
2. Implement authenticated, one-use JIT delivery, exact launcher identity verification, bounded startup, deregistration, cancellation and restart reconciliation. Use per-lease delivery rather than the probe's temporary shared repository secret.
3. Prepare the App permission upgrade and source installation approval. Keep native routing disabled until the complete permission and owner-consent checks pass.
4. Prove native execution from a private source on each consenting account, plus approved Ubicloud fallback. Verify host accounting, native source identity and storage behavior across repositories.
5. Exercise busy-free waiting, unknown dispatches, webhook replay, revocation, cancellation, stale attempts and incompatible profiles. Prove that no missing host or result can pass a source gate.
6. Prepare one reviewed source change for logical runner labels and measured parallel test groups, retaining existing commands, checks, coverage and release dependencies. Reuse the original native cache steps before considering another cache backend.
