import type { HealthResult } from "./types.js";

/**
 * Shared shapes for the Catalogue: a browsable list of things worth getting,
 * drawn from public metadata sources (TMDB for film and TV, RAWG for games).
 *
 * These sources only *describe* titles. Nothing here downloads, adds or files
 * anything: a movie or show is handed to the Get flow, where its *arr owns the
 * rest, and a game to a Prowlarr search the user picks a release from.
 */

export type CatalogueKind = "movie" | "tv" | "game";

/** The lists a kind can be browsed by. Not every list exists for every kind. */
export const CATALOGUE_LISTS = {
  movie: ["trending", "popular", "top_rated", "upcoming", "now_playing"],
  tv: ["trending", "popular", "top_rated", "on_the_air"],
  game: ["trending", "popular", "top_rated", "new", "upcoming"],
} as const satisfies Record<CatalogueKind, readonly string[]>;

export type CatalogueList = (typeof CATALOGUE_LISTS)[CatalogueKind][number];

export interface CatalogueItem {
  kind: CatalogueKind;
  /** The source's own id (TMDB or RAWG), as a string. */
  id: string;
  title: string;
  year?: number;
  /** ISO date of first release, when the source has one. */
  released?: string;
  overview?: string;
  poster?: string;
  backdrop?: string;
  /** Normalised to 0–10 whatever scale the source uses. */
  rating?: number;
  votes?: number;
  genres: string[];
  /** Games only: the platform families it shipped on (PC, PlayStation, …). */
  platforms?: string[];
  /**
   * The Get flow's selector for this exact title, when one is known without an
   * extra lookup. Movies are always `tmdb:<id>` (Radarr keys on TMDB); a show
   * needs its TVDB id, which only the detail call returns.
   */
  selectionId?: string;
  /** Already in Radarr/Sonarr. Unset when that could not be checked. */
  inLibrary?: boolean;
}

export interface CataloguePage {
  items: CatalogueItem[];
  page: number;
  totalPages: number;
}

export interface CatalogueGenre {
  /** What the browse call takes back: a TMDB genre id or a RAWG slug. */
  id: string;
  name: string;
}

/** The extra a detail view needs beyond what a list row carries. */
export interface CatalogueDetail extends CatalogueItem {
  runtime?: number;
  seasons?: number;
  status?: string;
  homepage?: string;
  developers?: string[];
  /** The page on the source itself, for anyone who wants to read more. */
  sourceUrl?: string;
}

export interface BrowseOptions {
  list?: CatalogueList;
  genre?: string;
  /** Games only: a RAWG parent-platform id. */
  platform?: number;
  page?: number;
}

/**
 * The dashboard health-checks every service every 30 seconds. For a local *arr
 * that is free; for RAWG, whose free tier allows 20,000 requests a month, it
 * alone would spend the allowance four times over. So a *passing* check of a
 * public metadata API is reused for ten minutes. A failing one never is: a key
 * that was just fixed must show as fixed on the next poll.
 */
const HEALTH_TTL_MS = 10 * 60 * 1000;
const healthCache = new Map<string, { at: number; result: HealthResult }>();

export async function cachedHealth(key: string, check: () => Promise<HealthResult>): Promise<HealthResult> {
  const hit = healthCache.get(key);
  if (hit && Date.now() - hit.at < HEALTH_TTL_MS) return hit.result;
  const result = await check();
  if (result.healthy) healthCache.set(key, { at: Date.now(), result });
  else healthCache.delete(key);
  return result;
}

/** A year from an ISO date, or undefined for anything that isn't one. */
export function yearOf(date: unknown): number | undefined {
  if (typeof date !== "string") return undefined;
  const y = Number(date.slice(0, 4));
  return Number.isInteger(y) && y > 1800 ? y : undefined;
}

/** Text from a source is someone else's; keep the list payload bounded. */
export function clip(s: unknown, max = 600): string | undefined {
  if (typeof s !== "string") return undefined;
  const t = s.trim();
  if (!t) return undefined;
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

export function finite(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
