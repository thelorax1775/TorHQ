import { describe, it, expect } from "vitest";
import { redactUrl } from "../server/src/adapters/http.js";
import { tmdbBase, TMDB_DEFAULT_BASE } from "../server/src/adapters/tmdb.js";

describe("tmdbBase", () => {
  it("maps the website URL people paste to the API host", () => {
    expect(tmdbBase("https://www.themoviedb.org")).toBe(TMDB_DEFAULT_BASE);
    expect(tmdbBase("https://themoviedb.org/")).toBe(TMDB_DEFAULT_BASE);
    expect(tmdbBase("https://WWW.TheMovieDB.org/settings/api")).toBe(TMDB_DEFAULT_BASE);
  });

  it("falls back to the API host when nothing usable is configured", () => {
    expect(tmdbBase(undefined)).toBe(TMDB_DEFAULT_BASE);
    expect(tmdbBase("  ")).toBe(TMDB_DEFAULT_BASE);
    expect(tmdbBase("not a url")).toBe(TMDB_DEFAULT_BASE);
  });

  it("leaves the API host and custom proxies alone", () => {
    expect(tmdbBase("https://api.themoviedb.org")).toBe("https://api.themoviedb.org");
    expect(tmdbBase("http://tmdb-proxy.lan:8080")).toBe("http://tmdb-proxy.lan:8080");
  });
});

describe("redactUrl", () => {
  it("masks credential query values and keeps everything else", () => {
    const out = redactUrl("https://api.themoviedb.org/3/trending/movie/week?page=1&api_key=c0ffee1234");
    expect(out).not.toContain("c0ffee1234");
    expect(out).toContain("api_key=REDACTED");
    expect(out).toContain("page=1");
    expect(out).toContain("/3/trending/movie/week");
  });

  it("covers the other parameter names adapters use", () => {
    const out = redactUrl("http://x/a?apikey=s1&key=s2&token=s3&access_token=s4&password=s5&q=dune");
    for (const s of ["s1", "s2", "s3", "s4", "s5"]) expect(out).not.toContain(`=${s}`);
    expect(out).toContain("q=dune");
  });

  it("leaves a URL without credentials unchanged", () => {
    expect(redactUrl("https://api.rawg.io/api/games?page=2")).toBe("https://api.rawg.io/api/games?page=2");
  });
});
