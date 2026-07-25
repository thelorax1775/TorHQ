import { httpJson } from "./http.js";
import type { AdapterConfig, ArrActivity, ArrCandidate, ArrItem, HealthResult, ServiceAdapter } from "./types.js";

/**
 * Radarr/Sonarr/Lidarr adapter. Radarr and Sonarr speak the *arr **v3** API;
 * Lidarr speaks **v1** with a different add surface (it requires a
 * metadataProfileId and monitors albums, not episodes). This adapter keeps
 * those differences explicit rather than pretending all three are identical.
 *
 * FUNCTIONAL: health, wanted/missing, history, search-candidates, add-selected,
 * the download queue, and download-client configuration. TorHQ only *requests*:
 * the *arr owns search, grab, import, rename, and final placement — TorHQ never
 * touches its files.
 */
export type ArrFlavor = "radarr" | "sonarr" | "lidarr";

const API_VERSION: Record<ArrFlavor, string> = { radarr: "v3", sonarr: "v3", lidarr: "v1" };
/** Primary resource noun used for lookup + add. */
const RESOURCE: Record<ArrFlavor, string> = { radarr: "movie", sonarr: "series", lidarr: "artist" };

/**
 * Queue query parameters differ per flavor: each *arr names the "include the
 * items I can't match to a library entry" flag after its own primary resource,
 * and unknown items are exactly the ones a broken pipeline leaves behind — so
 * they must be asked for explicitly.
 */
const QUEUE_PARAMS: Record<ArrFlavor, Record<string, boolean>> = {
  radarr: { includeUnknownMovieItems: true, includeMovie: true },
  sonarr: { includeUnknownSeriesItems: true, includeSeries: true, includeEpisode: true },
  lidarr: { includeUnknownArtistItems: true, includeArtist: true, includeAlbum: true },
};

/**
 * "Scan this completed download folder now" — the flavor-specific command. The
 * *arr does the moving/renaming; TorHQ only asks.
 */
const SCAN_COMMAND: Record<ArrFlavor, string> = {
  radarr: "DownloadedMoviesScan",
  sonarr: "DownloadedEpisodesScan",
  lidarr: "DownloadedAlbumsScan",
};

/** One *arr queue record, normalized across the three flavors. */
export interface ArrQueueItem {
  service: ArrFlavor;
  id: number;
  title: string;
  status: string;
  /** ok | warning | error — the *arr's own verdict on the download. */
  trackedDownloadStatus?: string;
  /** downloading | importPending | importBlocked | imported | failed | … */
  trackedDownloadState?: string;
  errorMessage?: string;
  /** Flattened `statusMessages[].messages`; where import failures actually say why. */
  statusMessages: string[];
  size: number;
  sizeleft: number;
  /** The download client's id for this grab — a torrent hash for qBittorrent. */
  downloadId?: string;
  /** Where the download client put the data, as the *arr sees it. */
  outputPath?: string;
  /** ISO timestamp; absent on older *arr builds. */
  added?: string;
}

/** A download-client path as the *arr sees it vs. as the client reports it. */
export interface RemotePathMapping {
  id: number;
  host: string;
  remotePath: string;
  localPath: string;
}

/** A download client as configured inside an *arr. */
export interface ArrDownloadClient {
  id: number;
  name: string;
  implementation: string;
  enable: boolean;
  /** Flattened `fields[]`, e.g. `{ host, port, category, urlBase }`. */
  fields: Record<string, unknown>;
}

export interface AddSelectedInput {
  term: string;
  selectionId: string;
  qualityProfileId: number;
  rootFolderPath: string;
  monitored?: boolean;
  searchNow?: boolean;
  /** Lidarr only, and required there. */
  metadataProfileId?: number;
}

export class ArrAdapter implements ServiceAdapter {
  readonly status = "functional" as const;
  constructor(readonly kind: ArrFlavor, private cfg: AdapterConfig) {}

  private hdr() { return { "X-Api-Key": this.cfg.secret }; }
  private api(path: string): string { return `/api/${API_VERSION[this.kind]}/${path.replace(/^\//, "")}`; }

  async health(): Promise<HealthResult> {
    const start = Date.now();
    try {
      const s = await httpJson<{ version: string }>(this.cfg.baseUrl, this.api("system/status"), { headers: this.hdr() });
      return { healthy: true, version: s.version, latencyMs: Date.now() - start };
    } catch (e) {
      return { healthy: false, detail: (e as Error).message, latencyMs: Date.now() - start };
    }
  }

  /** Wanted/missing items (paged). */
  async wantedMissing(pageSize = 50): Promise<ArrItem[]> {
    const res = await httpJson<{ records: any[] }>(this.cfg.baseUrl, this.api("wanted/missing"), {
      headers: this.hdr(),
      query: { pageSize, sortKey: "title" },
    });
    return (res.records ?? []).map((r) => ({
      id: r.id,
      title: r.title ?? r.artistName ?? r.seriesTitle ?? "unknown",
      year: r.year,
      monitored: r.monitored,
      hasFile: r.hasFile,
      status: r.status,
    }));
  }

  /** Recent history/activity. */
  async history(pageSize = 30): Promise<ArrActivity[]> {
    const res = await httpJson<{ records: any[] }>(this.cfg.baseUrl, this.api("history"), {
      headers: this.hdr(),
      query: { pageSize, sortKey: "date", sortDirection: "descending" },
    });
    return (res.records ?? []).map((r) => ({
      id: r.id,
      eventType: r.eventType,
      title: r.sourceTitle ?? r.title ?? "",
      date: r.date,
    }));
  }

  /**
   * The *arr's view of what its download client is doing. This is where an
   * import that never happened shows up: `trackedDownloadStatus` goes to
   * warning/error and `statusMessages` carries the reason.
   */
  async queue(pageSize = 200): Promise<ArrQueueItem[]> {
    const res = await httpJson<{ records?: any[] } | any[]>(this.cfg.baseUrl, this.api("queue"), {
      headers: this.hdr(),
      query: { page: 1, pageSize, ...QUEUE_PARAMS[this.kind] },
    });
    // Paged on current builds; a bare array on older ones.
    const records = Array.isArray(res) ? res : res.records ?? [];
    return records.map((r) => this.normalizeQueueItem(r));
  }

  private normalizeQueueItem(r: any): ArrQueueItem {
    return {
      service: this.kind,
      id: r.id,
      title: r.title ?? r.movie?.title ?? r.series?.title ?? r.album?.title ?? r.artist?.artistName ?? "unknown",
      status: r.status ?? "unknown",
      trackedDownloadStatus: r.trackedDownloadStatus,
      trackedDownloadState: r.trackedDownloadState,
      errorMessage: r.errorMessage || undefined,
      statusMessages: flattenStatusMessages(r.statusMessages),
      size: r.size ?? 0,
      sizeleft: r.sizeleft ?? 0,
      downloadId: r.downloadId || undefined,
      outputPath: r.outputPath || undefined,
      added: r.added || undefined,
    };
  }

  /**
   * Drop a record from the *arr's queue. `removeFromClient` also deletes it in
   * the download client; `blocklist` tells the *arr never to grab that release
   * again. Both are the caller's explicit choice.
   */
  async removeFromQueue(id: number, opts: { removeFromClient: boolean; blocklist: boolean }): Promise<void> {
    await httpJson(this.cfg.baseUrl, this.api(`queue/${id}`), {
      method: "DELETE",
      headers: this.hdr(),
      // Older builds spell it `blacklist`; sending both keeps one call working
      // across generations (the *arr ignores the parameter it doesn't know).
      query: {
        removeFromClient: opts.removeFromClient,
        blocklist: opts.blocklist,
        blacklist: opts.blocklist,
      },
    });
  }

  /** Download clients configured *inside* the *arr (not TorHQ's own config). */
  async downloadClients(): Promise<ArrDownloadClient[]> {
    const res = await httpJson<any[]>(this.cfg.baseUrl, this.api("downloadclient"), { headers: this.hdr() });
    return (Array.isArray(res) ? res : []).map((c) => ({
      id: c.id,
      name: c.name ?? "",
      implementation: c.implementation ?? "",
      enable: c.enable ?? false,
      fields: Object.fromEntries((c.fields ?? []).map((f: any) => [f.name, f.value])),
    }));
  }

  /** Download-handling config — notably `enableCompletedDownloadHandling`. */
  async downloadClientConfig(): Promise<{ enableCompletedDownloadHandling?: boolean; autoRedownloadFailed?: boolean }> {
    return httpJson(this.cfg.baseUrl, this.api("config/downloadclient"), { headers: this.hdr() });
  }

  /** Path translations between the download client's view and the *arr's own. */
  async remotePathMappings(): Promise<RemotePathMapping[]> {
    const res = await httpJson<any[]>(this.cfg.baseUrl, this.api("remotepathmapping"), { headers: this.hdr() });
    return (Array.isArray(res) ? res : []).map((m) => ({
      id: m.id, host: m.host ?? "", remotePath: m.remotePath ?? "", localPath: m.localPath ?? "",
    }));
  }

  /**
   * Directories the *arr can see inside `path`, through its OWN filesystem. This
   * is the only way to ask "is the download directory actually mounted in your
   * container?" — a question no amount of configuration inspection answers, and
   * the usual reason a correctly-configured stack still never imports anything.
   */
  async listFolders(path: string): Promise<string[]> {
    const res = await httpJson<{ directories?: Array<{ path?: string }> }>(
      this.cfg.baseUrl, this.api("filesystem"),
      { headers: this.hdr(), query: { path, allowFoldersWithoutTrailingSlashes: true, includeFiles: false } },
    );
    return (res.directories ?? []).map((d) => d.path ?? "").filter(Boolean);
  }

  private lookupPath(): string { return this.api(`${RESOURCE[this.kind]}/lookup`); }

  private async lookup(term: string): Promise<any[]> {
    const res = await httpJson<any[]>(this.cfg.baseUrl, this.lookupPath(), { headers: this.hdr(), query: { term } });
    return Array.isArray(res) ? res : [];
  }

  /** Stable, flavor-specific selector for a raw lookup object. */
  private selectionIdOf(raw: any): string | null {
    switch (this.kind) {
      case "radarr": return raw?.tmdbId != null ? `tmdb:${raw.tmdbId}` : null;
      case "sonarr": return raw?.tvdbId != null ? `tvdb:${raw.tvdbId}` : null;
      case "lidarr": return raw?.foreignArtistId ? `mbid:${raw.foreignArtistId}` : null;
    }
  }

  /** Search and return normalized candidates for the user to choose from. */
  async searchCandidates(term: string): Promise<ArrCandidate[]> {
    const raw = await this.lookup(term);
    const out: ArrCandidate[] = [];
    for (const r of raw) {
      const selectionId = this.selectionIdOf(r);
      if (!selectionId) continue; // unusable without a stable selector
      out.push({
        selectionId,
        title: r.title ?? r.artistName ?? "unknown",
        subtitle: this.kind === "lidarr" ? (r.disambiguation ?? undefined) : undefined,
        year: r.year,
        poster: pickPoster(r.images),
        overview: typeof r.overview === "string" ? r.overview.slice(0, 400) : undefined,
        alreadyAdded: typeof r.id === "number" && r.id > 0,
      });
    }
    return out;
  }

  /**
   * Add exactly the candidate the user selected. We re-run the same lookup and
   * match `selectionId`, so the object we POST is always a genuine lookup result
   * — never "the first hit". Request bodies are flavor-specific.
   */
  async addSelected(input: AddSelectedInput): Promise<{ id: number; title: string }> {
    const raw = await this.lookup(input.term);
    const chosen = raw.find((r) => this.selectionIdOf(r) === input.selectionId);
    if (!chosen) {
      throw new Error(`Selected result is no longer available for "${input.term}"; search again.`);
    }
    if (typeof chosen.id === "number" && chosen.id > 0) {
      return { id: chosen.id, title: chosen.title ?? chosen.artistName ?? input.term };
    }

    const body = this.buildAddBody(chosen, input);
    const created = await httpJson<{ id: number; title?: string; artistName?: string }>(
      this.cfg.baseUrl, this.api(RESOURCE[this.kind]),
      { method: "POST", headers: this.hdr(), body },
    );
    return { id: created.id, title: created.title ?? created.artistName ?? input.term };
  }

  private buildAddBody(chosen: any, input: AddSelectedInput): Record<string, unknown> {
    const monitored = input.monitored ?? true;
    if (this.kind === "radarr") {
      return {
        ...chosen,
        qualityProfileId: input.qualityProfileId,
        rootFolderPath: input.rootFolderPath,
        monitored,
        minimumAvailability: "released",
        addOptions: { searchForMovie: input.searchNow ?? true },
      };
    }
    if (this.kind === "sonarr") {
      return {
        ...chosen,
        qualityProfileId: input.qualityProfileId,
        // Sonarr v3 requires a languageProfileId; v4 ignores it. Keep any value
        // the lookup already provided, else default to 1 for v3 compatibility.
        languageProfileId: chosen.languageProfileId ?? 1,
        rootFolderPath: input.rootFolderPath,
        monitored,
        seasonFolder: true,
        addOptions: { searchForMissingEpisodes: input.searchNow ?? true, monitor: "all" },
      };
    }
    // lidarr — distinct surface: metadataProfileId is mandatory, and it monitors
    // albums, not episodes.
    if (input.metadataProfileId == null) {
      throw new Error("Lidarr requires a metadataProfileId; pass one from /options.");
    }
    return {
      ...chosen,
      qualityProfileId: input.qualityProfileId,
      metadataProfileId: input.metadataProfileId,
      rootFolderPath: input.rootFolderPath,
      monitored,
      addOptions: { monitor: "all", searchForMissingAlbums: input.searchNow ?? true },
    };
  }

  /** Fire an *arr command (e.g. RefreshMonitoredDownloads). */
  async command(name: string, extra: Record<string, unknown> = {}): Promise<{ id?: number }> {
    return httpJson(this.cfg.baseUrl, this.api("command"), {
      method: "POST", headers: this.hdr(), body: { name, ...extra },
    });
  }

  /**
   * Nudge the *arr to poll its download client and import completed downloads
   * now, rather than waiting for its next interval. Used after TorHQ pushes a
   * magnet into the *arr's qBittorrent category: the *arr still owns the import,
   * TorHQ just asks it to look. (The item must be added + monitored in the *arr,
   * with Completed Download Handling enabled, for the import to happen.)
   */
  async processDownloads(): Promise<void> {
    await this.command("RefreshMonitoredDownloads");
  }

  /**
   * Ask the *arr to import a completed download it already owns. With a known
   * `outputPath` we point its own scanner straight at that folder (the precise
   * call, and the one that reports back per-file); without one we fall back to a
   * full download-client refresh. Either way the *arr does the moving and
   * renaming — TorHQ never touches the files.
   */
  async rescanDownload(input: { outputPath?: string; downloadId?: string }): Promise<{ command: string }> {
    if (!input.outputPath) {
      await this.command("RefreshMonitoredDownloads");
      return { command: "RefreshMonitoredDownloads" };
    }
    const name = SCAN_COMMAND[this.kind];
    // No importMode: the *arr's configured copy/hardlink behaviour stays authoritative.
    await this.command(name, { path: input.outputPath, downloadClientId: input.downloadId });
    return { command: name };
  }

  async qualityProfiles(): Promise<Array<{ id: number; name: string }>> {
    return httpJson(this.cfg.baseUrl, this.api("qualityprofile"), { headers: this.hdr() });
  }

  async rootFolders(): Promise<Array<{ id: number; path: string; accessible?: boolean; freeSpace?: number }>> {
    return httpJson(this.cfg.baseUrl, this.api("rootfolder"), { headers: this.hdr() });
  }

  /** Lidarr-only: metadata profiles are required to add an artist. */
  async metadataProfiles(): Promise<Array<{ id: number; name: string }>> {
    if (this.kind !== "lidarr") return [];
    return httpJson(this.cfg.baseUrl, this.api("metadataprofile"), { headers: this.hdr() });
  }
}

/**
 * `statusMessages` is `[{ title, messages[] }]` — the title is usually the file
 * and the messages the reason it could not be imported. Flatten to plain lines,
 * keeping the title when it carries the only information.
 */
function flattenStatusMessages(raw: any): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const m of raw) {
    const messages = Array.isArray(m?.messages) ? m.messages.filter((s: unknown) => typeof s === "string" && s) : [];
    if (messages.length) out.push(...messages);
    else if (typeof m?.title === "string" && m.title) out.push(m.title);
  }
  return [...new Set(out)];
}

function pickPoster(images: any): string | undefined {
  if (!Array.isArray(images)) return undefined;
  const poster = images.find((i) => i?.coverType === "poster") ?? images[0];
  return poster?.remoteUrl ?? poster?.url ?? undefined;
}
