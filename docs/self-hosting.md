# Self-hosting BuildFerry

Use one service instance and one persistent volume behind HTTPS. BuildFerry runs approved commands only on private GitHub worker repositories, never on the dashboard host. Node 24's built-in SQLite module avoids native add-on builds; it currently emits an experimental-feature warning.

## Docker Compose

Requirements: Docker with Compose, a public HTTPS hostname, an HTTPS reverse proxy, and outbound HTTPS access to GitHub and Ubicloud APIs. No AWS services or credentials are needed.

1. Clone this repository and copy `.env.example` to `.env`.
2. Set `BUILDFERRY_PUBLIC_URL=https://buildferry.example.com`, using your actual origin, with no path. The proxy must forward the original Host and traffic to port 8787. The configured public origin controls callback URLs and mutation-origin checks; forwarded headers cannot change it.
3. Run `docker compose up -d --build`.
4. Point the reverse proxy at `127.0.0.1:8787`. A proxy running in a separate container should instead share a private Docker network and reach `buildferry:8787`; adapt the port/network configuration accordingly.
   Set `BUILDFERRY_TRUST_PROXY_HOPS=1` when all requests go through this one trusted proxy. The proxy must append the real client IP to `X-Forwarded-For` and prevent clients from reaching the service directly. Leave this setting at `0` for direct local access. Do not trust arbitrary forwarded headers or enable a hop count without restricting direct network access. This lets rate limits distinguish teammates behind the same proxy; bundled assets are excluded from the limiter.
5. Read `docker compose logs buildferry`, open the HTTPS address, and enter the one-use setup code. Log access grants initial setup access. Do not publish the logs.

The container runs as a non-root user, drops capabilities, uses a read-only root filesystem, and writes only to `/data` and a temporary filesystem. Keep the named volume. Do not use `docker compose down --volumes` for upgrades. No prebuilt image is published by this first release; pin the repository revision you deploy.

## Guided GitHub connection

1. Choose a unique GitHub App name and continue on GitHub. The manifest supplies the callbacks, signed-webhook endpoint and requested permissions. Register with the personal account that will own this instance; organization-owned apps are outside this release.
2. The app is public so consenting teammates can authorize it. Dashboard enrollment remains invitation-only. It requests **Plan: Read**, **Metadata: Read**, **Actions: Write** for dispatch and cancellation, **Contents: Write** plus **Workflows: Write** for owner-approved worker installation, and **Checks: Write** for its own additional results. It requests no administration, branch bypass, deployments or production secrets. Review these permissions during registration. An App created with the earlier read-only preview needs its permissions updated and approved on GitHub before worker installation.
3. Return to BuildFerry and sign in as the app's owner to finish claiming. Finish within the 30-minute setup session. If it expires, restart the service, use the new one-use setup code, and continue with the already registered app.
4. Create a fresh private CI repository with a README, such as `buildferry-ci`. Use **Connections** to install the App on that repository and your intended source repositories. In **Team accounts**, set the CI repository name, confirm the actual included allowance, and choose a reserve and contribution limit. Save and verify. Unsupported or inaccessible billing data prevents free-minute admission.
5. Create an invitation in **Connections**. Send the one-use link privately to the consenting teammate; it expires after one hour. They authorize the app themselves, install it on their chosen private CI repository, and configure their own contribution. Never exchange personal access tokens in chat or repository secrets for this setup.
6. In **Workloads and runs**, connect a source repository and enter its approved build/test commands, working folder, maximum runtime, memory need and per-run paid limit. Zero paid limit allows only free GitHub capacity. Use distinct workload names for independent builds and test groups in the same repository. Enable default-branch updates only when ready to run automatically.
7. Each account owner selects the workloads they approve in **Team accounts / Your worker**, then selects **Install worker and approve projects**. Installation writes the reviewed launcher only to a new private CI repository with no workflows or previous runs, and pins its revision. Existing CI repositories must not be reused.
8. Queue a workload and open its worker log. Test successful, failed and cancelled commands before depending on the instance. GitHub must be able to reach both worker callback endpoints over your public HTTPS address. Require an Actions runner compatible with Node 24.

The app registration flow must return to the same browser and origin that claimed setup. Do not put access tokens in URLs. OAuth credentials are encrypted in the service database. Disconnecting a member removes stored credentials and sessions; also revoke the authorization in GitHub when ending access. The instance owner can pause their contribution but cannot remove their own login.

An account's allowance belongs to its repository owner. Actual worker execution is billed in that owner's dedicated private CI repository. Source access uses a fresh read-only installation token; the server revokes it before project commands are admitted. Management, billing, provider and production credentials are never sent to workers. Account pause or drain stops new assignments; admitted jobs retain their configuration snapshot.

## Ubicloud

Install Ubicloud's GitHub runner integration for each intended worker repository through Ubicloud first. In BuildFerry, connect its project ID and API token, choose a runner size, enter the actual per-minute rate for your tier and region, and set a monthly spend limit. The token is encrypted and is never sent back to the browser or to a worker.

BuildFerry verifies the project identity and linked GitHub owner, then checks any existing worker record before paid dispatch. Ubicloud creates repository catalogue entries on the first queued job, so a catalogue 404 permits the first dispatch to an already approved worker; access denials and mismatched records remain blocked. Install Ubicloud's App on the worker repository during setup. Connecting creates no compute resources. Paid admission reserves the full maximum runtime against both the current UTC month's limit and the workload's paid limit. Costs use your entered rate, not an invoice or credit balance. [Ubicloud setup](https://www.ubicloud.com/docs/github-actions-integration/quickstart).

For a benchmark, queue the same workload at the same commit once with **Free GitHub minutes only**, then with **Ubicloud benchmark**. Run history shows actual queue time, command time and rounded worker minutes. Compare repeated warm and cold runs separately; changing memory, commands or toolchains changes the experiment. Independent workloads can run in parallel across the owners' configured slots. Suite discovery, automatic shard execution and coverage merging remain separate work; preserve the original complete test and SonarQube checks.

## Checks, limits and recovery

BuildFerry creates an additional `BuildFerry / <workload name>` check. It does not edit branch rules, required check lists, original workflow names, environment approvals or release/deployment steps. It does not automatically run pull requests. Adopting it as a required replacement needs a separately reviewed source integration and full-suite/coverage evidence.

Unknown dispatch acceptance never triggers another dispatch or fallback. Reservations remain held while GitHub is reconciled. Cancellation releases capacity only after a verified stop or a definitive pre-dispatch rejection. A run with mismatched provider identity fails and keeps uncertain capacity reserved for investigation. Inspect the provider run, then use **Verify stopped worker** to fetch fresh identity and completion evidence. A mismatch or a still-running worker keeps capacity held; successful stop verification records actual usage and leaves the failed result unchanged. Do not delete the database to free capacity. Restarts recover recorded dispatches and result publication.

An account owner can change approvals for future runs while their existing worker is busy. Running jobs retain their original worker and recipe snapshots. Replacing the worker repository still requires its active jobs to finish first.

Usage verification expires after 15 minutes and is refreshed approximately every five minutes while jobs are queued. Completed usage remains counted locally until settlement can be proved, so delayed billing can temporarily reduce usable free capacity. Other workflows can consume the same owner's allowance concurrently. Keep GitHub's own spending controls and a suitable reserve; BuildFerry's estimates do not replace them. AWS credentials and paid GitHub overflow are not supported in this release.

## Coolify

Create a separate application from this repository using the Dockerfile. Set `BUILDFERRY_PUBLIC_URL` to the application's HTTPS origin, expose container port 8787 to Coolify's private proxy, and mount a persistent volume at `/data` owned by UID/GID 1000. Set the health check to `/readyz`. Retain one replica. Keep BuildFerry independent from any source application's deployment and database.

## Storage, backup and restore

BuildFerry creates `/data/credentials.key` once and encrypts credentials with AES-256-GCM. The database stores sessions as hashes and pending authorization payloads encrypted. Protect the volume and host backups: the key and database together grant access to connected accounts. Losing the key requires reconnecting credentials; startup refuses a missing or incorrect key for an existing database.

Create a consistent online database backup, then copy it out of the container:

```sh
docker compose exec buildferry node dist/server/backup.js /data/buildferry-backup.sqlite
docker compose cp buildferry:/data/buildferry-backup.sqlite ./buildferry-backup.sqlite
docker compose cp buildferry:/data/credentials.key ./credentials.key
```

Store the key separately from database backups with restricted access. The backup command does not copy the key. Remove exported copies from shared working directories after moving them to secure backup storage.

Use a new backup filename each time. Backups are published atomically without replacing an existing file. An interrupted backup can leave a `.buildferry-backup-*.sqlite` temporary file beside the intended destination; remove that temporary file only after confirming its backup process has stopped.

To restore, stop the service and restore the backup as `/data/buildferry.sqlite` with its original `/data/credentials.key`, both accessible only to the container user. Use a fresh volume or an offline replacement so no old `-wal` or `-shm` files are reused. Restart one service, check `/readyz`, sign in, and refresh connections. Run a restore exercise before depending on the installation. Application secrets and session state are in the backup; invalidate authorizations if a backup is exposed.

For a direct Node installation, `BUILDFERRY_DATA_DIR` defaults to `.data`. An optional `BUILDFERRY_ENCRYPTION_KEY` can supply the original 32-byte key as base64 through a secret manager; back up that value instead of a key file. The example Compose deployment uses the generated persistent key. Key rotation tooling is not implemented; do not replace the key on an existing database.

## Upgrade and troubleshoot

Back up the database and key before upgrading. Review release notes, build the intended revision, and recreate the service while retaining the volume. Startup applies versioned local schema additions; it refuses a database from a newer release. Downgrades require a matching pre-upgrade backup.

`/healthz` reports process health; `/readyz` checks database access and reports `execution: enabled` for a real instance. This indicates the controller is enabled, not that accounts, workers or a pilot have passed live validation. Failed connection verification removes eligibility. If startup reports a missing key, restore the original key; do not delete the database to hide the failure.

For local development, run `pnpm build` once to compile the standalone worker helpers, then `pnpm dev` and `pnpm dev:web` in separate terminals. Set `BUILDFERRY_PUBLIC_URL=http://localhost:5173` and open port 5173. The Vite proxy forwards API and sign-in routes to port 8787. Real GitHub setup requires public HTTPS with both dashboard and service on the same origin. Normal startup has no seeded data; `pnpm test:browser` uses an isolated test-only fixture process on port 8798.
