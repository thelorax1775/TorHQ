# Friend / member access — design

Date: 2026-09-02

## Problem

TorHQ is single-user by design: `POST /api/auth/register` refuses once any
user row exists, and `requireAuth` only checks "is there a valid session" —
every logged-in account can reach every page, including `Services`,
`Libraries`, `Settings`, `Mounts`, and `Intake` (which resolves filesystem
paths). The operator wants to give friends their own logins so they can
search for and request movies/shows/music (which lands in Jellyfin once the
*arr stack imports it), without exposing any admin surface.

## Goals

- Individual named accounts for friends, created by the admin — not
  self-registration.
- A friend account can use: `Requests` (search + submit to
  Radarr/Sonarr/Lidarr), `Downloads`/`Queue` (view only), `Jobs & activity`
  (view only).
- A friend account is blocked from: `Get`/Acquire, `Raw search`, `Intake`,
  `Libraries`, `Services`, `Mounts`, `Settings`, queue mutations
  (pause/remove), and admin utility routes (`identify`, `pipeline`).
- Requests a friend submits are attributed by username in the activity log.
- No schema migration: `users.role` already exists
  (`text("role").notNull().default("admin")`, currently unused).

## Non-goals

- No per-user request history table or per-user filtering of
  Downloads/Jobs — those views stay global/shared, matching the rest of the
  app's single-household model.
- No public/internet exposure. Reachability is Tailscale-only (see
  Rollout).
- No change to secret encryption, adapters, or the manual-intake pipeline.

## Backend design

### `server/src/auth/plugin.ts`

- The `onRequest` hook currently attaches `req.session` (session id, csrf
  token, user id) only. Extend it to also resolve the owning user row and
  attach `req.user: { id, username, role }`. One extra indexed lookup per
  request (`sessions.userId` already has an index) — acceptable for a
  homelab-scale app, and it removes the need for any route to re-query the
  user table for attribution.
- Add `app.requireAdmin`: 403 (not 401 — a valid but under-privileged
  session should not look like "not logged in") when `req.user?.role !==
  "admin"`. Reuses `requireAuth`'s existing 401 for "no session at all" by
  running after it in the `preHandler` chain.

### `server/src/routes/users.ts` (new, admin-only)

All routes `{ preHandler: [app.requireAuth, app.requireAdmin, app.requireCsrf] }`
for mutations, `[app.requireAuth, app.requireAdmin]` for the list:

- `GET /api/users` — id, username, role, createdAt. Never the password hash.
- `POST /api/users` — `{ username, password }`, always created with
  `role: "member"`. Reuses `hashPassword` from `auth/password.ts`. Admin
  creation stays exactly where it is (`/api/auth/register`, still gated by
  `adminExists()`); this route never creates an admin.
- `POST /api/users/:id/password` — `{ password }`, admin resets a friend's
  password (covers "forgot password" without deleting/recreating the
  account, which would be a rougher UX for a small friend list).
- `DELETE /api/users/:id` — revokes a friend account. `initDb` sets
  `PRAGMA foreign_keys = ON` and `sessions.user_id REFERENCES users(id)`
  has no `ON DELETE CASCADE`, so deleting the user row first would throw a
  foreign key error — delete the user's session rows, then the user row,
  in one transaction (same pattern as `destroySession`, just for every
  session belonging to that user id). Refuses to delete the last remaining
  admin (defense in depth — there is currently no route that could create
  a second admin, so this should be unreachable, but the check is cheap).

### Route guard changes (existing files)

Change `{ preHandler: app.requireAuth }` → `{ preHandler: [app.requireAuth, app.requireAdmin] }`
(and same for `guard` objects that also include `requireCsrf`) on:

- `acquire.ts` — all routes
- `search.ts` — all routes
- `identify.ts` — all routes
- `pipeline.ts` — all routes
- `status.ts` — all routes
- `setup.ts` — all routes (services, libraries, config/roots)
- `jobs.ts` — only `/api/intake/preview`, `/api/intake`,
  `/api/jobs/:id/retry` (NOT `/api/jobs`, `/api/jobs/:id`, `/api/activity`,
  which stay `requireAuth`)
- `downloads.ts` — only `/api/downloads/action`, `/api/queue/refresh`,
  `/api/queue/:service/:id/remove` (NOT the two GETs)

`requests.ts` is unchanged (`requireAuth` already) except for attribution:
`logActivity` in the submit handler includes `req.user.username` in the
message, e.g. `Requested ${title} (by ${username})`.

### `routes/auth.ts`

`GET /api/auth/me` response gains `role: req.user?.role ?? null`.

## Frontend design

### `web/src/App.tsx`

- `Me` interface gains `role: "admin" | "member" | null`.
- Route table: wrap admin-only `<Route>` elements so a `member` hitting one
  directly (typed URL, stale bookmark) redirects to `/requests` instead of
  rendering. Simplest implementation: a small `<RequireAdmin>` wrapper
  component reading role from context/props, consistent with the existing
  "gate wraps the router" pattern in this file's own header comment.
- New route: `/users` → `Users` page (admin-only).

### `web/src/components/Layout.tsx`

- `NavItem` gains `adminOnly?: boolean`. `Dashboard`, `Get`, `Raw search`,
  `Intake`, `Libraries`, `Services`, `Mounts`, `Settings` get it set; the
  `System` group gains a `Users` entry (admin-only). Filter `NAV` by role
  before rendering.

### `web/src/pages/Users.tsx` (new, admin-only)

Table (username, role, created date, revoke button) + a small form to add
a friend (username, password) and a per-row "reset password" action.
Follows the existing page conventions (`PageHeader`, `Card`, `Button`,
`useMutation`) already used throughout `web/src/pages/*.tsx` — no new UI
primitives needed.

## Security

- Friend accounts get the exact same session/CSRF/rate-limit machinery as
  the admin — no new auth mechanism, just a narrower route allowlist.
- 403 (not a silent redirect) is what the *backend* returns for an
  under-privileged request; the frontend redirect is a UX nicety, not the
  security boundary — the boundary is the guard on each route.
- Friends never see `Services`/`Settings`, so they never see masked service
  hints or the ability to change service config, qBittorrent categories,
  etc.
- Revoking a friend (`DELETE /api/users/:id`) must kill their existing
  sessions immediately, not just block new logins.

## Testing

Vitest, matching the existing suite's structure (`tests/`):

- `requireAdmin` guard: 401 with no session, 403 for a `member` session,
  passes for an `admin` session.
- Each changed route file: one test asserting a `member` session gets 403
  on the now-admin-only routes, and (for `jobs.ts`/`downloads.ts`) one
  asserting the still-friend-safe GETs remain reachable.
- `routes/users.ts`: create, list (masks nothing sensitive since there's
  nothing sensitive to mask beyond the hash, which is never selected),
  password reset changes future auth, delete revokes existing sessions,
  cannot delete the last admin.
- `requests.ts`: activity log message includes the requesting username.

## Rollout (not code)

Friends reach TorHQ by joining the Tailscale tailnet. Recommend an ACL tag
scoping friend devices to just the TorHQ LXC (port 8787) and Jellyfin —
not the rest of the homelab (Prometheus is unauthenticated on the tailnet
per existing security notes; Proxmox itself; etc.). This is a Tailscale
admin-console step, out of scope for this spec.

Deployment: `git pull` on CT 111 (`torhq` LXC, pve-1), `npm run migrate`
(no-op — no new migration), rebuild (`npm run build` per existing
`upgrade.sh`), restart `torhq.service`. First friend account created by
the operator through the new `Users` page after deploy.
