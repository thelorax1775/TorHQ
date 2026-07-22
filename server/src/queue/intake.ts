import { randomUUID } from "node:crypto";
import { promises as fs, constants as FS } from "node:fs";
import { join, basename, dirname } from "node:path";
import type { Buffer } from "node:buffer";
import { getLibrary } from "../config/store.js";
import { getAdapter } from "../adapters/registry.js";
import { NavidromeAdapter } from "../adapters/navidrome.js";
import { KavitaAdapter } from "../adapters/kavita.js";
import { safeResolve, safeFilename, PathValidationError } from "../security/paths.js";
import { logActivity } from "../lib/activity.js";

export interface IntakePayload {
  libraryKey: string;
  sourcePath: string;
  targetName?: string; // optional final folder/file name
}

export interface IntakePreview {
  libraryKey: string;
  sourcePath: string;
  destPath: string;
  entries: Array<{ name: string; size: number; isDir: boolean }>;
  totalBytes: number;
  warnings: string[];
}

/**
 * Build a dry-run preview: validates source & destination against approved
 * roots, rejects symlink escapes, and shows exactly what will be imported.
 */
export async function previewIntake(
  payload: IntakePayload,
  approvedRoots: string[],
): Promise<IntakePreview> {
  const lib = getLibrary(payload.libraryKey);
  if (!lib) throw new Error(`Unknown library: ${payload.libraryKey}`);
  const warnings: string[] = [];

  // Source must exist and be inside approved roots (symlink-safe).
  const src = safeResolve(payload.sourcePath, approvedRoots, { mustExist: true });
  // Destination base must be inside approved roots (may not exist yet).
  const destBase = safeResolve(lib.destPath, approvedRoots, { mustExist: false });

  const finalName = safeFilename(payload.targetName ?? basename(src));
  const destPath = join(destBase, finalName);
  // Re-validate the composed destination stays contained.
  safeResolve(destPath, approvedRoots, { mustExist: false });

  const entries: IntakePreview["entries"] = [];
  let totalBytes = 0;
  const stat = await fs.lstat(src);
  if (stat.isDirectory()) {
    for (const name of await fs.readdir(src)) {
      const p = join(src, name);
      const st = await fs.lstat(p);
      if (st.isSymbolicLink()) { warnings.push(`Skipping symlink: ${name}`); continue; }
      entries.push({ name, size: st.size, isDir: st.isDirectory() });
      totalBytes += st.size;
    }
  } else {
    entries.push({ name: basename(src), size: stat.size, isDir: false });
    totalBytes = stat.size;
  }
  return { libraryKey: lib.key, sourcePath: src, destPath, entries, totalBytes, warnings };
}

/** Move a path atomically when on the same filesystem; fall back to copy+rename. */
async function atomicMove(src: string, dest: string): Promise<void> {
  await fs.mkdir(dirname(dest), { recursive: true });
  const tmp = dest + ".torhq-partial-" + randomUUID().slice(0, 8);
  try {
    // Fast path: same-filesystem rename is atomic.
    await fs.rename(src, dest);
    return;
  } catch (err: any) {
    if (err.code !== "EXDEV") throw err;
  }
  // Cross-device: copy to temp then atomic rename into place.
  await fs.cp(src, tmp, { recursive: true });
  await fs.rename(tmp, dest);
  await fs.rm(src, { recursive: true, force: true });
}

/**
 * Execute an intake job. Idempotent: if destination already exists it succeeds
 * without duplicating. Requests a library rescan on the target service.
 */
export async function runIntake(
  jobId: string,
  payload: IntakePayload,
  approvedRoots: string[],
  masterKey: Buffer,
): Promise<{ destPath: string }> {
  const lib = getLibrary(payload.libraryKey);
  if (!lib) throw new Error(`Unknown library: ${payload.libraryKey}`);

  const preview = await previewIntake(payload, approvedRoots);
  logActivity({ kind: "importing", jobId, service: lib.targetService, message: `Importing to ${preview.destPath}` });

  // Idempotency: skip move if already present.
  let alreadyThere = false;
  try { await fs.access(preview.destPath, FS.F_OK); alreadyThere = true; } catch { /* not present */ }

  if (!alreadyThere) {
    // Stage: validate staging dir is contained too.
    safeResolve(lib.stagingPath, approvedRoots, { mustExist: false });
    await atomicMove(preview.sourcePath, preview.destPath);
  }

  // Request rescan where supported (best-effort; import already succeeded).
  if (lib.rescan) {
    try { await requestRescan(lib.targetService, masterKey); }
    catch (e) { logActivity({ kind: "info", jobId, service: lib.targetService, message: `Rescan request failed: ${(e as Error).message}` }); }
  }

  logActivity({ kind: "imported", jobId, service: lib.targetService, message: `Imported ${basename(preview.destPath)}` });
  return { destPath: preview.destPath };
}

/**
 * Trigger a rescan on the target service after a manual intake.
 *
 * Manual-intake libraries only ever target Kavita (books/manga/comics) or
 * Navidrome (music) — see the `targetService` enum in routes/setup.ts. Video is
 * owned by Radarr/Sonarr and their download clients, so Jellyfin is never a
 * manual-intake target and is not handled here (TorHQ only health-checks it).
 */
async function requestRescan(target: string, masterKey: Buffer): Promise<void> {
  if (target === "navidrome") {
    const a = getAdapter("navidrome", masterKey) as NavidromeAdapter | null;
    if (a) await a.startScan();
  } else if (target === "kavita") {
    const a = getAdapter("kavita", masterKey) as KavitaAdapter | null;
    if (a) await a.scanLibrary();
  }
}

export { PathValidationError };
