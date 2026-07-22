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
    await this.postForm("api/v2/torrents/createCategory", { category: name, savePath });
  }

  /**
   * Add a magnet (or .torrent URL) to qBittorrent. This is the ONLY write TorHQ
   * makes to qBittorrent, and it is always an explicit, user-initiated grab. The
   * `category` tags ownership: `torhq-manual` for raw grabs, or an *arr's category
   * (radarr/sonarr/lidarr) so that *arr adopts and imports the download.
   */
  async addTorrent(input: { url: string; category?: string; paused?: boolean }): Promise<void> {
    const form: Record<string, string> = { urls: input.url };
    if (input.category) form.category = input.category;
    if (input.paused) form.paused = "true";
    const res = await this.postForm("api/v2/torrents/add", form);
    // qBittorrent replies with the literal body "Ok." on success, "Fails." otherwise.
    if (res.trim().toLowerCase().startsWith("fails")) {
      throw new Error("qBittorrent rejected the torrent (Fails.)");
    }
  }

  /** POST an x-www-form-urlencoded body to an authed endpoint, re-logging in once. */
  private async postForm(path: string, fields: Record<string, string>): Promise<string> {
    if (!this.cookie) await this.login();
    const base = this.cfg.baseUrl.endsWith("/") ? this.cfg.baseUrl : this.cfg.baseUrl + "/";
    const url = new URL(path, base).toString();
    const send = async () => request(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: this.cookie!, referer: this.cfg.baseUrl },
      body: new URLSearchParams(fields).toString(),
    });
    let res = await send();
    if (res.statusCode === 403) { // SID expired — re-login once and retry.
      this.cookie = null;
      await this.login();
      res = await send();
    }
    const text = await res.body.text();
    if (res.statusCode >= 400) throw new Error(`qBittorrent HTTP ${res.statusCode} for ${path}`);
    return text;
  }
}
