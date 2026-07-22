import { httpJson } from "./http.js";
import type { AdapterConfig, HealthResult, ServiceAdapter } from "./types.js";

/** Jellyfin API. FUNCTIONAL: health + trigger library refresh (rescan). */
export class JellyfinAdapter implements ServiceAdapter {
  readonly kind = "jellyfin";
  readonly status = "functional" as const;
  constructor(private cfg: AdapterConfig) {}
  private hdr() { return { "X-Emby-Token": this.cfg.secret }; }

  async health(): Promise<HealthResult> {
    const start = Date.now();
    try {
      const s = await httpJson<{ Version: string }>(this.cfg.baseUrl, "/System/Info", { headers: this.hdr() });
      return { healthy: true, version: s.Version, latencyMs: Date.now() - start };
    } catch (e) {
      return { healthy: false, detail: (e as Error).message, latencyMs: Date.now() - start };
    }
  }

  /** Ask Jellyfin to rescan all libraries after an intake import. */
  async refreshLibraries(): Promise<void> {
    await httpJson(this.cfg.baseUrl, "/Library/Refresh", { method: "POST", headers: this.hdr() });
  }
}
