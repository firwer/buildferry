# Contributing

Use Node 24 LTS and the pnpm version pinned in `package.json`. Run `pnpm install --frozen-lockfile`, then `pnpm check`. Tests use synthetic credentials and mocked provider requests; no real account access is needed.

Keep changes small, use TypeScript with validated API boundaries, and add tests for changed behavior. Service, contract, and dashboard coverage is enforced at 80% lines, statements and functions, and 75% branches. After building, run `pnpm exec playwright install chromium` and `pnpm test:browser` for desktop/mobile browser checks. Process entrypoints and backup are verified by smoke tests.

Run `pnpm format` before submitting changes. Describe the behavior and validation in the pull request. Do not commit credentials, account usage exports, private source, local databases, or keys. Use fictional examples in public docs. New dependencies must earn their place.

The source project's checks and release permissions are invariants. A worker cannot report itself successful without independent source-side verification. Never weaken a gate, bypass approvals, use production credentials in workers, or move a release step into this dashboard. The current preview deliberately cannot execute jobs; complete the provider investigation and result-verification design before enabling that boundary.

See the [MVP plan](docs/mvp-plan.md) and [implementation status](docs/implementation-status.md) before extending scope. Contributions are under Apache-2.0.
