# BuildFerry

BuildFerry brings a team's CI capacity into one self-hosted dashboard. Connect account owners, keep personal reserves, arrange fallback priorities, and plan balanced test groups.

**Status: early preview.** The first implementation supports connections and planning. It does **not** dispatch workflows, execute tests, write project checks, or deploy releases. Existing CI stays in place. See the [implementation status](docs/implementation-status.md) and [MVP plan](docs/mvp-plan.md) for the remaining work.

## Try the local demo

With Node 24 LTS and pnpm 10.26.1:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm demo
```

Open http://localhost:8787. Sample accounts are synthetic, stored in memory, and cannot contact providers or change connections. Routing and test-group previews work without credentials.

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
- Owner-wide Linux usage and private repository verification, with stale or unsupported usage excluded from previews.
- Ubicloud project and GitHub installation verification, configurable runner sizes, entered rates, and preview budgets.
- Budget-aware routing previews and deterministic test grouping from suite timings.

GitHub bills workflows to the repository owner; authorizing a second person does not move billing. Execution will require a private worker repository owned by each contributor. Public repositories already have free standard hosted runners. General cross-owner allowance-sharing policy remains an investigation item; this preview makes no claim of GitHub endorsement. [GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions).

## Develop and contribute

```sh
pnpm check
```

This runs lint, types, service tests with coverage, and the production build. See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md). Apache-2.0 licensed.
