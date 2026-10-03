import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Self-update from the web UI.
 *
 * The service runs unprivileged and cannot rebuild or restart itself, so it only
 * drops a request file in `<data>/update/`. A root-owned systemd path unit
 * (`torhq-update.path`) notices it and runs `/usr/local/sbin/torhq-update`,
 * which does the git/npm work as the torhq user and writes progress back to
 * `status.json` and `update.log` in the same directory.
 */
export type UpdateAction = "check" | "apply";
export type UpdateState = "idle" | "running" | "restarting" | "done" | "failed";

export interface UpdateCommit { sha: string; subject: string }

export interface UpdateStatus {
  state: UpdateState;
  action?: UpdateAction;
  step?: string | null;
  message?: string | null;
  branch?: string;
  current?: UpdateCommit;
  latest?: string;
  behind?: number;
  diverged?: boolean;
  commits?: UpdateCommit[];
  startedAt?: number;
  finishedAt?: number | null;
  checkedAt?: number;
  updatedAt?: number;
}

export interface UpdateView {
  available: boolean;
  pending: { action: UpdateAction; requestedAt: number; stale: boolean } | null;
  status: UpdateStatus;
  log: string[];
}

const LOG_LINES = 60;
const STALE_REQUEST_MS = 2 * 60_000;
const STALE_RUN_MS = 45 * 60_000;

export function updateDir(dataDir: string): string {
  return join(dataDir, "update");
}

function readStatus(dir: string): UpdateStatus {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, "status.json"), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : { state: "idle" };
  } catch {
    return { state: "idle" };
  }
}

function readLogTail(dir: string): string[] {
  try {
    const lines = readFileSync(join(dir, "update.log"), "utf8").split("\n");
    while (lines.length && lines[lines.length - 1] === "") lines.pop();
    return lines.slice(-LOG_LINES);
  } catch {
    return [];
  }
}

function readPending(dir: string, now: number): UpdateView["pending"] {
  const file = join(dir, "request");
  try {
    const action = readFileSync(file, "utf8").trim();
    if (action !== "check" && action !== "apply") return null;
    const requestedAt = statSync(file).mtimeMs;
    return { action, requestedAt, stale: now - requestedAt > STALE_REQUEST_MS };
  } catch {
    return null;
  }
}

/** True while a run is in progress and has reported recently enough to be believed. */
export function isBusy(status: UpdateStatus, now = Date.now()): boolean {
  if (status.state !== "running" && status.state !== "restarting") return false;
  return now - (status.updatedAt ?? status.startedAt ?? 0) < STALE_RUN_MS;
}

export function readUpdateView(dataDir: string, unitPath: string, now = Date.now()): UpdateView {
  const dir = updateDir(dataDir);
  return {
    available: existsSync(unitPath),
    pending: readPending(dir, now),
    status: readStatus(dir),
    log: readLogTail(dir),
  };
}

/**
 * Queue an action for the root helper. Returns a reason string when the request
 * is refused, or null once the request file is in place.
 */
export function requestUpdate(dataDir: string, unitPath: string, action: UpdateAction, now = Date.now()): string | null {
  const view = readUpdateView(dataDir, unitPath, now);
  if (!view.available) return "the updater is not installed on this host — run scripts/upgrade.sh once as root";
  if (view.pending && !view.pending.stale) return `a ${view.pending.action} is already queued`;
  if (isBusy(view.status, now)) return `an update ${view.status.action ?? "run"} is already in progress`;
  const dir = updateDir(dataDir);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `request.${process.pid}.tmp`);
  writeFileSync(tmp, `${action}\n`);
  renameSync(tmp, join(dir, "request"));
  return null;
}
