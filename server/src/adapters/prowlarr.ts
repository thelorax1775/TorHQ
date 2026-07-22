import { httpJson } from "./http.js";
import type { AdapterConfig, HealthResult, ServiceAdapter } from "./types.js";

/** Prowlarr v1 API. FUNCTIONAL: health + indexer summary (read-only). */
export class ProwlarrAdapter implements ServiceAdapter {
  readonly kind = "prowlarr";
  readonly status = "functional" as const;
  constructor(private cfg: AdapterConfig) {}
  private hdr() { return { "X-Api-Key": this.cfg.secret }; }

  async health(): Promise<HealthResult> {
    const start = Date.now();
    try {
      const s = await httpJson<{ version: string }>(this.cfg.baseUrl, "/api/v1/system/status", { headers: this.hdr() });
      return { healthy: true, version: s.version, latencyMs: Date.now() - start };
    } catch (e) {
      return { healthy: false, detail: (e as Error).message, latencyMs: Date.now() - start };
    }
  }

  async indexers(): Promise<Array<{ id: number; name: string; enable: boolean; protocol: string }>> {
    const list = await httpJson<any[]>(this.cfg.baseUrl, "/api/v1/indexer", { headers: this.hdr() });
    return list.map((i) => ({ id: i.id, name: i.name, enable: i.enable, protocol: i.protocol }));
  }
}
