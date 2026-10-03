import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";

// Every upstream (TMDB, RAWG, Radarr, Prowlarr) is driven from the test through
// the adapters' shared HTTP client, so the exact requests TorHQ sends can be
// asserted and nothing touches the network.
const { httpJson } = vi.hoisted(() => ({ httpJson: vi.fn() }));
vi.mock("../server/src/adapters/http.js", () => ({
  httpJson,
  HttpError: class HttpError extends Error {
    constructor(message: string, readonly statusCode: number, readonly body?: string) { super(message); }
  },
  basicAuth: (s: string) => s,
}));

const { TmdbAdapter, normalizeTmdb } = await import("../server/src/adapters/tmdb.js");
const { RawgAdapter, normalizeRawg, resized, dateRange } = await import("../server/src/adapters/rawg.js");
const { QbittorrentAdapter } = await import("../server/src/adapters/qbittorrent.js");
const { ProwlarrAdapter } = await import("../server/src/adapters/prowlarr.js");
const { resetLibraryCache } = await import("../server/src/routes/catalogue.js");
const { initDb } = await import("../server/src/db/index.js");
const { runMigrations } = await import("../server/src/db/migrate.js");
const { loadEnv } = await import("../server/src/config/env.js");
const { makeContext } = await import("../server/src/lib/context.js");
const { buildApp } = await import("../server/src/app.js");

beforeEach(() => {
  httpJson.mockReset();
  httpJson.mockImplementation(async (base: unknown, path: unknown) => {
    throw new Error(`unexpected request to ${String(base)}/${String(path)}`);
  });
});

const MOVIE_ROW = {
  id: 693134, title: "Dune: Part Two", release_date: "2024-02-27",
  overview: "Paul Atreides unites with Chani.", poster_path: "/abc.jpg", backdrop_path: "/bg.jpg",
  vote_average: 8.2, vote_count: 6000, genre_ids: [878, 12],
};
const TV_ROW = { id: 95396, name: "Severance", first_air_date: "2022-02-17", vote_average: 8.4, genre_ids: [18] };

describe("TMDB adapter", () => {
  const names = new Map([["878", "Science Fiction"], ["12", "Adventure"], ["18", "Drama"]]);

  it("normalises a movie row, with Radarr's selection id", () => {
    expect(normalizeTmdb(MOVIE_ROW, "movie", names)).toMatchObject({
      kind: "movie", id: "693134", title: "Dune: Part Two", year: 2024,
      poster: "https://image.tmdb.org/t/p/w342/abc.jpg",
      backdrop: "https://image.tmdb.org/t/p/w780/bg.jpg",
      rating: 8.2, genres: ["Science Fiction", "Adventure"], selectionId: "tmdb:693134",
    });
  });

  it("normalises a TV row without guessing a selection id (Sonarr keys on TVDB)", () => {
    const item = normalizeTmdb(TV_ROW, "tv", names)!;
    expect(item).toMatchObject({ kind: "tv", title: "Severance", year: 2022, genres: ["Drama"] });
    expect(item.selectionId).toBeUndefined();
  });

  it("drops rows with no id or title", () => {
    expect(normalizeTmdb({ title: "x" }, "movie", names)).toBeNull();
    expect(normalizeTmdb({ id: 1 }, "movie", names)).toBeNull();
  });

  it("sends a v3 key as api_key and a v4 token as a bearer header", async () => {
    httpJson.mockResolvedValue({});
    await new TmdbAdapter({ baseUrl: "https://api.themoviedb.org", secret: "abc123" }).health();
    expect(httpJson.mock.calls[0]![2].query.api_key).toBe("abc123");
    expect(httpJson.mock.calls[0]![2].headers.authorization).toBeUndefined();

    httpJson.mockClear();
    await new TmdbAdapter({ baseUrl: "https://api.themoviedb.org", secret: "eyJhbGciOi.token" }).health();
    expect(httpJson.mock.calls[0]![2].headers.authorization).toBe("Bearer eyJhbGciOi.token");
    expect(httpJson.mock.calls[0]![2].query.api_key).toBeUndefined();
  });

  it("browses trending by week, and a genre through discover", async () => {
    httpJson.mockImplementation(async (_b: string, path: string) =>
      path.startsWith("3/genre/") ? { genres: [] } : { page: 1, total_pages: 900, results: [MOVIE_ROW] });
    const t = new TmdbAdapter({ baseUrl: "", secret: "k" });

    const trending = await t.browse("movie", { list: "trending" });
    expect(httpJson.mock.calls.some((c) => c[1] === "3/trending/movie/week")).toBe(true);
    // TMDB claims more pages than it will ever serve.
    expect(trending.totalPages).toBe(500);

    httpJson.mockClear();
    await t.browse("movie", { list: "top_rated", genre: "878" });
    const call = httpJson.mock.calls.find((c) => c[1] === "3/discover/movie")!;
    expect(call[2].query).toMatchObject({ with_genres: "878", sort_by: "vote_average.desc", "vote_count.gte": 200 });
  });

  it("reads a show's TVDB id from its external ids for the Get hand-off", async () => {
    httpJson.mockResolvedValue({ ...TV_ROW, genres: [{ id: 18, name: "Drama" }], number_of_seasons: 2, external_ids: { tvdb_id: 371980 } });
    const d = await new TmdbAdapter({ baseUrl: "", secret: "k" }).details("tv", "95396");
    expect(httpJson.mock.calls[0]![2].query.append_to_response).toBe("external_ids");
    expect(d).toMatchObject({ selectionId: "tvdb:371980", seasons: 2, genres: ["Drama"] });
  });
});

describe("RAWG adapter", () => {
  const GAME = {
    id: 3498, name: "Grand Theft Auto V", released: "2013-09-17",
    background_image: "https://media.rawg.io/media/games/456/abc.jpg",
    rating: 4.47, ratings_count: 7000,
    genres: [{ name: "Action" }],
    parent_platforms: [{ platform: { id: 1, name: "PC" } }, { platform: { id: 2, name: "PlayStation" } }],
  };

  it("normalises a game, rescaling its rating to ten", () => {
    expect(normalizeRawg(GAME)).toMatchObject({
      kind: "game", id: "3498", title: "Grand Theft Auto V", year: 2013,
      rating: 8.9, genres: ["Action"], platforms: ["PC", "PlayStation"],
      poster: "https://media.rawg.io/media/crop/600/400/games/456/abc.jpg",
    });
  });

  it("treats a zero rating as unrated", () => {
    expect(normalizeRawg({ ...GAME, rating: 0 })!.rating).toBeUndefined();
  });

  it("only rewrites https media URLs", () => {
    expect(resized("http://evil.example/x.jpg", 1, 1)).toBeUndefined();
    expect(resized(null, 1, 1)).toBeUndefined();
  });

  it("builds date windows relative to today", () => {
    expect(dateRange(-30, 0, new Date("2026-10-03T12:00:00Z"))).toBe("2026-09-03,2026-10-03");
    expect(RawgAdapter.listQuery("upcoming", new Date("2026-10-03T12:00:00Z")))
      .toEqual({ dates: "2026-10-04,2027-10-03", ordering: "-added" });
  });

  it("reuses a passing health check, so dashboard polling can't drain the free tier", async () => {
    httpJson.mockResolvedValue({ results: [] });
    const r = new RawgAdapter({ baseUrl: "https://api.rawg.io", secret: "HEALTHKEY" });
    expect((await r.health()).healthy).toBe(true);
    expect((await r.health()).healthy).toBe(true);
    expect(httpJson).toHaveBeenCalledTimes(1);
  });

  it("never reuses a failing one", async () => {
    httpJson.mockRejectedValue(new Error("HTTP 401"));
    const r = new RawgAdapter({ baseUrl: "https://api.rawg.io", secret: "BADKEY" });
    expect((await r.health()).healthy).toBe(false);
    await r.health();
    expect(httpJson).toHaveBeenCalledTimes(2);
  });

  it("sends the key, the genre slug and the platform filter", async () => {
    httpJson.mockResolvedValue({ count: 45, results: [GAME] });
    const page = await new RawgAdapter({ baseUrl: "https://api.rawg.io", secret: "KEY" })
      .browse({ list: "top_rated", genre: "action", platform: 1, page: 2 });
    const [, path, opts] = httpJson.mock.calls[0]!;
    expect(path).toBe("api/games");
    expect(opts.query).toMatchObject({ key: "KEY", genres: "action", parent_platforms: 1, page: 2, metacritic: "80,100" });
    expect(page).toMatchObject({ page: 2, totalPages: 3 });
  });
});

describe("catalogue routes", () => {
  let app: FastifyInstance;
  let dataDir: string;
  let cookie = "", csrf = "", memberCookie = "";
  const auth = () => ({ cookie, "x-csrf-token": csrf });

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "torhq-catalogue-"));
    const env = loadEnv({
      NODE_ENV: "test",
      TORHQ_MASTER_KEY: "test-master-key-0123456789",
      TORHQ_DATA_DIR: dataDir,
      TORHQ_APPROVED_ROOTS: dataDir,
    } as any);
    initDb(env.TORHQ_DATA_DIR);
    runMigrations();
    app = await buildApp(makeContext(env));
    await app.ready();

    const reg = await app.inject({ method: "POST", url: "/api/auth/register", payload: { username: "admin", password: "supersecret1" } });
    csrf = reg.json().csrfToken;
    cookie = reg.cookies[0]!.name + "=" + reg.cookies[0]!.value;

    await app.inject({ method: "POST", url: "/api/users", headers: auth(), payload: { username: "friend", password: "friendpass1" } });
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "friend", password: "friendpass1" } });
    memberCookie = login.cookies[0]!.name + "=" + login.cookies[0]!.value;
  });
  afterAll(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("requires a session", async () => {
    const r = await app.inject({ method: "GET", url: "/api/catalogue/sources" });
    expect(r.statusCode).toBe(401);
  });

  it("reports each kind as unavailable, with the reason, before a key is set", async () => {
    const r = await app.inject({ method: "GET", url: "/api/catalogue/sources", headers: { cookie } });
    expect(r.statusCode).toBe(200);
    const { kinds } = r.json();
    expect(kinds.movie).toMatchObject({ available: false, source: "TMDB" });
    expect(kinds.game.detail).toMatch(/RAWG/);
    expect(kinds.tv.lists).toContain("on_the_air");
  });

  it("is a 409, not a crash, browsing an unconfigured source", async () => {
    const r = await app.inject({ method: "GET", url: "/api/catalogue/browse?kind=game", headers: { cookie } });
    expect(r.statusCode).toBe(409);
  });

  describe("with TMDB, RAWG and Radarr configured", () => {
    beforeAll(async () => {
      for (const [kind, baseUrl] of [
        ["tmdb", "https://api.themoviedb.org"], ["rawg", "https://api.rawg.io"], ["radarr", "http://radarr:7878"],
      ] as const) {
        const r = await app.inject({ method: "POST", url: "/api/services", headers: auth(), payload: { kind, label: kind, baseUrl, secret: "k" } });
        expect(r.statusCode).toBe(200);
      }
    });
    beforeEach(() => {
      resetLibraryCache();
      httpJson.mockImplementation(async (base: string, path: string) => {
        if (base.startsWith("http://radarr")) return [{ id: 1, tmdbId: 693134 }];
        if (path.startsWith("3/genre/")) return { genres: [{ id: 878, name: "Science Fiction" }] };
        if (path.startsWith("3/")) return { page: 1, total_pages: 1, results: [MOVIE_ROW, { ...MOVIE_ROW, id: 1, title: "Other" }] };
        throw new Error(`unexpected ${base}${path}`);
      });
    });

    it("marks the titles Radarr already holds", async () => {
      const r = await app.inject({ method: "GET", url: "/api/catalogue/browse?kind=movie&list=popular", headers: { cookie } });
      expect(r.statusCode).toBe(200);
      const body = r.json();
      expect(body.libraryChecked).toBe(true);
      expect(body.items.map((i: any) => [i.title, i.inLibrary])).toEqual([["Dune: Part Two", true], ["Other", false]]);
      expect(body.items[0].genres).toEqual(["Science Fiction"]);
    });

    it("still lists everything when Radarr is down, just unbadged", async () => {
      httpJson.mockImplementation(async (base: string, path: string) => {
        if (base.startsWith("http://radarr")) throw new Error("ECONNREFUSED");
        if (path.startsWith("3/genre/")) return { genres: [] };
        return { page: 1, total_pages: 1, results: [MOVIE_ROW] };
      });
      const r = await app.inject({ method: "GET", url: "/api/catalogue/browse?kind=movie", headers: { cookie } });
      expect(r.statusCode).toBe(200);
      expect(r.json().libraryChecked).toBe(false);
      expect(r.json().items[0].inLibrary).toBeUndefined();
    });

    it("rejects a list the kind does not have", async () => {
      const r = await app.inject({ method: "GET", url: "/api/catalogue/browse?kind=tv&list=now_playing", headers: { cookie } });
      expect(r.statusCode).toBe(400);
      expect(r.json().error).toMatch(/list/);
    });

    it("refuses a genre that is not a plain token", async () => {
      const r = await app.inject({ method: "GET", url: "/api/catalogue/browse?kind=movie&genre=1%26api_key%3Dx", headers: { cookie } });
      expect(r.statusCode).toBe(400);
    });

    it("lets a member browse", async () => {
      const r = await app.inject({ method: "GET", url: "/api/catalogue/browse?kind=movie", headers: { cookie: memberCookie } });
      expect(r.statusCode).toBe(200);
    });

    it("surfaces the source's own reason for a failure", async () => {
      const { HttpError } = await import("../server/src/adapters/http.js");
      httpJson.mockImplementation(async () => {
        throw new (HttpError as any)("HTTP 401", 401, JSON.stringify({ status_message: "Invalid API key: You must be granted a valid key." }));
      });
      const r = await app.inject({ method: "GET", url: "/api/catalogue/browse?kind=movie&q=dune", headers: { cookie } });
      expect(r.statusCode).toBe(502);
      expect(r.json().error).toMatch(/Invalid API key/);
    });
  });

  describe("grabbing a game", () => {
    beforeAll(async () => {
      for (const [kind, baseUrl, secret] of [
        ["qbittorrent", "http://127.0.0.1:9", "u:p"], ["prowlarr", "http://prowlarr:9696", "k"],
      ] as const) {
        await app.inject({ method: "POST", url: "/api/services", headers: auth(), payload: { kind, label: kind, baseUrl, secret } });
      }
    });

    it("goes to qBittorrent under torhq-games, never through Prowlarr to an *arr", async () => {
      const add = vi.spyOn(QbittorrentAdapter.prototype, "addTorrent").mockResolvedValue();
      const grab = vi.spyOn(ProwlarrAdapter.prototype, "grab").mockResolvedValue(undefined as never);
      const magnet = "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567";
      const r = await app.inject({
        method: "POST", url: "/api/search/grab", headers: auth(),
        payload: { source: "prowlarr", guid: "g", indexerId: 3, magnet, title: "Some.Game-GRP", target: "games" },
      });
      expect(r.statusCode).toBe(200);
      expect(r.json()).toMatchObject({ via: "qbittorrent", category: "torhq-games", importTriggered: false });
      expect(add).toHaveBeenCalledWith({ url: magnet, category: "torhq-games" });
      expect(grab).not.toHaveBeenCalled();
      add.mockRestore();
      grab.mockRestore();
    });
  });
});
