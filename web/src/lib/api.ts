/** Tiny fetch wrapper: same-origin, cookie session, CSRF header on mutations. */
let csrfToken: string | null = null;
export function setCsrf(t: string | null) { csrfToken = t; }
export function getCsrf() { return csrfToken; }

export async function api<T = any>(path: string, opts: RequestInit = {}): Promise<T> {
  const method = (opts.method ?? "GET").toUpperCase();
  const headers: Record<string, string> = { ...(opts.headers as any) };
  if (opts.body) headers["content-type"] = "application/json";
  if (!["GET", "HEAD"].includes(method) && csrfToken) headers["x-csrf-token"] = csrfToken;
  const res = await fetch(path, { ...opts, method, headers, credentials: "same-origin" });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
  return data as T;
}

export const bytes = (n: number) => {
  if (!n) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"]; const i = Math.floor(Math.log(n) / Math.log(1024));
  return `${(n / 1024 ** i).toFixed(1)} ${u[i]}`;
};
