import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the adapter HTTP client so we can drive Radarr/Sonarr/Lidarr responses
// and assert exactly what TorHQ would send — no network.
const { httpJson } = vi.hoisted(() => ({ httpJson: vi.fn() }));
vi.mock("../server/src/adapters/http.js", () => ({
  httpJson,
  HttpError: class HttpError extends Error {},
  basicAuth: (s: string) => s,
}));

const { ArrAdapter } = await import("../server/src/adapters/arr.js");

const cfg = { baseUrl: "http://arr.local", secret: "APIKEY" };

beforeEach(() => httpJson.mockReset());

describe("ArrAdapter API versioning", () => {
  it("Radarr/Sonarr use /api/v3 and Lidarr uses /api/v1", async () => {
    httpJson.mockResolvedValue({ version: "1.0" });
    await new ArrAdapter("radarr", cfg).health();
    await new ArrAdapter("sonarr", cfg).health();
    await new ArrAdapter("lidarr", cfg).health();
    const paths = httpJson.mock.calls.map((c) => c[1]);
    expect(paths[0]).toBe("/api/v3/system/status");
    expect(paths[1]).toBe("/api/v3/system/status");
    expect(paths[2]).toBe("/api/v1/system/status"); // Lidarr is v1, not v3
  });
});

describe("searchCandidates", () => {
  it("normalizes Radarr lookups and drops entries without a stable selector", async () => {
    httpJson.mockResolvedValue([
      { title: "Blade Runner 2049", year: 2017, tmdbId: 335984, images: [{ coverType: "poster", remoteUrl: "u" }] },
      { title: "No Id Here" }, // no tmdbId -> dropped
    ]);
    const cands = await new ArrAdapter("radarr", cfg).searchCandidates("blade runner");
    expect(cands).toHaveLength(1);
    expect(cands[0].selectionId).toBe("tmdb:335984");
    expect(cands[0].poster).toBe("u");
    expect(cands[0].alreadyAdded).toBe(false);
  });

  it("marks results already in the library", async () => {
    httpJson.mockResolvedValue([{ title: "Existing", tvdbId: 42, id: 7 }]);
    const cands = await new ArrAdapter("sonarr", cfg).searchCandidates("existing");
    expect(cands[0].selectionId).toBe("tvdb:42");
    expect(cands[0].alreadyAdded).toBe(true);
  });
});

describe("addSelected never adds the first hit", () => {
  it("re-looks-up and posts exactly the chosen candidate", async () => {
    const lookup = [
      { title: "Wrong One", year: 1999, tmdbId: 111 },
      { title: "Right One", year: 2017, tmdbId: 335984 },
    ];
    httpJson.mockImplementation(async (...args: any[]) => {
      const [, path, opts] = args;
      if (String(path).endsWith("/lookup")) return lookup;
      if (opts?.method === "POST") return { id: 500, title: "Right One" };
      return {};
    });

    const created = await new ArrAdapter("radarr", cfg).addSelected({
      term: "x", selectionId: "tmdb:335984", qualityProfileId: 3, rootFolderPath: "/movies",
    });
    expect(created).toEqual({ id: 500, title: "Right One" });

    const post = httpJson.mock.calls.find((c) => c[2]?.method === "POST")!;
    expect(post[1]).toBe("/api/v3/movie");
    const body = post[2].body;
    expect(body.tmdbId).toBe(335984); // the SELECTED one, not the first (111)
    expect(body.qualityProfileId).toBe(3);
    expect(body.rootFolderPath).toBe("/movies");
    expect(body.addOptions).toEqual({ searchForMovie: true });
  });

  it("throws when the selection is no longer in the lookup", async () => {
    httpJson.mockResolvedValue([{ title: "Only", tmdbId: 1 }]);
    await expect(new ArrAdapter("radarr", cfg).addSelected({
      term: "x", selectionId: "tmdb:999", qualityProfileId: 1, rootFolderPath: "/m",
    })).rejects.toThrow(/no longer available/);
  });

  it("does not re-add a candidate already in the library", async () => {
    httpJson.mockResolvedValue([{ title: "Have It", tmdbId: 5, id: 99 }]);
    const created = await new ArrAdapter("radarr", cfg).addSelected({
      term: "x", selectionId: "tmdb:5", qualityProfileId: 1, rootFolderPath: "/m",
    });
    expect(created.id).toBe(99);
    // No POST was made.
    expect(httpJson.mock.calls.some((c) => c[2]?.method === "POST")).toBe(false);
  });
});

describe("processDownloads closes the import loop", () => {
  it("POSTs RefreshMonitoredDownloads to the *arr command endpoint", async () => {
    httpJson.mockResolvedValue({ id: 1 });
    await new ArrAdapter("radarr", cfg).processDownloads();
    const call = httpJson.mock.calls.find((c) => String(c[1]).endsWith("/command"))!;
    expect(call[1]).toBe("/api/v3/command");
    expect(call[2].method).toBe("POST");
    expect(call[2].body).toEqual({ name: "RefreshMonitoredDownloads" });
  });
  it("uses the Sonarr/Lidarr API versions too", async () => {
    httpJson.mockResolvedValue({});
    await new ArrAdapter("lidarr", cfg).processDownloads();
    expect(httpJson.mock.calls.at(-1)![1]).toBe("/api/v1/command");
  });
});

describe("Lidarr flavor-specific add", () => {
  it("requires a metadataProfileId", async () => {
    httpJson.mockResolvedValue([{ artistName: "Radiohead", foreignArtistId: "mbid-1" }]);
    await expect(new ArrAdapter("lidarr", cfg).addSelected({
      term: "radiohead", selectionId: "mbid:mbid-1", qualityProfileId: 1, rootFolderPath: "/music",
    })).rejects.toThrow(/metadataProfileId/);
  });

  it("posts to /api/v1/artist with metadataProfileId and album monitoring", async () => {
    httpJson.mockImplementation(async (...args: any[]) => {
      const [, path, opts] = args;
      if (String(path).endsWith("/lookup")) return [{ artistName: "Radiohead", foreignArtistId: "mbid-1" }];
      if (opts?.method === "POST") return { id: 12, artistName: "Radiohead" };
      return {};
    });
    const created = await new ArrAdapter("lidarr", cfg).addSelected({
      term: "radiohead", selectionId: "mbid:mbid-1", qualityProfileId: 1, metadataProfileId: 4, rootFolderPath: "/music",
    });
    expect(created).toEqual({ id: 12, title: "Radiohead" });
    const post = httpJson.mock.calls.find((c) => c[2]?.method === "POST")!;
    expect(post[1]).toBe("/api/v1/artist");
    expect(post[2].body.metadataProfileId).toBe(4);
    expect(post[2].body.addOptions).toEqual({ monitor: "all", searchForMissingAlbums: true });
  });

  it("returns metadata profiles only for Lidarr", async () => {
    httpJson.mockResolvedValue([{ id: 1, name: "Standard" }]);
    expect(await new ArrAdapter("lidarr", cfg).metadataProfiles()).toHaveLength(1);
    httpJson.mockClear();
    expect(await new ArrAdapter("radarr", cfg).metadataProfiles()).toEqual([]);
    expect(httpJson).not.toHaveBeenCalled(); // no request for non-Lidarr
  });
});
