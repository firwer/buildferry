# Self-hosting BuildFerry

The current release connects accounts and previews routing. It does not move CI workloads. Use one service instance and one persistent volume, behind HTTPS. Node 24's built-in SQLite module avoids native add-on builds; it currently emits an experimental-feature warning.

## Docker Compose

Requirements: Docker with Compose, a public HTTPS hostname, an HTTPS reverse proxy, and outbound HTTPS access to GitHub and Ubicloud APIs. No AWS services or credentials are needed.

1. Clone this repository and copy `.env.example` to `.env`.
2. Set `BUILDFERRY_PUBLIC_URL=https://buildferry.example.com`, using your actual origin, with no path. The proxy must forward the original Host and traffic to port 8787. The configured public origin controls callback URLs and mutation-origin checks; forwarded headers cannot change it.
3. Run `docker compose up -d --build`.
4. Point the reverse proxy at `127.0.0.1:8787`. A proxy running in a separate container should instead share a private Docker network and reach `buildferry:8787`; adapt the port/network configuration accordingly.
5. Read `docker compose logs buildferry`, open the HTTPS address, and enter the one-use setup code. Log access grants initial setup access. Do not publish the logs.

The container runs as a non-root user, drops capabilities, uses a read-only root filesystem, and writes only to `/data` and a temporary filesystem. Keep the named volume. Do not use `docker compose down --volumes` for upgrades. No prebuilt image is published by this first release; pin the repository revision you deploy.

## Guided GitHub connection

1. Choose a unique GitHub App name and continue on GitHub. The manifest supplies the callback, signed-webhook endpoint and read permissions. Register with the personal account that will own this instance; organization-owned apps are outside this release.
2. The app is public so consenting teammates can authorize it. Dashboard enrollment remains invitation-only. It requests **Plan: Read** for personal usage, plus **Actions: Read**, **Contents: Read**, and **Metadata: Read** for selected private repositories. It does not request administration, branch bypass, check writes, deployments, or production secrets.
3. Return to BuildFerry and sign in as the app's owner to finish claiming. Finish within the 30-minute setup session. If it expires, restart the service, use the new one-use setup code, and continue with the already registered app.
4. Use **Connections** to manage the app's selected repository installations. In **Team accounts**, set the private CI repository name, confirm the actual included allowance, and choose a reserve and contribution limit. Save and verify. Unsupported or inaccessible billing data keeps that account out of previews.
5. Create an invitation in **Connections**. Send the one-use link privately to the consenting teammate; it expires after one hour. They authorize the app themselves, install it on their chosen private CI repository, and configure their own contribution. Never exchange personal access tokens in chat or repository secrets for this setup.

The app registration flow must return to the same browser and origin that claimed setup. Do not put access tokens in URLs. OAuth credentials are encrypted in the service database. Disconnecting a member removes stored credentials and sessions; also revoke the authorization in GitHub when ending access. The instance owner can pause their contribution but cannot remove their own login.

An account's allowance belongs to the repository owner. The future execution path must run in that owner's private CI repository. This preview verifies access and ownership but does not install a worker or dispatch it.

## Ubicloud

Install Ubicloud's GitHub runner integration for the intended CI repository through Ubicloud first. In BuildFerry, connect its project ID and API token, choose a runner size, enter the actual per-minute rate for your tier and region, and set a preview budget. The token is encrypted and is never sent back to the browser.

BuildFerry verifies the project identity and its GitHub installations. This does not yet prove a specific repository can start a runner. Connecting or previewing creates no compute resources. Rates and budgets are entered estimates, not invoice or credit balances. [Ubicloud setup](https://www.ubicloud.com/docs/github-actions-integration/quickstart).

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

To restore, stop the service and restore the backup as `/data/buildferry.sqlite` with its original `/data/credentials.key`, both accessible only to the container user. Use a fresh volume or an offline replacement so no old `-wal` or `-shm` files are reused. Restart one service, check `/readyz`, sign in, and refresh connections. Run a restore exercise before depending on the installation. Application secrets and session state are in the backup; invalidate authorizations if a backup is exposed.

For a direct Node installation, `BUILDFERRY_DATA_DIR` defaults to `.data`. An optional `BUILDFERRY_ENCRYPTION_KEY` can supply the original 32-byte key as base64 through a secret manager; back up that value instead of a key file. The example Compose deployment uses the generated persistent key. Key rotation tooling is not implemented; do not replace the key on an existing database.

## Upgrade and troubleshoot

Back up the database and key before upgrading. Review release notes, build the intended revision, and recreate the service while retaining the volume. Startup applies versioned local schema additions; it refuses a database from a newer release. Downgrades require a matching pre-upgrade backup.

`/healthz` reports process health; `/readyz` also checks database access and reports `execution: disabled`. Usage verification expires after 15 minutes; select **Refresh** before previewing stale connections. Failed verification removes that account's eligibility. If startup reports a missing key, restore the original key; do not delete the database to hide the failure.

For local development, run `pnpm dev` and `pnpm dev:web` in separate terminals, set `BUILDFERRY_PUBLIC_URL=http://localhost:5173`, and open port 5173. The Vite proxy forwards sign-in and API routes to the service on 8787. Real GitHub setup needs a public HTTPS proxy with both dashboard and service on the same origin; the in-memory `pnpm demo` is the simpler UI exploration path.
