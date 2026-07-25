import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getAdapter } from "../adapters/registry.js";
import type { QbittorrentAdapter } from "../adapters/qbittorrent.js";
import type { ArrAdapter, ArrFlavor } from "../adapters/arr.js";
import { logActivity } from "../lib/activity.js";
import {
  buildPipelineChecks, extractFailedImports, type ArrSnapshot, type FailedImport, type QbSnapshot,
} from "../lib/pipeline.js";
import type { AppContext } from "../lib/context.js";
import { ARR_SERVICES } from "./downloads.js";

/**
 * Pipeline health: does a grab actually reach the right *arr and land in the
 * right directory? Every route here is diagnostic. The checks read *arr and
 * qBittorrent configuration and report concrete mismatches with a fix — TorHQ
 * never repairs one silently, and `manual-import` only asks the owning *arr to
 * re-scan a download it already owns. TorHQ moves no files.
 */
const ManualImportBody = z.object({
  service: z.enum(ARR_SERVICES),
  downloadId: z.string().min(1).max(128),
});

export function pipelineRoutes(app: FastifyInstance, ctx: AppContext): void {
  const guard = { preHandler: [app.requireAuth, app.requireCsrf] };
  const arrAdapter = (kind: ArrFlavor) => getAdapter(kind, ctx.masterKey) as ArrAdapter | null;

  // Read-only end-to-end verification of the grab → download → import path.
  app.get("/api/pipeline/check", { preHandler: app.requireAuth }, async () => {
    const [qb, arrs] = await Promise.all([
      qbSnapshot(getAdapter("qbittorrent", ctx.masterKey) as QbittorrentAdapter | null),
      Promise.all(ARR_SERVICES.map((s) => arrSnapshot(s, arrAdapter(s)))),
    ]);
    return { checks: buildPipelineChecks({ qb, arrs }) };
  });

  // Downloads the *arr finished but could not import.
  app.get("/api/pipeline/failed-imports", { preHandler: app.requireAuth }, async () => {
    const items: FailedImport[] = [];
    const unavailable: Array<{ service: ArrFlavor; detail: string }> = [];
    await Promise.all(ARR_SERVICES.map(async (service) => {
      const arr = arrAdapter(service);
      if (!arr) { unavailable.push({ service, detail: "not configured" }); return; }
      try {
        items.push(...extractFailedImports(await arr.queue()));
      } catch (e) {
        unavailable.push({ service, detail: (e as Error).message });
      }
    }));
    items.sort((a, b) => a.service.localeCompare(b.service) || a.id - b.id);
    unavailable.sort((a, b) => a.service.localeCompare(b.service));
    return { items, unavailable };
  });

  // Ask the owning *arr to import a completed download again. The *arr does the
  // scanning, moving and renaming; TorHQ only points it at its own output path.
  app.post("/api/pipeline/manual-import", guard, async (req, reply) => {
    const body = ManualImportBody.parse(req.body);
    const arr = arrAdapter(body.service);
    if (!arr) return reply.code(409).send({ error: `${body.service} is not configured` });
    try {
      const wanted = body.downloadId.toLowerCase();
      const item = (await arr.queue()).find((q) => q.downloadId?.toLowerCase() === wanted);
      if (!item) {
        return reply.code(404).send({ error: `${body.service} has no queue item for that downloadId` });
      }
      const { command } = await arr.rescanDownload({ outputPath: item.outputPath, downloadId: item.downloadId });
      logActivity({
        kind: "importing",
        service: body.service,
        message: `Asked ${body.service} to import "${item.title}" (${command})`,
        data: { downloadId: item.downloadId, outputPath: item.outputPath, command },
      });
      return { ok: true, service: body.service, command, path: item.outputPath ?? null };
    } catch (e) {
      return reply.code(502).send({ error: (e as Error).message });
    }
  });
}

/**
 * Read everything the checks need from qBittorrent. Categories are the load-
 * bearing part: without them the client counts as unreachable, while a missing
 * preference or torrent list only weakens individual checks.
 */
async function qbSnapshot(qb: QbittorrentAdapter | null): Promise<QbSnapshot> {
  if (!qb) return { configured: false };
  const [categories, prefs, torrents] = await Promise.allSettled([
    qb.categories(), qb.preferences(), qb.torrents(),
  ]);
  if (categories.status === "rejected") {
    return { configured: true, error: reason(categories.reason) };
  }
  const savePath = prefs.status === "fulfilled" ? prefs.value.save_path : undefined;
  return {
    configured: true,
    categories: categories.value,
    defaultSavePath: typeof savePath === "string" ? savePath : undefined,
    torrents: torrents.status === "fulfilled" ? torrents.value : undefined,
  };
}

/**
 * Read one *arr's pipeline configuration. Each endpoint is settled separately so
 * a single permission-denied call degrades one check instead of the service; if
 * nothing answered at all, the *arr itself is down.
 */
async function arrSnapshot(service: ArrFlavor, arr: ArrAdapter | null): Promise<ArrSnapshot> {
  if (!arr) return { service, configured: false };
  const results = await Promise.allSettled([
    arr.downloadClients(), arr.downloadClientConfig(), arr.rootFolders(), arr.queue(),
  ]);
  const [clients, config, roots, queue] = results;
  if (results.every((r) => r.status === "rejected")) {
    return { service, configured: true, error: reason((clients as PromiseRejectedResult).reason) };
  }
  return {
    service,
    configured: true,
    downloadClients: clients.status === "fulfilled" ? clients.value : undefined,
    config: config.status === "fulfilled" ? config.value : undefined,
    rootFolders: roots.status === "fulfilled" ? roots.value : undefined,
    queue: queue.status === "fulfilled" ? queue.value : undefined,
  };
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
