# Contributing

Use Node 24 LTS and the pnpm version pinned in `package.json`. Install with `pnpm install --frozen-lockfile`. For normal iteration, run the tests relevant to your change, plus lint and type checks when applicable, then push. BuildFerry's full GitHub CI is manual; it is not a prerequisite for every push or deployment. Tests use synthetic credentials and mocked provider requests; no real account access is needed.

Keep changes small, use TypeScript with validated API boundaries, and add focused tests for changed behavior. Use `pnpm check` for broader validation when needed. The optional coverage run checks 80% lines, statements and functions, and 75% branches. After building, `pnpm exec playwright install chromium` and `pnpm test:browser` provide desktop/mobile browser checks. The manual CI also checks container startup and recovery.

Run `pnpm format` before submitting changes. Describe the behavior and validation in the pull request. Do not commit credentials, account usage exports, private source, local databases, or keys. Use fictional examples in public docs. New dependencies must earn their place.

The source project's checks and release permissions are invariants. A worker cannot report itself successful without independent provider and immutable-audit verification. Never weaken a gate, bypass approvals, use production credentials in workers, or move a release step into this dashboard. BuildFerry publishes additional checks; replacing an adopter's original checks needs a separately reviewed integration and live validation. Keep worker provisioning restricted to fresh, dedicated private repositories and preserve uncertain-dispatch reservations.

See the [MVP plan](docs/mvp-plan.md) and [implementation status](docs/implementation-status.md) before extending scope. Contributions are under Apache-2.0.
