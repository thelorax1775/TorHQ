import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getAdapter } from "../adapters/registry.js";
import type { ArrAdapter } from "../adapters/arr.js";
import { TmdbAdapter, tmdbMessage } from "../adapters/tmdb.js";
import { RawgAdapter, RAWG_PLATFORMS, rawgMessage } from "../adapters/rawg.js";
import {
  CATALOGUE_LISTS, type CatalogueItem, type CatalogueKind, type CatalogueList,
} from "../adapters/catalogue.js";
import type { AppContext } from "../lib/context.js";

/**
 * Catalogue — browse what exists, rather than search for what you already know.
 *
 * Film and TV come from TMDB, games from RAWG. This route family only *reads*:
 * it lists, filters and describes titles, and marks the ones Radarr or Sonarr
 * already hold. Getting something is the job of the existing flows, which the
 * page links into:
 *
 *   movie / tv -> Get (admin) or Requests (member): the *arr adds it, grabs it,
 *                 imports it, files it. Exactly as if it had been typed in.
 *   game       -> Raw search over Prowlarr's game categories, grabbed into
 *                 qBittorrent under `torhq-games`. No *arr exists for games, so
 *                 nothing imports them: that boundary is stated, not hidden.
 *
 * Browsing is open to members as well as the admin. It reveals nothing a member
 * cannot already see through Requests, and it is how a friend finds something
 * to ask for.
 */

const KINDS = ["movie", "tv", "game"] as const;
const ALL_LISTS = [...new Set(Object.values(CATALOGUE_LISTS).flat())] as [CatalogueList, ...CatalogueList[]];

const BrowseQuery = z.object({
  kind: z.enum(KINDS),
  list: z.enum(ALL_LISTS).optional(),
  q: z.string().trim().min(1).max(256).optional(),
  // A TMDB genre id or a RAWG slug. Either way a short token, nothing more.
  genre: z.string().max(64).regex(/^[a-z0-9-]+$/i).optional(),
  platform: z.coerce.number().int().positive().optional(),
  page: z.coerce.number().int().min(1).max(500).optional(),
}).superRefine((b, ctx) => {
  if (b.list && !(CATALOGUE_LISTS[b.kind] as readonly string[]).includes(b.list)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom, path: ["list"],
      message: `${b.kind} has no "${b.list}" list (expected ${CATALOGUE_LISTS[b.kind].join(", ")})`,
    });
  }
});

const KindQuery = z.object({ kind: z.enum(KINDS) });
const DetailQuery = z.object({ kind: z.enum(KINDS), id: z.string().regex(/^\d{1,12}$/, "expected a numeric id") });

/** Which *arr owns a kind, for the "in library" badge. Games have none. */
const OWNER = { movie: "radarr", tv: "sonarr" } as const;

/**
 * Library contents change rarely and are expensive to fetch whole, while a
 * browse fires one request per page turn. A short cache keeps paging snappy
 * without a just-added title staying unbadged for long.
 */
const LIBRARY_TTL_MS = 60_000;
const libraryCache = new Map<string, { at: number; ids: Set<number> }>();

/** Test hook: forget cached library contents. */
export function resetLibraryCache(): void {
  libraryCache.clear();
}

export function catalogueRoutes(app: FastifyInstance, ctx: AppContext): void {
  const read = { preHandler: app.requireAuth };

  const tmdb = () => getAdapter("tmdb", ctx.masterKey) as TmdbAdapter | null;
  const rawg = () => getAdapter("rawg", ctx.masterKey) as RawgAdapter | null;

  /** Where each kind comes from, or why it can't be browsed yet. */
  function sourceFor(kind: CatalogueKind) {
    if (kind === "game") {
      return rawg()
        ? { available: true, source: "RAWG" }
        : { available: false, source: "RAWG", detail: "Add a RAWG API key under Services to browse games." };
    }
    return tmdb()
      ? { available: true, source: "TMDB" }
      : { available: false, source: "TMDB", detail: "Add a TMDB API key under Services to browse movies and TV." };
  }

  /**
   * TMDB ids the owning *arr already holds, or null when that can't be told —
   * not configured, or down. Null leaves items unbadged rather than claiming
   * they are missing.
   */
  async function libraryIds(kind: CatalogueKind): Promise<Set<number> | null> {
    if (kind === "game") return null;
    const service = OWNER[kind];
    const hit = libraryCache.get(service);
    if (hit && Date.now() - hit.at < LIBRARY_TTL_MS) return hit.ids;
    const arr = getAdapter(service, ctx.masterKey) as ArrAdapter | null;
    if (!arr) return null;
    try {
      const ids = await arr.libraryTmdbIds();
      libraryCache.set(service, { at: Date.now(), ids });
      return ids;
    } catch {
      return null;
    }
  }

  function markLibrary(items: CatalogueItem[], ids: Set<number> | null): void {
    if (!ids) return;
    for (const item of items) item.inLibrary = ids.has(Number(item.id));
  }

  app.get("/api/catalogue/sources", read, async () => ({
    kinds: Object.fromEntries(KINDS.map((k) => [k, { ...sourceFor(k), lists: CATALOGUE_LISTS[k] }])),
    platforms: RAWG_PLATFORMS,
  }));

  app.get("/api/catalogue/genres", read, async (req, reply) => {
    const { kind } = KindQuery.parse(req.query);
    try {
      if (kind === "game") {
        const r = rawg();
        if (!r) return reply.code(409).send({ error: sourceFor(kind).detail });
        return { genres: await r.genres() };
      }
      const t = tmdb();
      if (!t) return reply.code(409).send({ error: sourceFor(kind).detail });
      return { genres: await t.genres(kind) };
    } catch (e) {
      return reply.code(502).send({ error: kind === "game" ? rawgMessage(e) : tmdbMessage(e) });
    }
  });

  /**
   * One page of a list, or of a search when `q` is given. A search ignores the
   * list and genre (neither source can combine them), but a game search keeps
   * its platform filter, which RAWG does honour.
   */
  app.get("/api/catalogue/browse", read, async (req, reply) => {
    const query = BrowseQuery.parse(req.query);
    const { kind } = query;
    const page = query.page ?? 1;

    if (kind === "game") {
      const r = rawg();
      if (!r) return reply.code(409).send({ error: sourceFor(kind).detail });
      try {
        const result = query.q
          ? await r.search(query.q, page, query.platform)
          : await r.browse({ list: query.list, genre: query.genre, platform: query.platform, page });
        return { kind, ...result, libraryChecked: false };
      } catch (e) {
        return reply.code(502).send({ error: rawgMessage(e) });
      }
    }

    const t = tmdb();
    if (!t) return reply.code(409).send({ error: sourceFor(kind).detail });
    try {
      const [result, ids] = await Promise.all([
        query.q ? t.search(kind, query.q, page) : t.browse(kind, { list: query.list, genre: query.genre, page }),
        libraryIds(kind),
      ]);
      markLibrary(result.items, ids);
      return { kind, ...result, libraryChecked: ids !== null };
    } catch (e) {
      return reply.code(502).send({ error: tmdbMessage(e) });
    }
  });

  /** Everything the detail panel shows, including a show's TVDB selection id. */
  app.get("/api/catalogue/details", read, async (req, reply) => {
    const { kind, id } = DetailQuery.parse(req.query);
    if (kind === "game") {
      const r = rawg();
      if (!r) return reply.code(409).send({ error: sourceFor(kind).detail });
      try {
        return { item: await r.details(id) };
      } catch (e) {
        return reply.code(502).send({ error: rawgMessage(e) });
      }
    }
    const t = tmdb();
    if (!t) return reply.code(409).send({ error: sourceFor(kind).detail });
    try {
      const [item, ids] = await Promise.all([t.details(kind, id), libraryIds(kind)]);
      markLibrary([item], ids);
      return { item };
    } catch (e) {
      return reply.code(502).send({ error: tmdbMessage(e) });
    }
  });
}
