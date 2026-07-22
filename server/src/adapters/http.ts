import { request } from "undici";

export interface HttpOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  timeoutMs?: number;
}

export class HttpError extends Error {
  constructor(message: string, readonly statusCode: number, readonly body?: string) {
    super(message);
    this.name = "HttpError";
  }
}

function buildUrl(base: string, path: string, query?: HttpOptions["query"]): string {
  const url = new URL(path.replace(/^\//, ""), base.endsWith("/") ? base : base + "/");
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

/** Minimal typed HTTP client for adapters (JSON in/out, timeouts, errors). */
export async function httpJson<T = unknown>(
  base: string,
  path: string,
  opts: HttpOptions = {},
): Promise<T> {
  const { method = "GET", headers = {}, query, body, timeoutMs = 8000 } = opts;
  const url = buildUrl(base, path, query);
  const hasBody = body !== undefined;
  const res = await request(url, {
    method,
    headers: {
      accept: "application/json",
      ...(hasBody ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    body: hasBody ? JSON.stringify(body) : undefined,
    headersTimeout: timeoutMs,
    bodyTimeout: timeoutMs,
  });
  const text = await res.body.text();
  if (res.statusCode >= 400) {
    throw new HttpError(`HTTP ${res.statusCode} for ${url}`, res.statusCode, text.slice(0, 500));
  }
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
}

export function basicAuth(secret: string): string {
  // secret stored as "username:password"
  return "Basic " + Buffer.from(secret).toString("base64");
}
