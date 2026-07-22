import { httpJson } from "./http.js";
import type { AdapterConfig, HealthResult, ServiceAdapter } from "./types.js";

/**
 * slskd (Soulseek daemon) API. FUNCTIONAL: health + recent/active downloads.
 * Completed downloads are also delivered via the /webhooks/slskd endpoint,
 * which enqueues a manual-intake job routed to the Navidrome music library.
 */
export class SlskdAdapter implements ServiceAdapter {
  readonly kind = "slskd";
  readonly status = "functional" as const;
  constructor(private cfg: AdapterConfig) {}
  private hdr() { return { "X-API-Key": this.cfg.secret }; }

  async health(): Promise<HealthResult> {
    const start = Date.now();
    try {
      const v = await httpJson<any>(this.cfg.baseUrl, "/api/v0/application", { headers: this.hdr() });
      return { healthy: true, version: v?.version, latencyMs: Date.now() - start };
    } catch (e) {
      return { healthy: false, detail: (e as Error).message, latencyMs: Date.now() - start };
    }
  }

  /** Active + recent downloads grouped by user. */
  async downloads(): Promise<Array<{ username: string; files: Array<{ filename: string; state: string; percentComplete: number }> }>> {
    const list = await httpJson<any[]>(this.cfg.baseUrl, "/api/v0/transfers/downloads", { headers: this.hdr() });
    return (list ?? []).map((u) => ({
      username: u.username,
      files: (u.directories ?? []).flatMap((d: any) => (d.files ?? []).map((f: any) => ({
        filename: f.filename, state: f.state, percentComplete: f.percentComplete,
      }))),
    }));
  }
}
