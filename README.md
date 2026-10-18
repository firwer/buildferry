# BuildFerry

BuildFerry routes independent builds and tests across a team's GitHub accounts, with Ubicloud as budgeted fallback. Each owner keeps control of their contribution, reserve, approved projects and parallel slots.

**Status: live pilot.** Self-hosting, GitHub App registration, two account authorizations, billing reads, private worker installation and Ubicloud dispatch have been exercised on a real deployment. An actual private-source build passed independent result verification and published its successful additional check. A full active test run reached its time limit; a resource-aware retry is running. A second owner's worker and matched provider benchmarks still need live validation. Existing project workflows and release gates stay in place; their migration is a separate reviewed step. See [implementation status](docs/implementation-status.md).

## Run locally

With Node 24 LTS and pnpm 10.26.1:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm build
pnpm start
```

Open http://localhost:8787. A fresh installation has no accounts, workloads or runs. Read its one-use setup code from startup logs. Public HTTPS is required for real GitHub setup and worker callbacks. Fixture data is available only through the isolated browser-test command.

## Self-host

```sh
cp .env.example .env
# Set BUILDFERRY_PUBLIC_URL to your HTTPS address in .env.
docker compose up -d --build
docker compose logs buildferry
```

Place the service behind your HTTPS reverse proxy and open that address. Claim the instance with the one-use code printed in its startup logs, then create your own GitHub App through the guided setup. Real connections require a publicly reachable HTTPS origin. Docker Compose builds locally; no published image is required.

The default Compose file exposes port 8787 on loopback and retains configuration and encrypted credentials in a named volume. Run one application instance per volume. Read [self-hosting and recovery](docs/self-hosting.md) for proxy, Coolify, backups, upgrades, and team setup.

## What works today

- GitHub App manifest setup, protected sign-in, one-use team invitations, and expiring user-token refresh.
- Multiple personal account connections, owner-confirmed allowances, contribution ceilings, reserves, priorities, weights, and parallel-slot limits.
- Owner-wide Linux usage and private repository verification, refreshed automatically while jobs are queued.
- Per-owner private workers with explicit project consent, pinned launcher revisions and narrowly scoped checkout credentials revoked before project commands run.
- Persistent priority queues, transactional worst-case reservations, parallel execution across accounts, uncertain-dispatch reconciliation and cancellation.
- Ubicloud project, installation and worker-repository verification; configurable runner size, monthly spend limit and per-workload paid limit. AWS is not used.
- Manual runs and opt-in default-branch push runs. Separate independent builds or test groups into named workloads using the dashboard.
- Additional GitHub checks published only after independent run, step and immutable-checkout evidence verification. Worker logs, measured queue/command time, rounded minutes and configured-rate cost are visible in run history.
- Explicit GitHub-only and Ubicloud benchmark routes for comparing the same revision and approved commands. No performance improvement is claimed without measurements.

GitHub bills each workflow to its repository owner. Every contributor creates a fresh private CI repository with a README, installs the instance's GitHub App on it, then approves the source workloads they will run. BuildFerry refuses to overwrite a repository with existing CI runs or workflows. Public source repositories already have free standard hosted runners. [GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions).

Reservations deliberately stay conservative when billing is delayed: completed BuildFerry usage remains counted locally, so it can temporarily overlap reported owner-wide usage. Keep GitHub's own spending controls and a reserve for workflows outside BuildFerry. The current test planner does not execute shards or merge coverage automatically. Keep those original checks until a reviewed integration proves complete results.

## Develop and contribute

```sh
pnpm check
```

This optional full check runs lint, types, service tests with coverage, and the production build. For everyday iteration, run focused checks and push; the full GitHub workflow is manual. Adopting projects keep their own checks and release approvals. See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md). Apache-2.0 licensed.
