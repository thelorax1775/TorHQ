import type { AdapterConfig, HealthResult, ServiceAdapter } from "./types.js";

/**
 * General web search — the "look it up on the open web" widget that sits next
 * to the torrent-index search. See `WebSearchExtra` in config/extra.ts for the
 * three providers. Google's HTML search page is never scraped: it blocks
 * server-side fetches and scraping it would violate Google's terms. The `link`
 * provider therefore returns query URLs for the browser to open, while the
 * `google` (Programmable Search JSON API) and `searxng` providers return real
 * results TorHQ can render inline.
 */
export interface WebResult {
  title: string;
  url: string;
  displayUrl?: string;
  snippet?: string;
}

/** A one-click "search this term on <site>" URL handed to the browser. */
export interface WebLink {
  label: string;
  url: string;
}

export interface WebSearchResponse {
  provider: "link" | "google" | "searxng";
  /** Inline results; always empty for the `link` provider. */
  results: WebResult[];
  /** Open-in-a-tab query URLs; always present so the widget is never useless. */
  links: WebLink[];
  /** Set when a configured provider failed and TorHQ fell back to links. */
  degraded?: string;
}

export class WebSearchAdapter implements ServiceAdapter {
  readonly kind = "websearch";
  readonly status = "functional" as const;
  constructor(protected cfg: AdapterConfig) {}

  async health(): Promise<HealthResult> {
    return { healthy: true, detail: "link provider (no backend call)" };
  }

  async search(_query: string): Promise<WebSearchResponse> {
    return { provider: "link", results: [], links: [] };
  }
}
