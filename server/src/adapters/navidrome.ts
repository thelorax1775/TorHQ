import { createHash, randomBytes } from "node:crypto";
import { httpJson } from "./http.js";
import type { AdapterConfig, HealthResult, ServiceAdapter } from "./types.js";

/**
 * Navidrome via the Subsonic API. FUNCTIONAL: health (ping) + startScan trigger.
 * secret stored as "username:password". Subsonic uses salted token auth.
 * Navidrome also watches its music dir and rescans on schedule; startScan just
 * makes the post-import refresh immediate.
 */
export class NavidromeAdapter implements ServiceAdapter {
  readonly kind = "navidrome";
  readonly status = "functional" as const;
  constructor(private cfg: AdapterConfig) {}

  private auth() {
    const [u, ...rest] = this.cfg.secret.split(":");
    const password = rest.join(":");
    const salt = randomBytes(8).toString("hex");
    const token = createHash("md5").update(password + salt).digest("hex");
    return { u: u ?? "", t: token, s: salt, v: "1.16.1", c: "torhq", f: "json" };
  }

  async health(): Promise<HealthResult> {
    const start = Date.now();
    try {
      const r = await httpJson<any>(this.cfg.baseUrl, "/rest/ping.view", { query: this.auth() });
      const ok = r?.["subsonic-response"]?.status === "ok";
      return { healthy: ok, version: r?.["subsonic-response"]?.version, latencyMs: Date.now() - start };
    } catch (e) {
      return { healthy: false, detail: (e as Error).message, latencyMs: Date.now() - start };
    }
  }

  async startScan(): Promise<void> {
    await httpJson(this.cfg.baseUrl, "/rest/startScan.view", { query: this.auth() });
  }
}
