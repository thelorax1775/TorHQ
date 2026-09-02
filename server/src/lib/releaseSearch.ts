import { randomUUID } from "node:crypto";
import type { ArrFlavor, ArrRelease } from "../adapters/arr.js";

/**
 * An *arr's interactive search is slow — it queries every indexer in series and
 * routinely takes one to three minutes. That does not fit a request the browser
 * is waiting on: a reverse proxy, a laptop lid, or a page navigation all kill it
 * halfway and the work is lost with no way to ask "is it still going?".
 *
 * So a search is started once, given a token, and polled. This is deliberately
 * **in-memory and not durable**: a release list is only meaningful for the
 * minutes it takes to choose one from it, and a restart should discard it rather
 * than hand back a list of releases that may no longer exist. Durable work —
 * the grab, the import — is the *arr's, and the *arr already persists it.
 */

export type SearchStatus = "running" | "done" | "error";

export interface SearchJob {
  id: string;
  service: ArrFlavor;
  /** What was searched, for the UI to label the result set. */
  label: string;
  status: SearchStatus;
  startedAt: number;
  finishedAt?: number;
  releases?: ArrRelease[];
  error?: string;
}

/** Public view — the release list is only sent once it exists. */
export interface SearchJobView {
  id: string;
  service: ArrFlavor;
  label: string;
  status: SearchStatus;
  elapsedMs: number;
  releases: ArrRelease[] | null;
  error: string | null;
}

/** Long enough to pick a release from a finished list, short enough to forget. */
const TTL_MS = 15 * 60 * 1000;
/** A search that outlives this is treated as hung rather than left "running". */
const MAX_RUN_MS = 5 * 60 * 1000;

const jobs = new Map<string, SearchJob>();

/** Drop finished jobs past their TTL, and fail ones that never came back. */
function sweep(now = Date.now()): void {
  for (const [id, job] of jobs) {
    if (job.status === "running") {
      if (now - job.startedAt > MAX_RUN_MS) {
        job.status = "error";
        job.error = "the search did not finish in five minutes";
        job.finishedAt = now;
      }
      continue;
    }
    if (now - (job.finishedAt ?? job.startedAt) > TTL_MS) jobs.delete(id);
  }
}

/**
 * Start a search and return its job immediately. `work` runs detached: its
 * rejection is captured onto the job, never left to become an unhandled
 * rejection that takes the process down.
 */
export function startSearch(
  service: ArrFlavor,
  label: string,
  work: () => Promise<ArrRelease[]>,
): SearchJob {
  sweep();
  const job: SearchJob = { id: randomUUID(), service, label, status: "running", startedAt: Date.now() };
  jobs.set(job.id, job);
  void work().then(
    (releases) => {
      job.releases = sortReleases(releases);
      job.status = "done";
      job.finishedAt = Date.now();
    },
    (err: unknown) => {
      job.error = err instanceof Error ? err.message : String(err);
      job.status = "error";
      job.finishedAt = Date.now();
    },
  );
  return job;
}

/**
 * Grabbable releases first, then by seeders. A release the *arr's profile
 * rejected is still shown — it can be grabbed as a deliberate override — but it
 * never outranks one the *arr would have taken itself.
 */
function sortReleases(releases: ArrRelease[]): ArrRelease[] {
  return [...releases].sort((a, b) => {
    if (a.rejected !== b.rejected) return a.rejected ? 1 : -1;
    return (b.seeders ?? -1) - (a.seeders ?? -1);
  });
}

export function getSearch(id: string): SearchJob | null {
  sweep();
  return jobs.get(id) ?? null;
}

export function viewOf(job: SearchJob): SearchJobView {
  return {
    id: job.id,
    service: job.service,
    label: job.label,
    status: job.status,
    elapsedMs: (job.finishedAt ?? Date.now()) - job.startedAt,
    releases: job.releases ?? null,
    error: job.error ?? null,
  };
}

/** Test seam: forget every job. */
export function resetSearches(): void {
  jobs.clear();
}
