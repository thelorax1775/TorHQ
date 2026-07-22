import { request } from "undici";
import { httpJson } from "./http.js";
import type { AdapterConfig, HealthResult, ServiceAdapter } from "./types.js";

/**
 * qBittorrent WebUI API v2. FUNCTIONAL: cookie login, torrent list by category,
 * transfer info, and category management. TorHQ observes torrents; it NEVER
 * moves/renames Radarr/Sonarr/Lidarr downloads (that would break their import).
 */
export interface QbTorrent {
  hash: string;
  name: string;
  category: string;
  state: string;
  progress: number;
  dlspeed: number;
  upspeed: number;
  size: number;
  eta: number;
}

export class QbittorrentAdapter implements ServiceAdapter {
  readonly kind = "qbittorrent";
  readonly status = "functional" as const;
  private cookie: string | null = null;
  constructor(private cfg: AdapterConfig) {}

  private creds() {
    const [username, ...rest] = this.cfg.secret.split(":");
    return { username: username ?? "", password: rest.join(":") };
  }

  private async login(): Promise<void> {
    const { username, password } = this.creds();
    const base = this.cfg.baseUrl.endsWith("/") ? this.cfg.baseUrl : this.cfg.baseUrl + "/";
    const res = await request(new URL("api/v2/auth/login", base).toString(), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", referer: this.cfg.baseUrl },
      body: new URLSearchParams({ username, password }).toString(),
    });
    const setCookie = res.headers["set-cookie"];
    const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    if (!raw) throw new Error("qBittorrent login failed (no SID cookie)");
    this.cookie = raw.split(";")[0]!;
  }

  private async authed<T>(path: string, query?: Record<string, string | number>): Promise<T> {
    if (!this.cookie) await this.login();
    try {
      return await httpJson<T>(this.cfg.baseUrl, path, { headers: { cookie: this.cookie! }, query });
    } catch (e) {
      this.cookie = null; // retry once after re-login (SID may have expired)
      await this.login();
      return httpJson<T>(this.cfg.baseUrl, path, { headers: { cookie: this.cookie! }, query });
    }
  }

  async health(): Promise<HealthResult> {
    const start = Date.now();
    try {
      const v = await this.authed<string>("/api/v2/app/version");
      return { healthy: true, version: String(v), latencyMs: Date.now() - start };
    } catch (e) {
      return { healthy: false, detail: (e as Error).message, latencyMs: Date.now() - start };
    }
  }

  async torrents(category?: string): Promise<QbTorrent[]> {
    const list = await this.authed<any[]>("/api/v2/torrents/info", category ? { category } : undefined);
    return list.map((t) => ({
      hash: t.hash, name: t.name, category: t.category, state: t.state,
      progress: t.progress, dlspeed: t.dlspeed, upspeed: t.upspeed, size: t.size, eta: t.eta,
    }));
  }

  async transferInfo(): Promise<{ dl_info_speed: number; up_info_speed: number }> {
    return this.authed("/api/v2/transfer/info");
  }

  async categories(): Promise<Record<string, { name: string; savePath: string }>> {
    return this.authed("/api/v2/torrents/categories");
  }

  /** Ensure ownership-distinguishing categories exist (radarr/sonarr/torhq-*). */
  async ensureCategory(name: string, savePath: string): Promise<void> {
    if (!this.cookie) await this.login();
    const base = this.cfg.baseUrl.endsWith("/") ? this.cfg.baseUrl : this.cfg.baseUrl + "/";
    await request(new URL("api/v2/torrents/createCategory", base).toString(), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: this.cookie! },
      body: new URLSearchParams({ category: name, savePath }).toString(),
    });
  }
}
