import { promises as fs, constants as FS } from "node:fs";
import { join, basename } from "node:path";
import type { Buffer } from "node:buffer";
import { getLibrary } from "../config/store.js";
import { getAdapter } from "../adapters/registry.js";
import { NavidromeAdapter } from "../adapters/navidrome.js";
import { KavitaAdapter } from "../adapters/kavita.js";
import type { Library } from "../db/schema.js";
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

interface ResolvedPaths {
  lib: Library;
  /** Canonical destination base directory (may not yet exist). */
  destBase: string;
  /** Final destination path (destBase/finalName). */
  destPath: string;
  /** Canonical staging directory (may not yet exist). */
  stagingBase: string;
  finalName: string;
  /** Canonical source path, or null on the idempotent path when already consumed. */
  source: string | null;
}

/**
 * Resolve and validate every path an intake touches against the approved roots:
 * the source, the destination base, and the staging directory. The composed
 * destination is re-validated so a crafted targetName cannot escape the root.
 * `requireSource` is false on the idempotent "already imported" path where the
 * source may already have been consumed by a prior successful run.
 */
function resolvePaths(
  payload: IntakePayload,
  approvedRoots: string[],
  opts: { requireSource: boolean },
): ResolvedPaths {
  const lib = getLibrary(payload.libraryKey);
  if (!lib) throw new Error(`Unknown library: ${payload.libraryKey}`);

  const destBase = safeResolve(lib.destPath, approvedRoots, { mustExist: false });
  const stagingBase = safeResolve(lib.stagingPath, approvedRoots, { mustExist: false });

  const finalName = safeFilename(payload.targetName ?? basename(payload.sourcePath));
  const destPath = join(destBase, finalName);
  // Re-validate the composed destination stays contained (defends targetName).
  safeResolve(destPath, approvedRoots, { mustExist: false });

  let source: string | null = null;
  if (opts.requireSource) {
    source = safeResolve(payload.sourcePath, approvedRoots, { mustExist: true });
  } else {
    try {
      source = safeResolve(payload.sourcePath, approvedRoots, { mustExist: true });
    } catch {
      source = null; // already consumed; tolerated on the idempotent path
    }
  }

  return { lib, destBase, destPath, stagingBase, finalName, source };
}

/**
 * Build a dry-run preview: validates source & destination against approved
 * roots, rejects symlink escapes, and shows exactly what will be imported.
 */
export async function previewIntake(
  payload: IntakePayload,
  approvedRoots: string[],
): Promise<IntakePreview> {
  const { lib, destPath, source } = resolvePaths(payload, approvedRoots, { requireSource: true });
  const src = source!;
  const warnings: string[] = [];

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

async function exists(path: string): Promise<boolean> {
  try { await fs.access(path, FS.F_OK); return true; } catch { return false; }
}

/**
 * Execute an intake job as an explicit, restart-safe state machine:
 *
 *   validate → [already imported? → rescan → done]
 *            → stage  (copy source into a per-job staging workdir)
 *            → commit (ATOMIC rename staging → destination; the only reveal
 *                      to the media scanner)
 *            → cleanup (remove the consumed source + staging workdir)
 *            → rescan (best-effort; import already succeeded)
 *
 * Properties:
 *  - Idempotent: if the destination already exists it succeeds without
 *    duplicating (safe to retry after a crash between commit and completion).
 *  - Atomic reveal: partial data only ever lives in the hidden staging workdir,
 *    never inside the live library directory, so a scanner never sees a
 *    half-imported item.
 *  - Restart-safe: the per-job staging workdir is deterministic and any stale
 *    remnant from a prior attempt is cleared before re-staging.
 *  - Non-destructive to the source until the atomic commit has succeeded.
 */
export async function runIntake(
  jobId: string,
  payload: IntakePayload,
  approvedRoots: string[],
  masterKey: Buffer,
): Promise<{ destPath: string; alreadyImported: boolean }> {
  const { lib, destBase, destPath, stagingBase, finalName, source } =
    resolvePaths(payload, approvedRoots, { requireSource: false });

  // Idempotency: destination already present → treat as imported. Makes a retry
  // after a crash between commit and completion a no-op instead of a duplicate.
  if (await exists(destPath)) {
    logActivity({ kind: "info", jobId, service: lib.targetService, message: `Destination already present, skipping move: ${finalName}` });
    if (source && source !== destPath) await fs.rm(source, { recursive: true, force: true }).catch(() => {});
    await maybeRescan(lib, jobId, masterKey);
    logActivity({ kind: "imported", jobId, service: lib.targetService, message: `Imported ${finalName} (already present)` });
    return { destPath, alreadyImported: true };
  }

  if (!source) {
    throw new PathValidationError(`Source not found and destination absent: ${payload.sourcePath}`, "NOT_FOUND");
  }

  // --- stage ---------------------------------------------------------------
  // Per-job staging workdir: deterministic (recoverable after a crash), hidden
  // (dot-prefixed so watchers ignore it), and outside the library directory.
  const workDir = join(stagingBase, `.intake-${jobId}`);
  const staged = join(workDir, finalName);
  logActivity({ kind: "importing", jobId, service: lib.targetService, message: `Staging ${finalName}` });
  await fs.rm(workDir, { recursive: true, force: true }); // clear any stale remnant
  await fs.mkdir(workDir, { recursive: true });
  try {
    // Copy (not move) so the source survives until the atomic commit succeeds,
    // which keeps retries safe. Symlinks are preserved verbatim, not followed.
    await fs.cp(source, staged, { recursive: true, verbatimSymlinks: true });

    // --- commit ------------------------------------------------------------
    await fs.mkdir(destBase, { recursive: true });
    logActivity({ kind: "importing", jobId, service: lib.targetService, message: `Committing to ${destPath}` });
    try {
      await fs.rename(staged, destPath); // atomic when staging & dest share a filesystem
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code === "EXDEV") {
        throw new Error(
          `Staging directory and destination are on different filesystems, so the ` +
          `import cannot be revealed atomically. Put the library's staging path on the ` +
          `same filesystem as its destination (both inside an approved root).`,
        );
      }
      throw err;
    }
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }

  // --- cleanup source ------------------------------------------------------
  await fs.rm(source, { recursive: true, force: true }).catch(() => {});

  // --- rescan (best-effort; the import already succeeded) ------------------
  await maybeRescan(lib, jobId, masterKey);

  logActivity({ kind: "imported", jobId, service: lib.targetService, message: `Imported ${finalName}` });
  return { destPath, alreadyImported: false };
}

async function maybeRescan(lib: Library, jobId: string, masterKey: Buffer): Promise<void> {
  if (!lib.rescan) return;
  try {
    await requestRescan(lib, masterKey);
  } catch (e) {
    logActivity({ kind: "info", jobId, service: lib.targetService, message: `Rescan request failed: ${(e as Error).message}` });
  }
}

/**
 * Trigger a library rescan on the target service. Manual-intake targets are
 * Kavita (books/manga/comics) and Navidrome (music) only — movies/TV are
 * *arr-owned and never intake targets, so Jellyfin is not handled here.
 */
async function requestRescan(lib: Library, masterKey: Buffer): Promise<void> {
  if (lib.targetService === "navidrome") {
    const a = getAdapter("navidrome", masterKey) as NavidromeAdapter | null;
    if (a) await a.startScan();
  } else if (lib.targetService === "kavita") {
    const a = getAdapter("kavita", masterKey) as KavitaAdapter | null;
    // scanLibrary() with no arg uses the libraryId from the kavita service's
    // extra config when set; otherwise Kavita's folder watcher picks up files.
    if (a) await a.scanLibrary();
  }
}

export { PathValidationError };
