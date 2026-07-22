import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getAdapter } from "../adapters/registry.js";
import type { TorrentSearchAdapter } from "../adapters/torrentsearch.js";
import type { QbittorrentAdapter } from "../adapters/qbittorrent.js";
import { logActivity } from "../lib/activity.js";
import type { AppContext } from "../lib/context.js";

const SearchQuery = z.object({
  q: z.string().min(1).max(256),
  page: z.coerce.number().int().min(1).max(20).optional(),
});

// Where a grab may be tagged. `torhq-manual` = a raw grab TorHQ owns; the *arr
// categories let the corresponding *arr adopt and import the download. A fixed
// allowlist keeps arbitrary category strings out of qBittorrent.
const GRAB_CATEGORIES = ["torhq-manual", "radarr", "sonarr", "lidarr"] as const;

const GrabBody = z.object({
  // Only well-formed magnet links — never an arbitrary URL handed to qBittorrent.
  magnet: z.string().regex(/^magnet:\?.*xt=urn:btih:[A-Za-z0-9]{32,40}(&|$)/i, "not a valid magnet link").max(4096),
  title: z.string().max(512).optional(),
  category: z.enum(GRAB_CATEGORIES).optional(),
});

export function searchRoutes(app: FastifyInstance, ctx: AppContext): void {
  const guard = { preHandler: [app.requireAuth, app.requireCsrf] };

  // Search the configured torrent site. Read-only, so auth-only (no CSRF).
  app.get("/api/search", { preHandler: app.requireAuth }, async (req, reply) => {
    const a = getAdapter("torrentsearch", ctx.masterKey) as TorrentSearchAdapter | null;
    if (!a) return reply.code(409).send({ error: "torrent search is not configured" });
    const { q, page } = SearchQuery.parse(req.query);
    try {
      const results = await a.search(q, page ?? 1);
      // Strongest-seeded first — the useful default ordering for grabbing.
      results.sort((x, y) => (y.seeders ?? 0) - (x.seeders ?? 0));
      return { results };
    } catch (e) {
      return reply.code(502).send({ error: (e as Error).message });
    }
  });

  // Grab a chosen magnet straight into qBittorrent under the given category.
  app.post("/api/search/grab", guard, async (req, reply) => {
    const qb = getAdapter("qbittorrent", ctx.masterKey) as QbittorrentAdapter | null;
    if (!qb) return reply.code(409).send({ error: "qBittorrent is not configured" });
    const body = GrabBody.parse(req.body);
    const category = body.category ?? "torhq-manual";
    try {
      await qb.addTorrent({ url: body.magnet, category });
      logActivity({
        kind: "queued",
        service: "qbittorrent",
        message: `Sent "${body.title ?? "torrent"}" to qBittorrent (${category})`,
        data: { category },
      });
      return { ok: true, category };
    } catch (e) {
      return reply.code(502).send({ error: (e as Error).message });
    }
  });
}
