# TorHQ

TorHQ is a self-hosted **control plane** for a Proxmox media homelab. It gives you
one authenticated web UI in front of the services you already run — Radarr,
Sonarr, Lidarr, Prowlarr, qBittorrent, slskd, Jellyfin, Navidrome, and Kavita —
plus a small, deliberately-scoped **manual intake** pipeline for content those
tools don't manage (loose books, manga, and Soulseek music).

It also includes a **torrent-search widget**: search a torrent-index site (e.g. a
KickassTorrents mirror) from inside TorHQ and send a chosen magnet straight to
qBittorrent — either as a raw grab you own, or tagged with an \*arr's category so
that \*arr adopts and imports it.

TorHQ is built to sit quietly next to your existing stack. It **observes and
requests**, and performs only explicit, user-initiated grabs — it does not take
over your \*arr apps' pipelines.

> **The core boundary.** TorHQ **never moves, renames, or reorganizes media owned
> by the \*arr applications.** Radarr/Sonarr/Lidarr own search, grab, import,
> rename, and final placement of everything they manage. TorHQ only performs its
> own explicit, previewed, approved **manual-intake** action, and every filesystem
> operation is confined to the directories listed in `TORHQ_APPROVED_ROOTS`.

---

## Table of contents

- [What TorHQ does](#what-torhq-does)
- [Architecture](#architecture)
- [The intake boundary](#the-intake-boundary-torhq-vs-the-arr)
- [Local development](#local-development)
- [Environment variables](#environment-variables)
- [First-run setup](#first-run-setup)
- [Production deployment (LXC)](#production-deployment-lxc)
- [Backup & restore](#backup--restore)
- [Security model](#security-model)
- [API](#api)
- [Project layout](#project-layout)

---

## What TorHQ does

| Area | Capability |
| --- | --- |
| **Dashboard** | Aggregated service health, qBittorrent downloads grouped by category, \*arr activity (history + wanted/missing), slskd downloads, storage usage, and failed-import surfacing. |
| **Requests** | Search Radarr/Sonarr/Lidarr, **choose the intended result**, and submit an add+search request. TorHQ asks; the \*arr does the work. |
| **Torrent search** | Search a configurable torrent-index site and **send a chosen magnet straight to qBittorrent** — into a neutral `torhq-manual` category, or tagged `radarr`/`sonarr`/`lidarr` so that \*arr adopts and imports it. |
| **Manual intake** | Preview and then atomically import a completed file/folder into a **Kavita** (books/manga/comics) or **Navidrome** (music) library, then trigger a rescan. Durable, idempotent, retried. |
| **slskd webhook** | Completed Soulseek downloads are pushed to `/webhooks/slskd` (shared-token auth) and enqueued as intake jobs into a music library. |
| **Services** | Encrypted-at-rest credential storage with a connection tester. Secrets are never returned to the browser. |

---

## Architecture

TorHQ is a TypeScript monorepo (npm workspaces, Node 20+).

```
┌─────────────────────────────┐        ┌──────────────────────────────────┐
│  web  (React + Vite SPA)    │  fetch │  server  (Fastify)               │
│  session cookie + CSRF hdr  │ ─────▶ │  ┌────────────────────────────┐  │
└─────────────────────────────┘        │  │ auth  session + CSRF       │  │
        served as static files         │  │ routes  REST + webhooks    │  │
        by the server in prod          │  │ adapters  service HTTP     │  │
                                        │  │ queue  durable intake jobs │  │
                                        │  │ security  path containment │  │
                                        │  └────────────────────────────┘  │
                                        │  SQLite (better-sqlite3 + Drizzle)│
                                        └──────────────────────────────────┘
                                                     │  outbound HTTP
                     ┌───────────────────────────────┼───────────────────────────────┐
                 Radarr/Sonarr/Lidarr   Prowlarr  qBittorrent  slskd   Jellyfin/Navidrome/Kavita
```

- **Backend** — Fastify 4 with `@fastify/cookie`, `@fastify/rate-limit`, and
  `@fastify/static`. Data lives in SQLite via `better-sqlite3` with a Drizzle
  schema. Service credentials are encrypted at rest (AES-256-GCM). A single
  in-process worker drains a durable, SQLite-backed job queue.
- **Frontend** — React 18 + Vite single-page app. In production the server serves
  the built assets from `web/dist` on the same origin (no CORS), so the session
  cookie and CSRF token cover the whole app.
- **Adapters** — one small typed HTTP client per service, all implementing a
  common `ServiceAdapter` health contract, constructed on demand from the
  decrypted, per-service config.
- **Portability** — the schema avoids SQLite-only tricks (epoch-ms integer
  timestamps, JSON stored as text) so it can move to Postgres later.

### Data model

| Table | Purpose |
| --- | --- |
| `users` | Single admin account (scrypt password hash). |
| `sessions` | Server-side sessions with a per-session CSRF token. |
| `services` | One row per configured service; secret **encrypted**, adapter config as JSON. |
| `libraries` | Manual-intake destinations (Kavita/Navidrome) with dest + staging paths. |
| `jobs` | Durable intake queue: status, attempts, backoff, idempotency key. |
| `activity` | Append-only audit/activity timeline for jobs and requests. |
| `schema_migrations` | Applied forward-only migration versions. |

---

## The intake boundary (TorHQ vs. the \*arr)

This is the most important thing to understand about TorHQ.

**\*arr-owned media (movies, TV, \*arr-managed music).**
Radarr, Sonarr, and Lidarr fully own their download → import → rename → placement
pipeline. TorHQ's role is limited to **requesting** an add+search through their
APIs. TorHQ never reads, moves, renames, or deletes files that an \*arr manages,
and it never writes into an \*arr root folder. Doing so would corrupt the \*arr's
own bookkeeping and hard-linking.

**TorHQ-owned intake (loose books, manga, comics, Soulseek music).**
Some content has no \*arr. For those, TorHQ offers a manual-intake pipeline that
is explicit and previewed end-to-end:

1. You (or the slskd webhook) name a **source path** inside an approved root.
2. TorHQ builds a **dry-run preview**: it validates containment, rejects symlink
   escapes, and lists exactly what will be imported.
3. On approval, a durable job **atomically imports** the content into the
   library's destination via a same-filesystem staging directory, then requests a
   **rescan** of the target service (Kavita or Navidrome).

Manual-intake destinations may only target **Kavita** or **Navidrome**. Jellyfin
(movies/TV) is intentionally *not* an intake target — that content is \*arr-owned.
TorHQ integrates with Jellyfin for health/status only.

Every path is checked with defense-in-depth containment (lexical `..` collapse,
prefix-aliasing-safe root check, and `realpath` symlink-escape rejection) against
`TORHQ_APPROVED_ROOTS`. There are no destructive media operations beyond this one
previewed, approved import.

---

## Torrent search & grab

The **Search** page searches a torrent-index site and lets you push a chosen
magnet straight to qBittorrent. It is intentionally simple and explicit:

1. Configure a **`torrentsearch`** service (Services page) — a base URL pointing at
   a torrent-index mirror (e.g. a KickassTorrents proxy). Then configure
   **qBittorrent**, which is where grabs are sent.
2. Search a term. TorHQ scrapes the results and shows title, size, and
   seeders/leechers, strongest-seeded first.
3. Click a **Send to** button per result:
   - **qBittorrent** — grabs into a neutral `torhq-manual` category (a raw
     download you own and organize yourself).
   - **Radarr / Sonarr / Lidarr** — grabs into that \*arr's category so, if you
     have qBittorrent wired as that \*arr's download client with that category,
     the \*arr adopts and imports the download. (TorHQ still only writes to
     qBittorrent — it never touches \*arr files.)

Only well-formed `magnet:?xt=urn:btih:<hash>` links are accepted, and the grab
category is restricted to a fixed allowlist.

### Configuring a mirror (and why it's fragile)

Public torrent-index mirrors rot constantly — domains change, markup drifts, and
many sit behind Cloudflare. So the scraper is **fully configuration-driven**: the
`torrentsearch` service's *extra* config holds the search-path template and a CSS
selector for each field (row, title, magnet, seeders, leechers, size, detail
link), plus a `magnetOnDetailPage` toggle. Blank fields fall back to built-in
KickassTorrents-style defaults. When a mirror changes, **re-point the base URL or
adjust a selector — no code change needed**.

If a mirror is behind a Cloudflare browser challenge, a plain server-side fetch
gets blocked; TorHQ surfaces a clear error rather than failing silently. Set an
optional **FlareSolverr URL** in the same config to route fetches through
[FlareSolverr](https://github.com/FlareSolverr/FlareSolverr) and clear the
challenge.

> For a more robust, long-lived setup, prefer Prowlarr + the \*arr apps for search
> and grabbing. This widget is a convenience for ad-hoc, manual grabs.

---

## Local development

Requires **Node 20+** (22 works). `better-sqlite3` is a native module, so a C
toolchain is needed on first install (`build-essential python3` on Debian).

```bash
git clone <repo> torhq && cd torhq
npm install            # installs both workspaces from the committed lockfile

# Minimal dev environment (loopback, an approved root you can write to):
export TORHQ_MASTER_KEY="$(openssl rand -base64 48)"
export TORHQ_DATA_DIR="$PWD/.dev/data"
export TORHQ_APPROVED_ROOTS="$PWD/.dev"
export NODE_ENV=development
mkdir -p "$PWD/.dev"

# Terminal 1 — API on :8787 (tsx watch)
npm run dev

# Terminal 2 — Vite dev server on :5173, proxying /api and /webhooks to :8787
npm run dev:web
```

Open <http://localhost:5173> and create the admin account.

### Useful scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Server with hot reload (`tsx watch`). |
| `npm run dev:web` | Vite dev server for the SPA. |
| `npm test` | Vitest (crypto, path safety, auth/routing, intake, migrations). |
| `npm run typecheck` | `tsc --noEmit` for both workspaces. |
| `npm run build` | Compile server (`tsc`) and build the SPA (`vite build`). |
| `npm start` | Run the compiled server (`node server/dist/index.js`). |
| `npm run migrate` | Apply database migrations standalone. |

---

## Environment variables

Only **infrastructure** config lives in the environment. Per-service API keys and
passwords are entered in the setup wizard and stored **encrypted** in the
database — never in env, never in git. See [`.env.example`](.env.example).

| Variable | Default | Purpose |
| --- | --- | --- |
| `NODE_ENV` | `production` | `development` \| `test` \| `production`. |
| `TORHQ_HOST` | `127.0.0.1` | Bind address. Keep on loopback; expose via a reverse proxy. |
| `TORHQ_PORT` | `8787` | Bind port. |
| `TORHQ_DATA_DIR` | `/srv/torhq/data` | Writable dir holding `torhq.db`. |
| `TORHQ_MASTER_KEY` | *(required)* | 16+ char key used to derive the AES-256-GCM key that encrypts stored secrets. **Generate with `openssl rand -base64 48`.** Changing it after services are saved makes existing secrets unrecoverable. |
| `TORHQ_APPROVED_ROOTS` | `/srv/torhq` | Colon-separated base dirs. **Every** filesystem operation must stay inside one of these. Keep as tight as possible. |
| `TORHQ_TRUST_PROXY` | `false` | Trust `X-Forwarded-*` (enable **only** behind a trusted reverse proxy). |
| `TORHQ_COOKIE_SECURE` | `false` | Mark the session cookie `Secure` (enable when served over HTTPS). |
| `TORHQ_METRICS_ENABLED` | `false` | Expose Prometheus metrics at `/metrics`. |
| `TORHQ_LOG_LEVEL` | `info` | `fatal` \| `error` \| `warn` \| `info` \| `debug` \| `trace`. |

---

## First-run setup

1. **Create the admin account.** The first visit shows a one-time registration
   screen (`POST /api/auth/register`). Once an admin exists, registration is
   permanently disabled and the screen becomes a login form.
2. **Add your services.** On the **Services** page, enter each service's base URL
   and secret, use **Test connection**, then save. Secret formats:
   - Radarr / Sonarr / Lidarr / Prowlarr — API key
   - qBittorrent — `username:password`
   - slskd — API key (set a **webhook token** in its extra config to enable the intake webhook)
   - Jellyfin — API token
   - Navidrome — `username:password`
   - Kavita — API key (optionally set a **library ID** to trigger explicit scans)
   - torrentsearch — no secret; set the base URL to a torrent-index mirror and,
     if needed, override the site-profile selectors / add a FlareSolverr URL
3. **Define intake libraries.** On the **Libraries** page, create Kavita/Navidrome
   destinations. Both the destination and staging paths must live inside an
   approved root and, for atomic imports, on the same filesystem.
4. **(Optional) qBittorrent categories.** To keep ownership clear, create
   categories in qBittorrent such as `radarr`, `sonarr`, `lidarr`, `torhq-music`,
   and `torhq-manual` (used by the torrent-search widget's raw grabs) so downloads
   are attributed correctly on the dashboard.

A scripted walkthrough of every endpoint is in [`docs/curl-examples.md`](docs/curl-examples.md).

---

## Production deployment (LXC)

TorHQ is designed to run as an unprivileged systemd service inside a Debian 12
Proxmox LXC, behind an optional nginx TLS terminator.

### One-line install on a Proxmox VE host (auto-creates the LXC)

Run this **on the Proxmox VE host** (as root). It creates a fresh unprivileged
Debian 12 container, installs TorHQ inside it, and starts it — no manual
container setup:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/thelorax1775/TorHQ/main/scripts/proxmox-install.sh)"
```

When it finishes it prints the container IP; open `http://<container-ip>:8787` and
create the admin account.

**If the repository is private**, `raw.githubusercontent.com` can't serve the
script and the in-container `git clone` needs credentials. Use a GitHub token
(fine-grained PAT with **Contents → Read-only** on this repo) — export it so both
the download and the clone can authenticate:

```bash
export TORHQ_GIT_TOKEN=github_pat_xxxxxxxx
bash -c "$(curl -fsSL \
  -H "Authorization: Bearer $TORHQ_GIT_TOKEN" \
  -H "Accept: application/vnd.github.raw" \
  https://api.github.com/repos/thelorax1775/TorHQ/contents/scripts/proxmox-install.sh)"
```

The exported `TORHQ_GIT_TOKEN` is inherited by the script and used for the clone;
it is passed to git via a request header, so it is never written to disk. (If you
make the repo public, the plain `curl … raw.githubusercontent.com …` one-liner
above works with no token.)

By default it shows an **interactive menu** (like the community-scripts
installers): confirm the defaults, or choose **Advanced** to pick the container
ID, resources, **storage location** (rootfs and template storage are listed from
your *enabled* Proxmox storages), network (DHCP or a static IP), and more.

For unattended runs, set the values via environment variables and
`TORHQ_NONINTERACTIVE=1` to skip the menu. Every setting has an override:

| Variable | Default | Purpose |
| --- | --- | --- |
| `TORHQ_CTID` | next free id | LXC container ID. |
| `TORHQ_HOSTNAME` | `torhq` | Container hostname. |
| `TORHQ_DISK` | `8` | Root disk size (GB). |
| `TORHQ_RAM` | `2048` | RAM (MB). |
| `TORHQ_CORES` | `2` | vCPU count. |
| `TORHQ_STORAGE` | auto (first enabled `rootdir`; `local-lvm` if present) | Storage for the rootfs. |
| `TORHQ_TEMPLATE_STORAGE` | auto (first enabled `vztmpl`) | Storage the Debian template is downloaded to. |
| `TORHQ_NONINTERACTIVE` | *(unset)* | Set to `1` to skip the menu and use env/defaults only. |
| `TORHQ_BRIDGE` | `vmbr0` | Network bridge. |
| `TORHQ_NET` | `dhcp` | `dhcp` or a static CIDR (e.g. `192.168.1.50/24`). |
| `TORHQ_GW` | *(none)* | Gateway — **required** for a static `TORHQ_NET`. |
| `TORHQ_BIND` | `0.0.0.0` | Address TorHQ binds to inside the CT (LAN-reachable). |
| `TORHQ_BRANCH` | `main` | Git branch to install from. |

Example — a fixed IP and more resources:

```bash
TORHQ_NET=192.168.1.50/24 TORHQ_GW=192.168.1.1 TORHQ_RAM=4096 TORHQ_DISK=16 \
  bash -c "$(curl -fsSL https://raw.githubusercontent.com/thelorax1775/TorHQ/main/scripts/proxmox-install.sh)"
```

> The installer binds TorHQ to `0.0.0.0` so it's reachable on your LAN at the
> container IP. To expose it beyond the LAN, front it with the nginx TLS reverse
> proxy below and set `TORHQ_TRUST_PROXY`/`TORHQ_COOKIE_SECURE`.

> **Before PR #3 is merged**, install from the feature branch by also fetching the
> script from it:
> ```bash
> TORHQ_BRANCH=claude/arr-stack-integration-9jtos4 \
>   bash -c "$(curl -fsSL https://raw.githubusercontent.com/thelorax1775/TorHQ/claude/arr-stack-integration-9jtos4/scripts/proxmox-install.sh)"
> ```

### Manual install (inside an existing LXC)

```bash
# Inside the LXC, as root:
git clone <repo> /opt/torhq-src && cd /opt/torhq-src
./scripts/install.sh
```

`scripts/install.sh` is idempotent and will:

1. Create the unprivileged `torhq` system user.
2. Install Node.js 20 (NodeSource) if missing.
3. Create the directory layout under `/srv/torhq` (`data`, `staging`,
   `downloads`, `libraries/{movies,tv,music,books,manga}`).
4. Copy the source to `/srv/torhq/app`, run `npm ci`, and build.
5. Generate `/etc/torhq/torhq.env` with a fresh `TORHQ_MASTER_KEY` (created once,
   never overwritten), locked to `0640 torhq:torhq`.
6. Install and start the `torhq` systemd unit.

Then open `http://<lxc-ip>:8787` and create the admin account.

```bash
systemctl status torhq
journalctl -u torhq -f
```

### Reverse proxy (HTTPS)

TorHQ binds to loopback. Terminate TLS with nginx
([`deploy/torhq.nginx.conf`](deploy/torhq.nginx.conf)) and set
`TORHQ_TRUST_PROXY=true` and `TORHQ_COOKIE_SECURE=true` in the env file.

### systemd hardening

[`deploy/torhq.service`](deploy/torhq.service) runs as the `torhq` user with
`NoNewPrivileges`, `ProtectSystem=strict`, `PrivateTmp`, and a tight
`ReadWritePaths` list. **`ReadWritePaths` must include every media path you want
intake to write to** — keep it consistent with `TORHQ_APPROVED_ROOTS`.

### Upgrades

```bash
/srv/torhq/app/scripts/upgrade.sh   # backs up, pulls, npm ci, build, migrate, restart
```

Migrations are forward-only and idempotent, so re-running an upgrade is safe.

---

## Backup & restore

State worth backing up is small: the SQLite database and the env file (which
holds `TORHQ_MASTER_KEY`). **Media libraries are not backed up by TorHQ.**

```bash
# Back up (WAL-safe online .backup + the env file), default dest /srv/torhq/backups
/srv/torhq/app/scripts/backup.sh
```

`scripts/backup.sh` produces `torhq-<timestamp>.tar.gz` containing a consistent
DB snapshot and a copy of `torhq.env`.

> **The master key is everything.** Encrypted service secrets are unreadable
> without the `TORHQ_MASTER_KEY` that was in effect when they were saved. Protect
> the backup accordingly, and never rotate the key without re-entering secrets.

**Restore:**

```bash
systemctl stop torhq
tar -xzf torhq-<timestamp>.tar.gz -C /tmp
install -o torhq -g torhq -m600 /tmp/torhq-<timestamp>.db  /srv/torhq/data/torhq.db
install -o torhq -g torhq -m640 /tmp/torhq-<timestamp>.env /etc/torhq/torhq.env
systemctl start torhq
```

---

## Security model

- **Secrets stay server-side.** Service credentials are encrypted at rest with
  AES-256-GCM (key derived from `TORHQ_MASTER_KEY` via scrypt). The API returns
  only a masked hint (`••••••••abcd`); full secrets are never sent to the browser
  or written to logs (pino redaction covers cookies, auth headers, and secret-ish keys).
- **Auth.** Single admin account, scrypt password hashing (N=32768), server-side
  sessions in a `Strict`, `HttpOnly` cookie with a 12-hour TTL and a constant-work
  path to blunt username-enumeration timing.
- **CSRF.** Double-submit token required on **every** state-changing request
  (including logout), via the `X-CSRF-Token` header matched against the session.
- **Rate limiting.** Global limiter plus a tighter limiter on auth and webhook routes.
- **Path containment.** Every filesystem path is validated against
  `TORHQ_APPROVED_ROOTS` with lexical traversal collapse, prefix-aliasing-safe
  prefix checks, and `realpath` symlink-escape rejection.
- **Webhook auth.** `/webhooks/slskd` requires a shared token compared in
  constant time.
- **Least privilege deployment.** Runs as an unprivileged user under a hardened
  systemd unit; binds to loopback by default.

---

## API

The server exposes an OpenAPI 3.1 document at `GET /api/openapi.json`, and a
`curl` walkthrough of every endpoint lives in
[`docs/curl-examples.md`](docs/curl-examples.md). All `/api/*` routes except the
auth endpoints require a session; all mutating routes additionally require the
CSRF header.

---

## Project layout

```
server/            Fastify API + worker (TypeScript, ESM)
  src/adapters/    one typed HTTP client per external service
  src/auth/        password hashing, sessions, CSRF plugin
  src/config/      env parsing + encrypted service/library store
  src/db/          Drizzle schema, connection, migrations
  src/queue/       durable intake queue + import state machine
  src/routes/      REST + webhook route handlers
  src/security/    path containment / traversal defenses
web/               React + Vite SPA
tests/             Vitest suites (crypto, paths, routing, intake, migrations)
scripts/           install / upgrade / backup
deploy/            systemd unit + nginx reverse-proxy config
docs/              API curl examples
```

---

## License

MIT. See [`package.json`](package.json).
