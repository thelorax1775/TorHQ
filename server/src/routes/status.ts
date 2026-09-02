import { statfsSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { getAdapter, checkAllHealth } from "../adapters/registry.js";
import { QbittorrentAdapter } from "../adapters/qbittorrent.js";
import { ArrAdapter } from "../adapters/arr.js";
import { SlskdAdapter } from "../adapters/slskd.js";
import { listServicesSafe } from "../config/store.js";
import { listJobs } from "../queue/queue.js";
import { listNetworkMounts } from "../lib/mounts.js";
import type { AppContext } from "../lib/context.js";

function diskUsage(path: string): { path: string; totalBytes: number; freeBytes: number } | null {
  try {
    const s = statfsSync(path);
    // bavail (free to unprivileged users), not bfree (which counts the
    // root-reserved blocks the torhq service can never actually use).
    return { path, totalBytes: s.blocks * s.bsize, freeBytes: s.bavail * s.bsize };
  } catch {
    return null;
  }
}

export function statusRoutes(app: FastifyInstance, ctx: AppContext): void {
  // Aggregate health for every configured service.
  app.get("/api/status/health", { preHandler: [app.requireAuth, app.requireAdmin] }, async () => {
    const health = await checkAllHealth([...ctx.serviceKinds], ctx.masterKey);
    return { health, services: listServicesSafe() };
  });

  // Active downloads grouped by owning category (radarr/sonarr/torhq-*).
  app.get("/api/status/downloads", { preHandler: [app.requireAuth, app.requireAdmin] }, async (_req, reply) => {
    const qb = getAdapter("qbittorrent", ctx.masterKey) as QbittorrentAdapter | null;
    if (!qb) return reply.code(409).send({ error: "qbittorrent not configured" });
    try {
      const [torrents, transfer] = await Promise.all([qb.torrents(), qb.transferInfo()]);
      const byCategory: Record<string, typeof torrents> = {};
      for (const t of torrents) (byCategory[t.category || "uncategorized"] ??= []).push(t);
      return { transfer, byCategory, count: torrents.length };
    } catch (e) {
      return reply.code(502).send({ error: (e as Error).message });
    }
  });

  // Recent Radarr/Sonarr/Lidarr activity.
  app.get("/api/status/arr-activity", { preHandler: [app.requireAuth, app.requireAdmin] }, async () => {
    const out: Record<string, unknown> = {};
    for (const kind of ["radarr", "sonarr", "lidarr"]) {
      const a = getAdapter(kind, ctx.masterKey) as ArrAdapter | null;
      if (!a) { out[kind] = { configured: false }; continue; }
      try {
        const [history, missing] = await Promise.all([a.history(15), a.wantedMissing(15)]);
        out[kind] = { configured: true, history, missingCount: missing.length, missing };
      } catch (e) {
        out[kind] = { configured: true, error: (e as Error).message };
      }
    }
    return out;
  });

  // Recent slskd downloads.
  app.get("/api/status/slskd", { preHandler: [app.requireAuth, app.requireAdmin] }, async (_req, reply) => {
    const a = getAdapter("slskd", ctx.masterKey) as SlskdAdapter | null;
    if (!a) return reply.code(409).send({ error: "slskd not configured" });
    try {
      return { downloads: await a.downloads() };
    } catch (e) {
      return reply.code(502).send({ error: (e as Error).message });
    }
  });

  // Failed imports + retry queue.
  app.get("/api/status/failures", { preHandler: [app.requireAuth, app.requireAdmin] }, async () => ({
    failed: listJobs("dead"),
    retrying: listJobs("queued").filter((j) => j.attempts > 0),
  }));

  // Storage usage for configured roots.
  app.get("/api/status/storage", { preHandler: [app.requireAuth, app.requireAdmin] }, async () => ({
    disks: ctx.env.approvedRoots.map(diskUsage).filter(Boolean),
  }));

  // Read-only view of NFS/SMB shares bind-mounted into this container.
  // TorHQ does not mount anything itself — see scripts/mount-share.sh.
  app.get("/api/status/mounts", { preHandler: [app.requireAuth, app.requireAdmin] }, async () => ({
    mounts: listNetworkMounts(),
  }));
}
