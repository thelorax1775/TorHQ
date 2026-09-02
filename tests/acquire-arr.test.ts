import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the adapter HTTP client so each *arr's responses are driven from the test
// and the exact request TorHQ would send can be asserted — no network.
const { httpJson } = vi.hoisted(() => ({ httpJson: vi.fn() }));
vi.mock("../server/src/adapters/http.js", () => ({
  httpJson,
  HttpError: class HttpError extends Error {
    constructor(message: string, readonly statusCode: number, readonly body?: string) { super(message); }
  },
  basicAuth: (s: string) => s,
}));

const { ArrAdapter } = await import("../server/src/adapters/arr.js");

const cfg = { baseUrl: "http://radarr:7878", secret: "RADARRKEY" };

/**
 * Structurally faithful Radarr v3 release resources, trimmed from a real
 * `GET /api/v3/release?movieId=244` against Radarr 6.3.0.
 */
const RADARR_RELEASES = [
  {
    guid: "magnet:?xt=urn:btih:AAAA1111",
    indexerId: 2, indexer: "The Pirate Bay (Prowlarr)",
    title: "Avengers.Endgame.2019.1080p.BluRay.x264",
    size: 12884901888, seeders: 158, leechers: 4,
    protocol: "torrent", ageHours: 51.2,
    quality: { quality: { id: 7, name: "Bluray-1080p" } },
    rejected: false, rejections: [],
    infoUrl: "https://tpb.example/details/1",
  },
  {
    guid: "magnet:?xt=urn:btih:BBBB2222",
    indexerId: 2, indexer: "The Pirate Bay (Prowlarr)",
    title: "Avengers.Endgame.2019.UHD.BluRay.2160p.HEVC",
    size: 64368595016, seeders: 34, leechers: 1,
    protocol: "torrent",
    quality: { quality: { id: 19, name: "Bluray-2160p" } },
    rejected: true,
    rejections: ["BR-DISK is not wanted in profile", "Existing file meets cutoff: HDTV-720p []"],
  },
  {
    // Usenet: no seeder count at all. Must stay unknown, never become 0.
    guid: "urn:usenet:cccc",
    indexerId: 9, indexer: "Newz",
    title: "Avengers.Endgame.2019.1080p.WEB",
    size: 9663676416,
    protocol: "usenet",
    quality: { quality: { id: 3, name: "WEBDL-1080p" } },
    rejected: false, rejections: [],
  },
];

beforeEach(() => httpJson.mockReset());

describe("ArrAdapter.releases — the *arr's own interactive search", () => {
  it("asks Radarr for a movie's releases and normalizes them", async () => {
    httpJson.mockResolvedValueOnce(RADARR_RELEASES);
    const a = new ArrAdapter("radarr", cfg);
    const out = await a.releases({ id: 244 });

    const [base, path, opts] = httpJson.mock.calls[0];
    expect(base).toBe("http://radarr:7878");
    expect(path).toBe("/api/v3/release");
    expect(opts.query).toEqual({ movieId: 244 });
    expect(opts.headers).toEqual({ "X-Api-Key": "RADARRKEY" });

    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({
      guid: "magnet:?xt=urn:btih:AAAA1111",
      indexerId: 2,
      indexer: "The Pirate Bay (Prowlarr)",
      quality: "Bluray-1080p",
      rejected: false,
      seeders: 158,
    });
  });

  it("gives the interactive search a timeout long enough to actually finish", async () => {
    // The live call against a real stack took over a minute for 111 results;
    // the 8s adapter default would have failed every time.
    httpJson.mockResolvedValueOnce([]);
    await new ArrAdapter("radarr", cfg).releases({ id: 1 });
    expect(httpJson.mock.calls[0][2].timeoutMs).toBeGreaterThanOrEqual(120_000);
  });

  it("keeps an absent seeder count as null rather than zero", async () => {
    httpJson.mockResolvedValueOnce(RADARR_RELEASES);
    const out = await new ArrAdapter("radarr", cfg).releases({ id: 244 });
    expect(out[2].seeders).toBeNull();
    expect(out[2].leechers).toBeNull();
  });

  it("carries the *arr's own rejection reasons through verbatim", async () => {
    httpJson.mockResolvedValueOnce(RADARR_RELEASES);
    const out = await new ArrAdapter("radarr", cfg).releases({ id: 244 });
    expect(out[1].rejected).toBe(true);
    expect(out[1].rejections).toEqual([
      "BR-DISK is not wanted in profile",
      "Existing file meets cutoff: HDTV-720p []",
    ]);
  });

  it("flattens Sonarr/Lidarr's object-shaped rejections to their reasons", async () => {
    // Sonarr returns [{ reason, type }] where Radarr returns plain strings.
    httpJson.mockResolvedValueOnce([{
      guid: "g", indexerId: 1, indexer: "ix", title: "t", size: 1, protocol: "torrent",
      rejected: true, rejections: [{ reason: "Not a custom format upgrade", type: "permanent" }],
    }]);
    const out = await new ArrAdapter("sonarr", cfg).releases({ id: 5, seasonNumber: 2 });
    expect(out[0].rejections).toEqual(["Not a custom format upgrade"]);
  });

  it("infers `rejected` from the reason list on builds that omit the flag", async () => {
    httpJson.mockResolvedValueOnce([{
      guid: "g", indexerId: 1, indexer: "ix", title: "t", size: 1, protocol: "torrent",
      rejections: ["too big"],
    }]);
    const out = await new ArrAdapter("radarr", cfg).releases({ id: 1 });
    expect(out[0].rejected).toBe(true);
  });
});

describe("ArrAdapter.releases — per-flavor query shapes", () => {
  it("sends Sonarr a series + season, which is the only thing it accepts", async () => {
    httpJson.mockResolvedValueOnce([]);
    await new ArrAdapter("sonarr", { ...cfg, baseUrl: "http://sonarr:8989" }).releases({ id: 12, seasonNumber: 3 });
    expect(httpJson.mock.calls[0][1]).toBe("/api/v3/release");
    expect(httpJson.mock.calls[0][2].query).toEqual({ seriesId: 12, seasonNumber: 3 });
  });

  it("refuses a Sonarr search with no season instead of asking for the whole series", async () => {
    // Sonarr answers a seriesId-only search with an error; failing here gives
    // the user a sentence they can act on rather than an opaque 500.
    const a = new ArrAdapter("sonarr", cfg);
    await expect(a.releases({ id: 12 })).rejects.toThrow(/season at a time/i);
    expect(httpJson).not.toHaveBeenCalled();
  });

  it("searches a Lidarr album when given one, and the artist otherwise", async () => {
    const a = new ArrAdapter("lidarr", { ...cfg, baseUrl: "http://lidarr:8686" });
    httpJson.mockResolvedValueOnce([]);
    await a.releases({ id: 7, albumId: 99 });
    expect(httpJson.mock.calls[0][1]).toBe("/api/v1/release"); // Lidarr is v1
    expect(httpJson.mock.calls[0][2].query).toEqual({ albumId: 99 });

    httpJson.mockResolvedValueOnce([]);
    await a.releases({ id: 7 });
    expect(httpJson.mock.calls[1][2].query).toEqual({ artistId: 7 });
  });
});

describe("ArrAdapter.grabRelease", () => {
  it("posts the guid and indexer back to the *arr so the *arr owns the download", async () => {
    httpJson.mockResolvedValueOnce({});
    await new ArrAdapter("radarr", cfg).grabRelease("magnet:?xt=urn:btih:AAAA1111", 2);
    const [, path, opts] = httpJson.mock.calls[0];
    expect(path).toBe("/api/v3/release");
    expect(opts.method).toBe("POST");
    expect(opts.body).toEqual({ guid: "magnet:?xt=urn:btih:AAAA1111", indexerId: 2 });
  });

  it("uses Lidarr's v1 path", async () => {
    httpJson.mockResolvedValueOnce({});
    await new ArrAdapter("lidarr", cfg).grabRelease("g", 3);
    expect(httpJson.mock.calls[0][1]).toBe("/api/v1/release");
  });
});

describe("ArrAdapter.seasons / .albums", () => {
  it("reads a series' seasons with their file counts", async () => {
    httpJson.mockResolvedValueOnce({
      seasons: [
        { seasonNumber: 0, monitored: false, statistics: { episodeFileCount: 0, totalEpisodeCount: 3 } },
        { seasonNumber: 1, monitored: true, statistics: { episodeFileCount: 8, totalEpisodeCount: 10 } },
      ],
    });
    const out = await new ArrAdapter("sonarr", cfg).seasons(12);
    expect(httpJson.mock.calls[0][1]).toBe("/api/v3/series/12");
    expect(out).toEqual([
      { seasonNumber: 0, monitored: false, episodeFileCount: 0, totalEpisodeCount: 3 },
      { seasonNumber: 1, monitored: true, episodeFileCount: 8, totalEpisodeCount: 10 },
    ]);
  });

  it("survives a series with no statistics block", async () => {
    httpJson.mockResolvedValueOnce({ seasons: [{ seasonNumber: 1, monitored: true }] });
    const out = await new ArrAdapter("sonarr", cfg).seasons(12);
    expect(out[0]).toEqual({
      seasonNumber: 1, monitored: true, episodeFileCount: undefined, totalEpisodeCount: undefined,
    });
  });

  it("reads an artist's albums and derives the year from the release date", async () => {
    httpJson.mockResolvedValueOnce([
      { id: 3, title: "Kid A", monitored: true, releaseDate: "2000-10-02T00:00:00Z" },
      { id: 4, title: "Untitled", monitored: false },
    ]);
    const out = await new ArrAdapter("lidarr", cfg).albums(7);
    expect(httpJson.mock.calls[0][1]).toBe("/api/v1/album");
    expect(httpJson.mock.calls[0][2].query).toEqual({ artistId: 7 });
    expect(out).toEqual([
      { id: 3, title: "Kid A", year: 2000, monitored: true },
      { id: 4, title: "Untitled", year: undefined, monitored: false },
    ]);
  });

  it("returns nothing for the flavors that have no such concept", async () => {
    expect(await new ArrAdapter("radarr", cfg).seasons(1)).toEqual([]);
    expect(await new ArrAdapter("radarr", cfg).albums(1)).toEqual([]);
    expect(await new ArrAdapter("sonarr", cfg).albums(1)).toEqual([]);
    expect(httpJson).not.toHaveBeenCalled();
  });
});
