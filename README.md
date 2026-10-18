# BuildFerry

BuildFerry routes independent builds and tests across a company's connected GitHub accounts, with Ubicloud as budgeted fallback. One administrator manages account minutes, reserves, machines and priorities. Each account owner authorizes GitHub access once.

**Status: working live pilot.** Self-hosting, GitHub App registration, two account authorizations, billing reads, private worker installation and Ubicloud dispatch have been exercised on a real deployment. An actual private-source build and full active test command passed independent result verification and published successful additional checks. An earlier test attempt reached its time limit and stayed failed; its resource-aware retry completed the original scope. A second owner's worker and matched provider benchmarks still need live validation. Existing project workflows and release gates stay in place; their migration is a separate reviewed step. See [implementation status](docs/implementation-status.md).

Next: [performance and budget rollout](docs/performance-and-budget-plan.md), covering three or more contributing accounts, free-first queueing, cache reuse, balanced test groups and measured speed-versus-minutes tradeoffs.

The preferred workflow interface is a [native runner broker](docs/native-runner-design.md): `runs-on: buildferry`, with original GitHub steps and results. Isolated live probes passed native execution, failure blocking and cache restore on fresh hosts. Automatic native routing remains under development.

## Run locally

With Node 24 LTS and pnpm 10.26.1:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm build
pnpm start
```

Open http://localhost:8787. A fresh installation has no accounts, workloads or runs. Set `BUILDFERRY_ADMIN_USERNAME` and `BUILDFERRY_ADMIN_PASSWORD` for administrator sign-in; without them, use the one-use setup code from startup logs and the original GitHub-owner login. Public HTTPS is required for real GitHub setup and worker callbacks. Fixture data is available only through the isolated browser-test command.

## Self-host

```sh
cp .env.example .env
# Set the HTTPS address and administrator credentials in .env.
docker compose up -d --build
docker compose logs buildferry
```

Place the service behind your HTTPS reverse proxy and open that address. Sign in with your administrator credentials, then create your own GitHub App through the guided setup. Real connections require a publicly reachable HTTPS origin. Docker Compose builds locally; no published image is required.

The default Compose file exposes port 8787 on loopback and retains configuration and encrypted credentials in a named volume. Run one application instance per volume. Read [self-hosting and recovery](docs/self-hosting.md) for proxy, Coolify, backups, upgrades, and team setup.

## What works today

- GitHub App manifest setup, protected sign-in, one-use team invitations, and expiring user-token refresh.
- One administrator login with environment variables; centrally managed account allowances, contribution ceilings, reserves, priorities, weights, and parallel-slot limits. Contributors finish on a simple account-connected screen.
- Owner-wide Linux usage and private repository verification, refreshed automatically while jobs are queued.
- Per-owner private workers with explicit project consent, pinned launcher revisions and narrowly scoped checkout credentials revoked before project commands run.
- Persistent priority queues, transactional worst-case reservations, parallel execution across accounts, uncertain-dispatch reconciliation and cancellation.
- Ubicloud project, installation and worker-repository verification; editable default machine, workload and per-run machine overrides, individual rates and spending limits. New connections start at 2 CPUs / 8 GB; automatic upsizing is disabled. AWS is not used.
- Manual runs and opt-in default-branch push runs. Separate independent builds or test groups into named workloads using the dashboard.
- Additional GitHub checks published only after independent run, step and immutable-checkout evidence verification. Worker logs, measured queue/command time, rounded minutes and configured-rate cost are visible in run history.
- Explicit GitHub-only and Ubicloud benchmark routes for comparing the same revision and approved commands. No performance improvement is claimed without measurements.

GitHub bills each workflow to its repository owner. After an account is connected and its App access approved, the administrator selects projects and sets up its worker. BuildFerry creates a fresh private CI repository with a README using GitHub's Repository creation permission. Existing Apps need that permission approved first; manual selection of an existing fresh private repository remains available. BuildFerry refuses to overwrite existing CI. Public source repositories already have free standard hosted runners. [GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions).

Reservations deliberately stay conservative when billing is delayed: completed BuildFerry usage remains counted locally, so it can temporarily overlap reported owner-wide usage. Keep GitHub's own spending controls and a reserve for workflows outside BuildFerry. The current test planner does not execute shards or merge coverage automatically. Keep those original checks until a reviewed integration proves complete results.

## Develop and contribute

```sh
pnpm check
```

This optional full check runs lint, types, service tests with coverage, and the production build. For everyday iteration, run focused checks and push; the full GitHub workflow is manual. Adopting projects keep their own checks and release approvals. See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md). Apache-2.0 licensed.
