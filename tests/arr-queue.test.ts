import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the adapter HTTP client so we can drive Radarr/Sonarr/Lidarr queue
// responses and assert exactly what TorHQ would send — no network.
const { httpJson } = vi.hoisted(() => ({ httpJson: vi.fn() }));
vi.mock("../server/src/adapters/http.js", () => ({
  httpJson,
  HttpError: class HttpError extends Error {},
  basicAuth: (s: string) => s,
}));

const { ArrAdapter } = await import("../server/src/adapters/arr.js");

const cfg = { baseUrl: "http://arr.local", secret: "APIKEY" };

beforeEach(() => httpJson.mockReset());

/** The most recent call's [base, path, opts] triple. */
const lastCall = () => httpJson.mock.calls.at(-1)!;

describe("ArrAdapter.queue", () => {
  it("asks each flavor for unknown items using that flavor's own parameter names", async () => {
    httpJson.mockResolvedValue({ records: [] });

    await new ArrAdapter("radarr", cfg).queue();
    expect(lastCall()[1]).toBe("/api/v3/queue");
    expect(lastCall()[2].query).toMatchObject({ includeUnknownMovieItems: true, includeMovie: true });

    await new ArrAdapter("sonarr", cfg).queue();
    expect(lastCall()[1]).toBe("/api/v3/queue");
    expect(lastCall()[2].query).toMatchObject({ includeUnknownSeriesItems: true, includeEpisode: true });

    await new ArrAdapter("lidarr", cfg).queue();
    expect(lastCall()[1]).toBe("/api/v1/queue"); // Lidarr is v1, not v3
    expect(lastCall()[2].query).toMatchObject({ includeUnknownArtistItems: true, includeAlbum: true });
  });

  it("normalizes a record, keeping the tracked-download fields imports fail on", async () => {
    httpJson.mockResolvedValue({
      records: [{
        id: 12, title: "Blade Runner 2049 2160p", status: "completed",
        trackedDownloadStatus: "warning", trackedDownloadState: "importPending",
        errorMessage: "", size: 8589934592, sizeleft: 0,
        downloadId: "0123456789ABCDEF0123456789ABCDEF01234567",
        outputPath: "/downloads/radarr/Blade Runner 2049",
        added: "2026-07-24T10:00:00Z",
        statusMessages: [
          { title: "Blade.Runner.2049.mkv", messages: ["No files found are eligible for import"] },
          { title: "Sample.mkv", messages: [] },
        ],
      }],
    });
    const [item] = await new ArrAdapter("radarr", cfg).queue();
    expect(item).toEqual({
      service: "radarr", id: 12, title: "Blade Runner 2049 2160p", status: "completed",
      trackedDownloadStatus: "warning", trackedDownloadState: "importPending",
      errorMessage: undefined,
      statusMessages: ["No files found are eligible for import", "Sample.mkv"],
      size: 8589934592, sizeleft: 0,
      downloadId: "0123456789ABCDEF0123456789ABCDEF01234567",
      outputPath: "/downloads/radarr/Blade Runner 2049",
      added: "2026-07-24T10:00:00Z",
    });
  });

  it("accepts the bare-array response older builds return, and falls back for the title", async () => {
    httpJson.mockResolvedValue([{ id: 1, series: { title: "Some Show" } }]);
    const [item] = await new ArrAdapter("sonarr", cfg).queue();
    expect(item!.title).toBe("Some Show");
    expect(item!.status).toBe("unknown");
    expect(item!.statusMessages).toEqual([]);
  });
});

describe("ArrAdapter.removeFromQueue", () => {
  it("DELETEs the record with both removal switches", async () => {
    httpJson.mockResolvedValue(undefined);
    await new ArrAdapter("radarr", cfg).removeFromQueue(12, { removeFromClient: true, blocklist: false });
    const [, path, opts] = lastCall();
    expect(path).toBe("/api/v3/queue/12");
    expect(opts.method).toBe("DELETE");
    expect(opts.query.removeFromClient).toBe(true);
    // Sent under both spellings so one call works across *arr generations.
    expect(opts.query.blocklist).toBe(false);
    expect(opts.query.blacklist).toBe(false);
  });
});

describe("ArrAdapter.downloadClients", () => {
  it("flattens the field array into a plain object", async () => {
    httpJson.mockResolvedValue([{
      id: 1, name: "qBittorrent", implementation: "QBittorrent", enable: true,
      fields: [{ name: "host", value: "qbittorrent" }, { name: "category", value: "radarr" }],
    }]);
    const [client] = await new ArrAdapter("radarr", cfg).downloadClients();
    expect(lastCall()[1]).toBe("/api/v3/downloadclient");
    expect(client).toEqual({
      id: 1, name: "qBittorrent", implementation: "QBittorrent", enable: true,
      fields: { host: "qbittorrent", category: "radarr" },
    });
  });

  it("reads download handling from config/downloadclient", async () => {
    httpJson.mockResolvedValue({ enableCompletedDownloadHandling: true });
    const cfgRes = await new ArrAdapter("lidarr", cfg).downloadClientConfig();
    expect(lastCall()[1]).toBe("/api/v1/config/downloadclient");
    expect(cfgRes.enableCompletedDownloadHandling).toBe(true);
  });
});

describe("ArrAdapter.rescanDownload", () => {
  it("points the *arr's own scanner at the download's output path", async () => {
    httpJson.mockResolvedValue({ id: 1 });
    const res = await new ArrAdapter("radarr", cfg).rescanDownload({
      outputPath: "/downloads/radarr/Blade Runner 2049", downloadId: "ABC",
    });
    expect(res.command).toBe("DownloadedMoviesScan");
    const [, path, opts] = lastCall();
    expect(path).toBe("/api/v3/command");
    expect(opts.body).toEqual({
      name: "DownloadedMoviesScan",
      path: "/downloads/radarr/Blade Runner 2049",
      downloadClientId: "ABC",
    });
    // No importMode: the *arr's configured copy/hardlink behaviour stays in charge.
    expect(opts.body).not.toHaveProperty("importMode");
  });

  it("uses each flavor's scan command", async () => {
    httpJson.mockResolvedValue({});
    await new ArrAdapter("sonarr", cfg).rescanDownload({ outputPath: "/downloads/sonarr/x" });
    expect(lastCall()[2].body.name).toBe("DownloadedEpisodesScan");
    await new ArrAdapter("lidarr", cfg).rescanDownload({ outputPath: "/downloads/lidarr/x" });
    expect(lastCall()[2].body.name).toBe("DownloadedAlbumsScan");
  });

  it("falls back to a full refresh when there is no output path to scan", async () => {
    httpJson.mockResolvedValue({});
    const res = await new ArrAdapter("radarr", cfg).rescanDownload({ downloadId: "ABC" });
    expect(res.command).toBe("RefreshMonitoredDownloads");
    expect(lastCall()[2].body).toEqual({ name: "RefreshMonitoredDownloads" });
  });
});
