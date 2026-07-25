/**
 * Same-origin fetch wrapper: session cookie + CSRF header on mutations.
 *
 * Every request in the SPA goes through here — the polling layer (`usePolled`)
 * and the mutation helper (`useMutation`) are both built on top of it, so the
 * CSRF token and the 401 handling live in exactly one place.
 */

let csrfToken: string | null = null;
export function setCsrf(t: string | null) { csrfToken = t; }
export function getCsrf() { return csrfToken; }

/** Called when the server says the session is gone, so the app can re-gate. */
let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: (() => void) | null) { onUnauthorized = fn; }

/** An HTTP failure that keeps its status so callers can react to 409/404/502. */
export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export function toApiError(e: unknown): ApiError {
  if (e instanceof ApiError) return e;
  // A network-level failure (server down, DNS, offline) has no status.
  return new ApiError(e instanceof Error ? e.message : String(e), 0);
}

export async function api<T = unknown>(path: string, opts: RequestInit = {}): Promise<T> {
  const method = (opts.method ?? "GET").toUpperCase();
  const headers: Record<string, string> = { ...(opts.headers as Record<string, string> | undefined) };
  if (opts.body) headers["content-type"] = "application/json";
  if (!["GET", "HEAD"].includes(method) && csrfToken) headers["x-csrf-token"] = csrfToken;

  let res: Response;
  try {
    res = await fetch(path, { ...opts, method, headers, credentials: "same-origin" });
  } catch (e) {
    throw new ApiError(e instanceof Error ? e.message : "network request failed", 0);
  }

  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = null; }
  }

  if (!res.ok) {
    const message = (data as { error?: string } | null)?.error ?? `HTTP ${res.status}`;
    if (res.status === 401) onUnauthorized?.();
    throw new ApiError(message, res.status);
  }
  return data as T;
}

/** Convenience for mutating calls — the body is always JSON. */
export function apiSend<T = unknown>(
  path: string,
  method: "POST" | "PUT" | "PATCH" | "DELETE",
  body?: unknown,
): Promise<T> {
  return api<T>(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
}

/** Human-readable message for anything thrown by `api`. */
export function errorMessage(e: unknown): string {
  return toApiError(e).message;
}
