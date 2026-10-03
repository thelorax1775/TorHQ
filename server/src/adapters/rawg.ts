import { httpJson, HttpError } from "./http.js";
import type { AdapterConfig, HealthResult, ServiceAdapter } from "./types.js";
import {
  cachedHealth, clip, finite, yearOf,
  type BrowseOptions, type CatalogueDetail, type CatalogueGenre, type CatalogueItem, type CataloguePage,
} from "./catalogue.js";

/**
 * RAWG — the Catalogue's source for games.
 *
 * Unlike film and TV there is no *arr for games, so nothing downstream keys on
 * a RAWG id: a game is only ever turned into a Prowlarr search term, and the
 * user picks the release. RAWG's job is purely to make the catalogue
 * browsable — what is out, what is coming, what is any good, on which platform.
 */

export const RAWG_DEFAULT_BASE = "https://api.rawg.io";

const PAGE_SIZE = 20;
/** RAWG serves deep pages slowly and not at all past a point; nobody browses that far. */
const MAX_PAGE = 250;

/**
 * RAWG's top-level platform families, by its own `parent_platforms` id. The
 * fine-grained list (PS4 vs PS5, …) is far too long to be a useful filter.
 */
export const RAWG_PLATFORMS = [
  { id: 1, name: "PC" },
  { id: 2, name: "PlayStation" },
  { id: 3, name: "Xbox" },
  { id: 7, name: "Nintendo" },
  { id: 5, name: "macOS" },
  { id: 6, name: "Linux" },
] as const;

/** RAWG answers a failure with `{error}` or `{detail}`. */
export function rawgMessage(e: unknown): string {
  if (e instanceof HttpError && e.body) {
    try {
      const parsed = JSON.parse(e.body) as { error?: string; detail?: string };
      const msg = parsed.error ?? parsed.detail;
      if (msg) return msg;
    } catch { /* not JSON */ }
  }
  return e instanceof Error ? e.message : String(e);
}

/** `YYYY-MM-DD,YYYY-MM-DD`, offsets in days from `now`. */
export function dateRange(fromDays: number, toDays: number, now = new Date()): string {
  const day = (offset: number) => new Date(now.getTime() + offset * 86_400_000).toISOString().slice(0, 10);
  return `${day(fromDays)},${day(toDays)}`;
}

/**
 * RAWG's media server resizes on the fly when `crop/<w>/<h>` is put in the
 * path. The originals are full-resolution screenshots, several MB each, which
 * is far too much for a grid of twenty cards.
 */
export function resized(url: unknown, w: number, h: number): string | undefined {
  if (typeof url !== "string" || !url.startsWith("https://")) return undefined;
  return url.replace("/media/games/", `/media/crop/${w}/${h}/games/`)
    .replace("/media/screenshots/", `/media/crop/${w}/${h}/screenshots/`);
}

/** One RAWG game row → a catalogue item. */
export function normalizeRawg(raw: any): CatalogueItem | null {
  if (typeof raw?.id !== "number" || typeof raw?.name !== "string" || !raw.name) return null;
  const rating = finite(raw.rating);
  const platforms = Array.isArray(raw.parent_platforms)
    ? raw.parent_platforms.map((p: any) => p?.platform?.name).filter((n: unknown): n is string => typeof n === "string")
    : [];
  const genres = Array.isArray(raw.genres)
    ? raw.genres.map((g: any) => g?.name).filter((n: unknown): n is string => typeof n === "string")
    : [];
  return {
    kind: "game",
    id: String(raw.id),
    title: raw.name,
    year: yearOf(raw.released),
    released: typeof raw.released === "string" ? raw.released : undefined,
    poster: resized(raw.background_image, 600, 400),
    backdrop: resized(raw.background_image, 1280, 720),
    // RAWG rates out of 5; the catalogue speaks out of 10 throughout. An
    // unrated game reports 0, which is "no rating", not "terrible".
    rating: rating ? Math.round(rating * 20) / 10 : undefined,
    votes: finite(raw.ratings_count),
    genres,
    platforms,
  };
}

export class RawgAdapter implements ServiceAdapter {
  readonly kind = "rawg";
  readonly status = "functional" as const;

  constructor(private readonly cfg: AdapterConfig) {}

  private get<T>(path: string, query: Record<string, string | number | boolean | undefined> = {}): Promise<T> {
    return httpJson<T>(this.cfg.baseUrl || RAWG_DEFAULT_BASE, `api/${path}`, {
      query: { ...query, key: this.cfg.secret },
    });
  }

  async health(): Promise<HealthResult> {
    if (!this.cfg.secret) return { healthy: false, detail: "no API key set" };
    return cachedHealth(`rawg:${this.cfg.baseUrl}:${this.cfg.secret}`, () => this.check());
  }

  private async check(): Promise<HealthResult> {
    const t0 = Date.now();
    try {
      await this.get("genres", { page_size: 1 });
      return { healthy: true, detail: "API key", latencyMs: Date.now() - t0 };
    } catch (e) {
      return { healthy: false, detail: rawgMessage(e), latencyMs: Date.now() - t0 };
    }
  }

  async genres(): Promise<CatalogueGenre[]> {
    const res = await this.get<{ results?: Array<{ slug?: string; name?: string }> }>("genres", { page_size: 40 });
    return (res?.results ?? [])
      .filter((g) => typeof g.slug === "string" && typeof g.name === "string")
      .map((g) => ({ id: g.slug!, name: g.name! }));
  }

  private async page(query: Record<string, string | number | boolean | undefined>, page: number): Promise<CataloguePage> {
    const res = await this.get<{ count?: number; results?: unknown[] }>("games", { ...query, page, page_size: PAGE_SIZE });
    const items = (res?.results ?? []).map(normalizeRawg).filter((i): i is CatalogueItem => i !== null);
    return {
      items,
      page,
      totalPages: Math.min(Math.max(1, Math.ceil((res?.count ?? 0) / PAGE_SIZE)), MAX_PAGE),
    };
  }

  /** Query parameters that make each named list, relative to `now`. */
  static listQuery(list: BrowseOptions["list"], now = new Date()): Record<string, string> {
    switch (list) {
      case "popular": return { dates: dateRange(-365, 0, now), ordering: "-added" };
      case "top_rated": return { metacritic: "80,100", ordering: "-metacritic" };
      case "new": return { dates: dateRange(-30, 0, now), ordering: "-released" };
      case "upcoming": return { dates: dateRange(1, 365, now), ordering: "-added" };
      // "Trending": released recently and being added to libraries fastest.
      default: return { dates: dateRange(-90, 0, now), ordering: "-added" };
    }
  }

  async browse(opts: BrowseOptions = {}): Promise<CataloguePage> {
    const page = Math.min(Math.max(opts.page ?? 1, 1), MAX_PAGE);
    return this.page({
      ...RawgAdapter.listQuery(opts.list),
      genres: opts.genre || undefined,
      parent_platforms: opts.platform,
    }, page);
  }

  async search(q: string, page = 1, platform?: number): Promise<CataloguePage> {
    return this.page(
      { search: q, search_precise: true, parent_platforms: platform },
      Math.min(Math.max(page, 1), MAX_PAGE),
    );
  }

  async details(id: string): Promise<CatalogueDetail> {
    const raw = await this.get<any>(`games/${encodeURIComponent(id)}`);
    const item = normalizeRawg(raw);
    if (!item) throw new Error(`RAWG has no game ${id}`);
    const developers = Array.isArray(raw.developers)
      ? raw.developers.map((d: any) => d?.name).filter((n: unknown): n is string => typeof n === "string")
      : [];
    return {
      ...item,
      overview: clip(raw.description_raw, 4000),
      developers,
      homepage: typeof raw.website === "string" && raw.website ? raw.website : undefined,
      sourceUrl: typeof raw.slug === "string" ? `https://rawg.io/games/${raw.slug}` : undefined,
    };
  }
}
