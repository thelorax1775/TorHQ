# TorHQ

**A self-hosted control plane for a Proxmox media homelab.**

TorHQ is a single-origin web application that sits in front of the services that
already run your media stack — Radarr, Sonarr, Lidarr, Prowlarr, qBittorrent,
slskd, Jellyfin, Navidrome, and Kavita — and gives you one authenticated place
to request media, watch downloads and *arr activity, check service health, and
run a small, explicit **manual-intake** workflow for content the *arr apps don't
manage (e.g. books/manga into Kavita, loose music into Navidrome).

It is intentionally small and conservative. TorHQ does **not** try to replace the
*arr apps or take over their libraries.

---

## The core boundary: TorHQ intake vs. *arr-owned media

This is the single most important design rule in the project:

> **TorHQ never moves, renames, or deletes media that belongs to Radarr, Sonarr,
> or Lidarr.** Those apps own their download clients, their import logic, and
> their library folders. TorHQ only *asks* them to add-and-search a release.

TorHQ performs filesystem operations for exactly one thing: its own **manual
intake** pipeline, for libraries that have no *arr equivalent. Even then, every
operation is:

- constrained to the directories listed in `TORHQ_APPROVED_ROOTS`,
- symlink-escape and path-traversal checked before any I/O,
- previewed (dry run) before it runs,
- executed as a durable, idempotent, retryable job,
- and best-effort followed by a library rescan on the target service.

If a workflow would move media owned by an *arr, it does not belong in TorHQ.

---

## Architecture

Single Node process, single origin. The backend serves the API **and** the built
SPA, so there is one port to expose behind a reverse proxy.

```
                 ┌────────────────────────────────────────────┐
  Browser ─────▶ │ Fastify (server/)                          │
   (SPA)         │  • session cookie + double-submit CSRF     │
                 │  • rate limiting (global + strict on auth) │
                 │  • Zod-validated routes                    │
                 │  • serves web/dist as the SPA              │
                 │                                            │
                 │  ┌───────────────┐  ┌────────────────────┐ │
                 │  │ SQLite/Drizzle│  │ Manual-intake queue│ │
                 │  │ better-sqlite3│  │ durable, retrying, │ │
                 │  │ encrypted     │  │ single in-proc     │ │
                 │  │ service creds │  │ worker             │ │
                 │  └───────────────┘  └────────────────────┘ │
                 │           │                    │           │
                 │           ▼                    ▼           │
                 │      Service adapters (undici HTTP client) │
                 └────────────┬───────────────────────────────┘
                              │
   Radarr · Sonarr · Lidarr · Prowlarr · qBittorrent · slskd ·
   Jellyfin · Navidrome · Kavita
```

**Backend** (`server/`) — Fastify 4, `better-sqlite3` + Drizzle ORM, `undici`
for outbound HTTP, `zod` for validation, `pino` for structured logs.

**Frontend** (`web/`) — React 18 + Vite single-page app. Built to static assets
and served by the backend in production.

**Data model** (`server/src/db/schema.ts`) — `users`, `sessions`, `services`
(secrets encrypted at rest), `libraries` (manual-intake destinations), `jobs`
(durable queue), `activity` (append-only audit timeline). Timestamps are unix
epoch ms integers and JSON is stored as text, so the schema is portable to
Postgres later.

### Repository layout

```
server/            Fastify backend (TypeScript, ESM)
  src/adapters/    One HTTP adapter per external service
  src/auth/        Password hashing, sessions, CSRF plugin
  src/config/      Env schema + encrypted service/library store
  src/db/          Drizzle schema, connection, migrations
  src/queue/       Manual-intake preview + durable job queue/worker
  src/routes/      auth, setup, requests, jobs, status, webhooks, system, openapi
  src/security/    Path containment (approved-roots, traversal, symlink defense)
web/               React + Vite SPA
tests/             Vitest suites (crypto, path safety, auth/routing flow)
scripts/           install.sh, upgrade.sh, backup.sh
deploy/            systemd unit + nginx reverse-proxy example
docs/              curl examples for every endpoint
```

---

## Integrations

| Service      | TorHQ uses it for                                              |
|--------------|----------------------------------------------------------------|
| Radarr       | Movie requests (add + search), history, wanted/missing         |
| Sonarr       | TV requests (add + search), history, wanted/missing            |
| Lidarr       | Artist/album requests (add + search), history, wanted/missing  |
| Prowlarr     | Indexer health                                                 |
| qBittorrent  | Active downloads grouped by owning category                    |
| slskd        | Recent Soulseek downloads + completed-download webhook         |
| Jellyfin     | Health monitoring (video library is owned by Radarr/Sonarr)    |
| Navidrome    | Library rescan trigger (music intake target)                   |
| Kavita       | Library rescan trigger (books/manga intake target)             |

Per-service credentials are entered in the setup wizard and stored **encrypted**
in the database — never in the environment file, never returned to the browser
in full (the API only exposes a masked hint).

---

## Environment variables

Only **infrastructure** config lives in the environment. Per-service API keys and
passwords are entered in the UI and encrypted at rest. Copy `.env.example` to
`/etc/torhq/torhq.env` and lock it down (`chmod 640`, owned by the `torhq` user).

| Variable                 | Default              | Purpose                                                                 |
|--------------------------|----------------------|-------------------------------------------------------------------------|
| `NODE_ENV`               | `production`         | `development` \| `test` \| `production`                                 |
| `TORHQ_HOST`             | `127.0.0.1`          | Bind address. Keep on loopback; expose via reverse proxy.               |
| `TORHQ_PORT`             | `8787`               | Listen port.                                                            |
| `TORHQ_DATA_DIR`         | `/srv/torhq/data`    | Writable dir for the SQLite database.                                   |
| `TORHQ_MASTER_KEY`       | *(required)*         | 16+ char key (base64/hex) used to encrypt stored service secrets.       |
| `TORHQ_APPROVED_ROOTS`   | `/srv/torhq`         | Colon-separated roots. **Every** filesystem op must stay inside these.  |
| `TORHQ_TRUST_PROXY`      | `false`              | Trust `X-Forwarded-*`. Enable **only** behind a trusted proxy.          |
| `TORHQ_COOKIE_SECURE`    | `false`              | Mark the session cookie `Secure`. Enable when served over HTTPS.        |
| `TORHQ_METRICS_ENABLED`  | `false`              | Expose Prometheus metrics at `/metrics`.                                |
| `TORHQ_LOG_LEVEL`        | `info`               | `fatal` \| `error` \| `warn` \| `info` \| `debug` \| `trace`            |

> **Warning:** changing `TORHQ_MASTER_KEY` after services have been saved makes
> the stored secrets unreadable. Treat the key (and any backup that contains it)
> as a credential.

---

## Local development

Requires **Node 20+** (Node 22 works). Development can happen on Windows; the
deployment target is a Linux LXC.

```bash
# Install all workspace deps (uses the committed package-lock.json).
npm install

# Backend (Fastify, tsx watch) — needs env vars set:
TORHQ_MASTER_KEY=dev-only-key-change-me \
TORHQ_DATA_DIR=./data \
TORHQ_APPROVED_ROOTS="$PWD/data" \
npm run dev            # http://127.0.0.1:8787

# Frontend (Vite dev server, proxies /api to the backend):
npm run dev:web        # http://127.0.0.1:5173
```

Useful root scripts:

```bash
npm test          # Vitest suites (server)
npm run typecheck # tsc --noEmit for server and web
npm run build     # compile server + build the SPA into web/dist
npm run migrate   # apply schema to TORHQ_DATA_DIR (standalone)
```

A production-style run serves the SPA from the backend:

```bash
npm run build
TORHQ_MASTER_KEY=... TORHQ_DATA_DIR=./data TORHQ_APPROVED_ROOTS="$PWD/data" \
  npm start       # serves API + web/dist on one origin
```

---

## First-run setup

1. Start TorHQ and open it in a browser (`http://<host>:8787` or via your proxy).
2. **Create the single admin account.** Registration is only available until one
   admin exists; after that it is disabled.
3. In **Services**, add each service you run (base URL + API key, or
   `username:password` for qBittorrent). Use **Test** to verify connectivity —
   secrets are stored encrypted and shown back only as a mask.
4. For qBittorrent, create the ownership categories in qBittorrent itself so
   downloads are attributed correctly: `radarr`, `sonarr`, `lidarr`, and the
   TorHQ-managed categories (`torhq-kavita`, `torhq-music`).
5. If you use slskd's completed-download webhook, set a `webhookToken` in the
   slskd service's extra config and point slskd at `POST /webhooks/slskd`.
6. In **Libraries**, define manual-intake destinations (e.g. Kavita manga,
   Navidrome music). Destination and staging paths must resolve inside
   `TORHQ_APPROVED_ROOTS`.

---

## Production deployment (Debian 12 LXC)

TorHQ ships an installer and a hardened systemd unit. Run inside an unprivileged
LXC as root:

```bash
sudo ./scripts/install.sh
```

The installer:

- creates a `torhq` system user with no login shell,
- installs Node 20 (NodeSource) if missing,
- lays out `/srv/torhq/{app,data,staging,downloads,libraries}`,
- installs dependencies and builds the server + SPA,
- generates a `TORHQ_MASTER_KEY` into `/etc/torhq/torhq.env` on first install,
- installs and enables the `torhq` systemd service.

```bash
systemctl status torhq
journalctl -u torhq -f
```

**Reverse proxy / HTTPS.** TorHQ binds to loopback by default. Put nginx (see
`deploy/torhq.nginx.conf`) in front for TLS, then set `TORHQ_TRUST_PROXY=true`
and `TORHQ_COOKIE_SECURE=true`.

**Hardening.** The systemd unit runs as a non-root user with
`NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome`, private tmp/devices,
and an explicit `ReadWritePaths` allowlist. Add each media path intake must write
to under both `ReadWritePaths` and `TORHQ_APPROVED_ROOTS`.

**Upgrades** are in place and preserve the database:

```bash
sudo ./scripts/upgrade.sh   # backs up, pulls, rebuilds, migrates, restarts
```

---

## Backup & restore

State worth backing up is small: the SQLite database and the env file (which
holds the master key). Media libraries are **not** part of a TorHQ backup.

```bash
sudo ./scripts/backup.sh [DEST_DIR]   # default /srv/torhq/backups
# → torhq-<timestamp>.tar.gz  (WAL-safe online .backup of the DB + the .env)
```

The archive contains `TORHQ_MASTER_KEY`; without it the encrypted service
secrets in the database cannot be read. Protect the backup accordingly.

**Restore:**

```bash
systemctl stop torhq
tar -xzf torhq-<timestamp>.tar.gz -C /tmp
cp /tmp/torhq-<timestamp>.db  /srv/torhq/data/torhq.db
cp /tmp/torhq-<timestamp>.env /etc/torhq/torhq.env   # only if the key was lost
chown -R torhq:torhq /srv/torhq /etc/torhq
systemctl start torhq
```

---

## Security model

- **Secrets stay server-side.** Service credentials are encrypted at rest with
  `TORHQ_MASTER_KEY` and are never returned to the browser or written to logs;
  the API exposes only a masked hint.
- **Auth.** A single admin account; session cookie is `HttpOnly`,
  `SameSite=Strict`, and `Secure` when `TORHQ_COOKIE_SECURE=true`.
- **CSRF.** Mutating requests require a double-submit CSRF token in the
  `x-csrf-token` header, matched against the session. The token is returned by
  login/register and by `GET /api/auth/me`.
- **Rate limiting.** A global limiter plus a stricter limiter on auth and webhook
  routes.
- **Filesystem containment.** All paths are resolved and validated against
  `TORHQ_APPROVED_ROOTS` with traversal and symlink-escape defenses before any
  I/O. See `server/src/security/paths.ts` and `tests/paths.test.ts`.
- **Webhook auth.** The slskd webhook is authenticated by a shared token compared
  in constant time.

---

## API

The backend serves a hand-authored OpenAPI 3.1 document at
`GET /api/openapi.json`. Public endpoints: `/health`, `/ready`, and (if enabled)
`/metrics`. Everything under `/api/*` requires a session; mutating routes also
require the CSRF header.

Endpoint groups:

- **Auth** — `POST /api/auth/{register,login,logout}`, `GET /api/auth/me`
- **Setup** — `GET/POST /api/services`, `POST /api/services/test`,
  `GET/POST /api/libraries`, `GET /api/config/roots`
- **Requests** — `GET /api/requests/{movie,tv,music}/options`,
  `POST /api/requests/{movie,tv,music}`
- **Intake** — `POST /api/intake/preview`, `POST /api/intake`
- **Jobs** — `GET /api/jobs`, `GET /api/jobs/:id`, `POST /api/jobs/:id/retry`,
  `GET /api/activity`
- **Status** — `GET /api/status/{health,downloads,arr-activity,slskd,failures,storage}`
- **Webhooks** — `POST /webhooks/slskd`

Copy-paste `curl` examples for every endpoint (including the cookie-jar + CSRF
flow) are in [`docs/curl-examples.md`](docs/curl-examples.md).

---

## Testing

```bash
npm test        # Vitest: crypto/passwords, path safety, auth/routing flow
npm run typecheck
npm run build
```

---

## License

MIT.
