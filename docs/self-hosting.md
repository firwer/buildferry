# Self-hosting BuildFerry

Use one service instance and one persistent volume behind HTTPS. BuildFerry supplies disposable runners to original GitHub workflow jobs using dedicated private worker repositories. Project code never runs on the dashboard host. Node 24's built-in SQLite module avoids native add-on builds; it currently emits an experimental-feature warning.

## Docker Compose

Requirements: Docker with Compose, a public HTTPS hostname, an HTTPS reverse proxy, and outbound HTTPS access to GitHub and Ubicloud APIs. No AWS services or credentials are needed.

1. Clone this repository and copy `.env.example` to `.env`.
2. Set `BUILDFERRY_PUBLIC_URL=https://buildferry.example.com`, using your actual origin, with no path. The proxy must forward the original Host and traffic to port 8787. The configured public origin controls callback URLs and mutation-origin checks; forwarded headers cannot change it.
3. Set `BUILDFERRY_ADMIN_USERNAME` and `BUILDFERRY_ADMIN_PASSWORD` (at least 12 characters), then run `docker compose up -d --build`. Store these values privately; do not commit `.env`.
4. Point the reverse proxy at `127.0.0.1:8787`. A proxy running in a separate container should instead share a private Docker network and reach `buildferry:8787`; adapt the port/network configuration accordingly.
   Set `BUILDFERRY_TRUST_PROXY_HOPS=1` when all requests go through this one trusted proxy. The proxy must append the real client IP to `X-Forwarded-For` and prevent clients from reaching the service directly. Leave this setting at `0` for direct local access. Do not trust arbitrary forwarded headers or enable a hop count without restricting direct network access. This lets rate limits distinguish teammates behind the same proxy; bundled assets are excluded from the limiter.
5. Open the HTTPS address and sign in with your administrator credentials. Existing installations without these variables retain GitHub-owner login and the one-use initial setup code. Enabling password login removes GitHub-owner sessions' administrator access; changing the credentials invalidates existing administrator sessions.

The container runs as a non-root user, drops capabilities, uses a read-only root filesystem, and writes only to `/data` and a temporary filesystem. Keep the named volume. Do not use `docker compose down --volumes` for upgrades. No prebuilt image is published by this first release; pin the repository revision you deploy.

## Connect GitHub and accounts

1. Register the GitHub App through the guided setup. Use a personal account to own the App. Return to the same browser and origin to finish setup.
2. Install the App on the source repositories you want to route. The manifest requests Plan and Metadata read; Actions, Contents, Workflows and Checks write; Repository creation write; and Administration write. GitHub requires Administration write for runner registration and removal. This is broad repository access; the native broker uses it only for runner operations. It does not change branch protections or production settings.
3. Open **Accounts**. The administrator sets each account's included monthly minutes, contribution, reserve and parallel limit. Saving confirms the allowance. Use **1. Connect accounts** to invite additional consenting owners. Each invitation lasts one hour and works once.
4. In **2. Set up runners**, choose an account and select **Install runner**. BuildFerry creates a fresh private `buildferry-ci` repository and installs a pinned launcher. GitHub grants the creating App access to that repository. Existing Apps or authorizations need newly added permissions accepted first; the account owner must reconnect when requested. Do not reuse an unrelated CI repository. An existing dedicated worker can be selected in account settings.
5. Wait for **Ready**, then open **Repositories** and refresh. Worker repositories are excluded from the project list. Select an actual workflow and inspect its jobs and dependencies.
6. Set workflow provider defaults, then any job-specific overrides. A job's provider list replaces the workflow list; unset fields inherit. Ubicloud machine precedence is job, workflow, provider default. A red **Not using BuildFerry** tag means the job's runner selection has not been connected. A routing setting alone does not rewrite YAML.
7. Make the one-time logical `runs-on` change described in [native runner design](native-runner-design.md). Keep original steps, checks, permissions, dependencies, environments and release gates. Enable routing for the workflow only after its account runners are ready. Start with a manual smoke test and a zero paid limit.

The dashboard has one administrator. GitHub account connection authorizes a contributor's worker and billing access; it does not grant them dashboard administration. No personal access tokens need to be exchanged. Credentials are encrypted in the database. Disconnecting an account removes its stored credentials; revoke the App authorization in GitHub when ending access.

Included minutes belong to each worker repository's owner. BuildFerry hosts the original source job on an official single-use GitHub runner inside that owner's worker workflow. GitHub still supplies the original repository's job context, permissions, secrets, caches and artifacts. The bootstrap receives a single-use runner configuration, never dashboard, billing or provider credentials.

## Ubicloud

Install Ubicloud's GitHub runner App on every intended worker repository. In **Providers**, connect the Ubicloud project and API token, choose its default machine, enter its actual rate and set a monthly spend limit. New connections default to Standard x64, 2 CPUs / 8 GB. Existing connections retain their choice. All five Standard and five Premium x64 sizes are selectable; additional machines require their own entered rates.

For Standard x64, turn off automatic Premium in Ubicloud's GitHub settings. An explicit native family choice checks the host CPU before private work starts. Until the host reports its family, admission holds enough budget for a possible Premium upgrade. An unexpected family stops the host rather than silently admitting work on it. A stopped host can still incur provider charges.

In **Repositories**, put GitHub first and Ubicloud second to use free minutes first. Set a nonzero maximum job cost only when paid fallback is intended. Temporary free-account shortages hold paid overflow; an exhausted allowance can fall back within both job and provider limits. Selecting a machine does not itself force a paid route. Unpriced or undersized machines wait instead of changing size. AWS and paid GitHub overflow are not implemented.

Changing policy does not reset spending or alter admitted jobs. Costs use entered rates and rounded physical host duration, including bootstrap time, rather than an invoice or credit balance. Compare the same revision, commands and machine repeatedly with warm and cold caches before claiming a speed improvement. [Ubicloud setup](https://www.ubicloud.com/docs/github-actions-integration/quickstart).

## Checks, limits and recovery

Native routing uses the original GitHub check results. BuildFerry does not publish replacement passing checks, change branch rules or bypass environment approvals. An original failed job stays failed even if the outer host workflow exits successfully. Dedicated production runners can remain outside BuildFerry and are marked in red.

Signed events and polling discover queued original jobs. Unknown dispatch acceptance keeps its reservation and is reconciled, never blindly retried on another account. Cancellation stops the original workflow and releases capacity only after the host is verified stopped. Restart recovery retains recorded intent. Do not delete the database to clear held capacity. Wait for active jobs before replacing a worker repository or updating its launcher.

Usage verification expires after 15 minutes and refreshes while work is queued. Attributed worker billing avoids subtracting the same completed minutes twice; missing attribution keeps conservative local holds. Other workflows can spend the owner's allowance concurrently. Keep GitHub's own spending controls and an appropriate reserve. The earlier recipe execution API remains for recorded pilot runs; it is separate from native routing.

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
