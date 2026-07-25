/**
 * The SPA's only data-fetching layer.
 *
 * `usePolled(path, intervalMs)` subscribes a component to a shared cache entry
 * keyed by request path. Properties that matter:
 *
 *  - **in-flight dedupe** — N components asking for the same path share one
 *    request, and a manual refresh during an in-flight request joins it;
 *  - **visibility-aware** — timers are cleared while the tab is hidden and the
 *    data is refreshed immediately when it comes back, so a wall display or a
 *    background tab never hammers qBittorrent;
 *  - **stale surface** — a failed refresh keeps the previous data and exposes
 *    `error` + `updatedAt` so the UI can show "showing data from 30s ago";
 *  - **manual refresh + invalidate** — mutations call `invalidate(prefix)` to
 *    pull fresh data for every affected path.
 *
 * Pages never call `fetch` or set up their own intervals.
 */
import { useCallback, useSyncExternalStore } from "react";
import { api, toApiError, type ApiError } from "./api.js";

export interface Polled<T> {
  data: T | null;
  error: ApiError | null;
  /** True while a request is in flight (initial load *or* a refresh). */
  loading: boolean;
  /** True on the very first load, when there is nothing to show yet. */
  initial: boolean;
  /** Epoch ms of the last successful load, or null. */
  updatedAt: number | null;
  refresh: () => Promise<void>;
}

interface Snapshot {
  data: unknown;
  error: ApiError | null;
  loading: boolean;
  updatedAt: number | null;
}

interface Entry {
  key: string;
  snapshot: Snapshot;
  inflight: Promise<void> | null;
  listeners: Map<() => void, number>; // listener -> desired interval (ms)
  timer: ReturnType<typeof setTimeout> | null;
}

const EMPTY: Snapshot = { data: null, error: null, loading: false, updatedAt: null };
const entries = new Map<string, Entry>();

function getEntry(key: string): Entry {
  let e = entries.get(key);
  if (!e) {
    e = { key, snapshot: EMPTY, inflight: null, listeners: new Map(), timer: null };
    entries.set(key, e);
  }
  return e;
}

function publish(e: Entry, patch: Partial<Snapshot>): void {
  e.snapshot = { ...e.snapshot, ...patch };
  for (const listener of e.listeners.keys()) listener();
}

function fetchEntry(key: string): Promise<void> {
  const e = getEntry(key);
  if (e.inflight) return e.inflight; // dedupe: join the request already running
  publish(e, { loading: true });
  e.inflight = api(key)
    .then((data) => { e.snapshot = { data, error: null, loading: true, updatedAt: Date.now() }; })
    .catch((err) => { e.snapshot = { ...e.snapshot, error: toApiError(err) }; })
    .finally(() => {
      e.inflight = null;
      publish(e, { loading: false });
      schedule(e);
    });
  return e.inflight;
}

/** Chained timeout (not setInterval) so a slow response never stacks requests. */
function schedule(e: Entry): void {
  if (e.timer) { clearTimeout(e.timer); e.timer = null; }
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
  if (!e.listeners.size) return;
  let min = Infinity;
  for (const ms of e.listeners.values()) if (ms > 0 && ms < min) min = ms;
  if (!isFinite(min)) return;
  e.timer = setTimeout(() => { void fetchEntry(e.key); }, Math.max(1000, min));
}

function subscribe(key: string, intervalMs: number, listener: () => void): () => void {
  const e = getEntry(key);
  e.listeners.set(listener, intervalMs);
  // Load on first mount, or when the cached copy predates the poll interval.
  const stale = e.snapshot.updatedAt == null
    || (intervalMs > 0 && Date.now() - e.snapshot.updatedAt > intervalMs);
  if (!e.inflight && stale) void fetchEntry(key);
  else schedule(e);
  return () => {
    e.listeners.delete(listener);
    if (!e.listeners.size && e.timer) { clearTimeout(e.timer); e.timer = null; }
  };
}

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    for (const e of entries.values()) {
      if (!e.listeners.size) continue;
      if (document.visibilityState === "hidden") {
        if (e.timer) { clearTimeout(e.timer); e.timer = null; }
      } else {
        void fetchEntry(e.key); // catch up immediately on return
      }
    }
  });
}

/** Force a refetch of one exact path (no-op if nothing is subscribed to it). */
export function refreshPath(path: string): Promise<void> {
  return fetchEntry(path);
}

/**
 * Refetch every live entry whose path starts with `prefix`. Called after a
 * mutation, e.g. `invalidate("/api/downloads")`.
 */
export function invalidate(...prefixes: string[]): Promise<void> {
  const jobs: Array<Promise<void>> = [];
  for (const e of entries.values()) {
    if (!e.listeners.size) continue;
    if (prefixes.some((p) => e.key.startsWith(p))) jobs.push(fetchEntry(e.key));
  }
  return Promise.all(jobs).then(() => undefined);
}

/** Drop everything — used on logout so a new session never sees stale data. */
export function resetCache(): void {
  for (const e of entries.values()) {
    if (e.timer) clearTimeout(e.timer);
    e.timer = null;
    e.snapshot = EMPTY;
    for (const listener of e.listeners.keys()) listener();
  }
}

/**
 * @param path  request path, or `null` to disable (e.g. before a query term
 *              exists). A disabled hook never fetches and reports empty state.
 * @param intervalMs  poll interval; `0` = fetch once, refresh only on demand.
 */
export function usePolled<T = unknown>(path: string | null, intervalMs = 0): Polled<T> {
  const sub = useCallback(
    (listener: () => void) => (path ? subscribe(path, intervalMs, listener) : () => {}),
    [path, intervalMs],
  );
  const snapshot = useSyncExternalStore(
    sub,
    () => (path ? getEntry(path).snapshot : EMPTY),
    () => EMPTY,
  );
  const refresh = useCallback(() => (path ? fetchEntry(path) : Promise.resolve()), [path]);

  return {
    data: snapshot.data as T | null,
    error: snapshot.error,
    loading: snapshot.loading,
    initial: snapshot.loading && snapshot.updatedAt == null && snapshot.error == null,
    updatedAt: snapshot.updatedAt,
    refresh,
  };
}
