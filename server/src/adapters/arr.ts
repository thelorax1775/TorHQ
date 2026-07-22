import { httpJson } from "./http.js";
import type { AdapterConfig, ArrActivity, ArrItem, HealthResult, ServiceAdapter } from "./types.js";

/**
 * Radarr/Sonarr/Lidarr share the *arr v3 API surface. This one adapter serves
 * all three; only the resource nouns (movie/series/artist) differ.
 * FUNCTIONAL: health, wanted/missing, history, and add-request are implemented.
 */
type ArrFlavor = "radarr" | "sonarr" | "lidarr";

const RESOURCE: Record<ArrFlavor, string> = {
  radarr: "movie",
  sonarr: "series",
  lidarr: "artist",
};

export class ArrAdapter implements ServiceAdapter {
  readonly status = "functional" as const;
  constructor(readonly kind: ArrFlavor, private cfg: AdapterConfig) {}

  private hdr() {
    return { "X-Api-Key": this.cfg.secret };
  }

  async health(): Promise<HealthResult> {
    const start = Date.now();
    try {
      const s = await httpJson<{ version: string }>(this.cfg.baseUrl, "/api/v3/system/status", {
        headers: this.hdr(),
      });
      return { healthy: true, version: s.version, latencyMs: Date.now() - start };
    } catch (e) {
      return { healthy: false, detail: (e as Error).message, latencyMs: Date.now() - start };
    }
  }

  /** Wanted/missing items (paged). */
  async wantedMissing(pageSize = 50): Promise<ArrItem[]> {
    const res = await httpJson<{ records: any[] }>(this.cfg.baseUrl, "/api/v3/wanted/missing", {
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
    const res = await httpJson<{ records: any[] }>(this.cfg.baseUrl, "/api/v3/history", {
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

  private async lookup(term: string): Promise<any[]> {
    return httpJson<any[]>(this.cfg.baseUrl, `/api/v3/${RESOURCE[this.kind]}/lookup`, {
      headers: this.hdr(),
      query: { term },
    });
  }

  /**
   * Add a movie/series/artist request. TorHQ only *requests*: the *arr owns
   * search, grab, import, rename, and final placement. We never touch its files.
   */
  async addRequest(input: {
    term: string;
    qualityProfileId: number;
    rootFolderPath: string;
    monitored?: boolean;
    searchNow?: boolean;
  }): Promise<{ id: number; title: string }> {
    const matches = await this.lookup(input.term);
    const match = matches[0];
    if (!match) throw new Error(`No ${this.kind} match for "${input.term}"`);
    const body: Record<string, unknown> = {
      ...match,
      qualityProfileId: input.qualityProfileId,
      rootFolderPath: input.rootFolderPath,
      monitored: input.monitored ?? true,
      addOptions: { searchForMovie: input.searchNow ?? true, searchForMissingEpisodes: input.searchNow ?? true },
    };
    if (this.kind === "sonarr") body.languageProfileId ??= 1;
    const created = await httpJson<{ id: number; title: string }>(
      this.cfg.baseUrl, `/api/v3/${RESOURCE[this.kind]}`,
      { method: "POST", headers: this.hdr(), body },
    );
    return { id: created.id, title: created.title };
  }

  async qualityProfiles(): Promise<Array<{ id: number; name: string }>> {
    return httpJson(this.cfg.baseUrl, "/api/v3/qualityprofile", { headers: this.hdr() });
  }

  async rootFolders(): Promise<Array<{ id: number; path: string }>> {
    return httpJson(this.cfg.baseUrl, "/api/v3/rootfolder", { headers: this.hdr() });
  }
}
