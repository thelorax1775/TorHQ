import { httpJson, HttpError } from "./http.js";
import type { AdapterConfig, HealthResult, ServiceAdapter } from "./types.js";
import {
  cachedHealth, clip, finite, yearOf,
  type BrowseOptions, type CatalogueDetail, type CatalogueGenre, type CatalogueItem, type CataloguePage,
} from "./catalogue.js";

/**
 * The Movie Database — the Catalogue's source for film and TV.
 *
 * It is the same database Radarr keys on, which is what makes the hand-off to
 * Get exact rather than a fuzzy title match: a TMDB movie id *is* Radarr's
 * `tmdb:<id>` selection id. Sonarr keys on TVDB, so a show's TVDB id is read
 * from TMDB's external ids when the user opens it.
 *
 * TMDB hands out two credentials for the same account, and either works here:
 * the short v3 "API key" (sent as `api_key`) or the long v4 "API Read Access
 * Token", a JWT (sent as a bearer token). Which one was pasted is obvious from
 * its shape, so nobody has to say.
 */

export const TMDB_DEFAULT_BASE = "https://api.themoviedb.org";
const IMAGE_BASE = "https://image.tmdb.org/t/p";

/** TMDB will not page past 500, whatever `total_pages` claims. */
const MAX_PAGE = 500;

/** TMDB answers a failure with `{status_message}`; the status line alone says nothing. */
export function tmdbMessage(e: unknown): string {
  if (e instanceof HttpError && e.body) {
    try {
      const msg = (JSON.parse(e.body) as { status_message?: string }).status_message;
      if (msg) return msg;
    } catch { /* not JSON */ }
  }
  return e instanceof Error ? e.message : String(e);
}

/**
 * The API base to call. The website (themoviedb.org, www.themoviedb.org) is the
 * URL people naturally paste, and it answers every API path with a 404, so it is
 * mapped to the API host rather than left to fail.
 */
export function tmdbBase(configured: string | undefined): string {
  const raw = configured?.trim();
  if (!raw) return TMDB_DEFAULT_BASE;
  try {
    const host = new URL(raw).hostname.toLowerCase();
    if (host === "themoviedb.org" || host === "www.themoviedb.org") return TMDB_DEFAULT_BASE;
  } catch {
    return TMDB_DEFAULT_BASE;
  }
  return raw;
}

type TmdbKind = "movie" | "tv";

/** Genre names by id, per kind. They change about once a decade. */
const genreCache = new Map<TmdbKind, { at: number; genres: CatalogueGenre[] }>();
const GENRE_TTL_MS = 24 * 60 * 60 * 1000;

export function image(path: unknown, size: "w342" | "w780"): string | undefined {
  return typeof path === "string" && path.startsWith("/") ? `${IMAGE_BASE}/${size}${path}` : undefined;
}

/** One TMDB list/search row → a catalogue item. */
export function normalizeTmdb(raw: any, kind: TmdbKind, genreNames: Map<string, string>): CatalogueItem | null {
  if (typeof raw?.id !== "number") return null;
  const title = kind === "movie" ? raw.title : raw.name;
  if (typeof title !== "string" || !title) return null;
  const released = kind === "movie" ? raw.release_date : raw.first_air_date;
  const ids: unknown[] = Array.isArray(raw.genre_ids)
    ? raw.genre_ids
    : Array.isArray(raw.genres) ? raw.genres.map((g: any) => g?.id) : [];
  return {
    kind,
    id: String(raw.id),
    title,
    year: yearOf(released),
    released: typeof released === "string" && released ? released : undefined,
    overview: clip(raw.overview),
    poster: image(raw.poster_path, "w342"),
    backdrop: image(raw.backdrop_path, "w780"),
    rating: finite(raw.vote_average),
    votes: finite(raw.vote_count),
    genres: ids.map((id) => genreNames.get(String(id))).filter((n): n is string => !!n),
    selectionId: kind === "movie" ? `tmdb:${raw.id}` : undefined,
  };
}

export class TmdbAdapter implements ServiceAdapter {
  readonly kind = "tmdb";
  readonly status = "functional" as const;

  constructor(private readonly cfg: AdapterConfig) {}

  private get base(): string {
    return this.cfg.baseUrl || TMDB_DEFAULT_BASE;
  }

  /** A v4 read token is a JWT; anything else is a v3 key. */
  private get isBearer(): boolean {
    return this.cfg.secret.startsWith("eyJ");
  }

  private get<T>(path: string, query: Record<string, string | number | undefined> = {}): Promise<T> {
    return httpJson<T>(this.base, `3/${path}`, {
      headers: this.isBearer ? { authorization: `Bearer ${this.cfg.secret}` } : {},
      query: { ...query, ...(this.isBearer ? {} : { api_key: this.cfg.secret }) },
    });
  }

  async health(): Promise<HealthResult> {
    if (!this.cfg.secret) return { healthy: false, detail: "no API key set" };
    return cachedHealth(`tmdb:${this.cfg.baseUrl}:${this.cfg.secret}`, () => this.check());
  }

  private async check(): Promise<HealthResult> {
    const t0 = Date.now();
    try {
      // /configuration is the cheapest authenticated call TMDB has.
      await this.get("configuration");
      return { healthy: true, detail: this.isBearer ? "read access token" : "API key", latencyMs: Date.now() - t0 };
    } catch (e) {
      return { healthy: false, detail: tmdbMessage(e), latencyMs: Date.now() - t0 };
    }
  }

  async genres(kind: TmdbKind): Promise<CatalogueGenre[]> {
    const hit = genreCache.get(kind);
    if (hit && Date.now() - hit.at < GENRE_TTL_MS) return hit.genres;
    const res = await this.get<{ genres?: Array<{ id?: number; name?: string }> }>(`genre/${kind}/list`);
    const genres = (res?.genres ?? [])
      .filter((g) => typeof g.id === "number" && typeof g.name === "string")
      .map((g) => ({ id: String(g.id), name: g.name! }));
    // An empty answer is a hiccup, not TMDB abolishing genres: don't keep it.
    if (genres.length) genreCache.set(kind, { at: Date.now(), genres });
    return genres;
  }

  /** Genre names are decoration: a failure to fetch them must not fail the list. */
  private async genreNames(kind: TmdbKind): Promise<Map<string, string>> {
    try {
      return new Map((await this.genres(kind)).map((g) => [g.id, g.name]));
    } catch {
      return new Map();
    }
  }

  private async page(kind: TmdbKind, path: string, query: Record<string, string | number | undefined>): Promise<CataloguePage> {
    const [res, names] = await Promise.all([
      this.get<{ page?: number; total_pages?: number; results?: unknown[] }>(path, query),
      this.genreNames(kind),
    ]);
    const items = (res?.results ?? [])
      .map((r) => normalizeTmdb(r, kind, names))
      .filter((i): i is CatalogueItem => i !== null);
    return {
      items,
      page: res?.page ?? 1,
      totalPages: Math.min(res?.total_pages ?? 1, MAX_PAGE),
    };
  }

  /**
   * One page of a list. A genre turns any list into TMDB's `discover`, ordered
   * the way the chosen list would be, since TMDB's named lists cannot be
   * filtered by genre themselves.
   */
  async browse(kind: TmdbKind, opts: BrowseOptions = {}): Promise<CataloguePage> {
    const page = Math.min(Math.max(opts.page ?? 1, 1), MAX_PAGE);
    const list = opts.list ?? "trending";

    if (opts.genre) {
      const sort = list === "top_rated" ? "vote_average.desc" : "popularity.desc";
      return this.page(kind, `discover/${kind}`, {
        page,
        with_genres: opts.genre,
        sort_by: sort,
        // Without a floor, "top rated" is topped by things three people voted on.
        "vote_count.gte": list === "top_rated" ? 200 : undefined,
      });
    }
    if (list === "trending") return this.page(kind, `trending/${kind}/week`, { page });
    return this.page(kind, `${kind}/${list}`, { page });
  }

  async search(kind: TmdbKind, q: string, page = 1): Promise<CataloguePage> {
    return this.page(kind, `search/${kind}`, { query: q, page: Math.min(Math.max(page, 1), MAX_PAGE), include_adult: "false" });
  }

  async details(kind: TmdbKind, id: string): Promise<CatalogueDetail> {
    const raw = await this.get<any>(`${kind}/${encodeURIComponent(id)}`, {
      append_to_response: kind === "tv" ? "external_ids" : undefined,
    });
    const item = normalizeTmdb(raw, kind, new Map());
    if (!item) throw new Error(`TMDB has no ${kind} ${id}`);
    const genres = Array.isArray(raw.genres)
      ? raw.genres.map((g: any) => g?.name).filter((n: unknown): n is string => typeof n === "string")
      : [];
    const tvdbId = finite(raw.external_ids?.tvdb_id);
    return {
      ...item,
      overview: clip(raw.overview, 4000),
      genres,
      runtime: finite(raw.runtime) ?? finite(raw.episode_run_time?.[0]),
      seasons: finite(raw.number_of_seasons),
      status: typeof raw.status === "string" ? raw.status : undefined,
      homepage: typeof raw.homepage === "string" && raw.homepage ? raw.homepage : undefined,
      selectionId: kind === "movie" ? `tmdb:${raw.id}` : tvdbId ? `tvdb:${tvdbId}` : undefined,
      sourceUrl: `https://www.themoviedb.org/${kind}/${raw.id}`,
    };
  }
}
