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
    // qBittorrent first: its save paths are what each *arr is then asked to look
    // for, which is the one check that needs both sides of the pipeline at once.
    const qb = await qbSnapshot(getAdapter("qbittorrent", ctx.masterKey) as QbittorrentAdapter | null);
    const savePaths = downloadPaths(qb);
    const arrs = await Promise.all(ARR_SERVICES.map((s) => arrSnapshot(s, arrAdapter(s), savePaths)));
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
async function arrSnapshot(
  service: ArrFlavor, arr: ArrAdapter | null, savePaths: string[],
): Promise<ArrSnapshot> {
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
    visiblePaths: await probeVisibility(arr, savePaths),
  };
}

/** Every distinct directory qBittorrent writes into, deepest duplicates removed. */
function downloadPaths(qb: QbSnapshot): string[] {
  const paths = Object.values(qb.categories ?? {}).map((c) => c.savePath);
  if (qb.defaultSavePath) paths.push(qb.defaultSavePath);
  return [...new Set(paths.filter((p): p is string => typeof p === "string" && p.trim().length > 0))];
}

/**
 * Ask the *arr to browse each save path's parent and report whether the path is
 * there. Listing the parent rather than the path itself is deliberate: an empty
 * directory and a directory that does not exist both list as empty, so only the
 * parent's children distinguish "mounted but idle" from "not mounted at all".
 * A browse call that throws means we could not determine visibility, which is
 * reported as unknown (undefined) rather than as a failure.
 */
async function probeVisibility(
  arr: ArrAdapter, savePaths: string[],
): Promise<Array<{ path: string; visible: boolean }> | undefined> {
  if (savePaths.length === 0) return [];
  try {
    return await Promise.all(savePaths.map(async (path) => {
      const trimmed = path.replace(/\/+$/, "");
      const parent = trimmed.slice(0, trimmed.lastIndexOf("/")) || "/";
      const children = await arr.listFolders(parent);
      const wanted = trimmed.toLowerCase();
      return { path, visible: children.some((c) => c.replace(/\/+$/, "").toLowerCase() === wanted) };
    }));
  } catch {
    return undefined;
  }
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
