import { httpJson } from "./http.js";
import type { AdapterConfig, ArrActivity, ArrCandidate, ArrItem, HealthResult, ServiceAdapter } from "./types.js";

/**
 * Radarr/Sonarr/Lidarr adapter. Radarr and Sonarr speak the *arr **v3** API;
 * Lidarr speaks **v1** with a different add surface (it requires a
 * metadataProfileId and monitors albums, not episodes). This adapter keeps
 * those differences explicit rather than pretending all three are identical.
 *
 * FUNCTIONAL: health, wanted/missing, history, search-candidates, and
 * add-selected. TorHQ only *requests*: the *arr owns search, grab, import,
 * rename, and final placement — TorHQ never touches its files.
 */
export type ArrFlavor = "radarr" | "sonarr" | "lidarr";

const API_VERSION: Record<ArrFlavor, string> = { radarr: "v3", sonarr: "v3", lidarr: "v1" };
/** Primary resource noun used for lookup + add. */
const RESOURCE: Record<ArrFlavor, string> = { radarr: "movie", sonarr: "series", lidarr: "artist" };

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

  async qualityProfiles(): Promise<Array<{ id: number; name: string }>> {
    return httpJson(this.cfg.baseUrl, this.api("qualityprofile"), { headers: this.hdr() });
  }

  async rootFolders(): Promise<Array<{ id: number; path: string }>> {
    return httpJson(this.cfg.baseUrl, this.api("rootfolder"), { headers: this.hdr() });
  }

  /** Lidarr-only: metadata profiles are required to add an artist. */
  async metadataProfiles(): Promise<Array<{ id: number; name: string }>> {
    if (this.kind !== "lidarr") return [];
    return httpJson(this.cfg.baseUrl, this.api("metadataprofile"), { headers: this.hdr() });
  }
}

function pickPoster(images: any): string | undefined {
  if (!Array.isArray(images)) return undefined;
  const poster = images.find((i) => i?.coverType === "poster") ?? images[0];
  return poster?.remoteUrl ?? poster?.url ?? undefined;
}
