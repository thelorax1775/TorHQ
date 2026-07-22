import type { Buffer } from "node:buffer";
import { getServiceDecrypted } from "../config/store.js";
import { setServiceHealth } from "../config/store.js";
import { ArrAdapter } from "./arr.js";
import { QbittorrentAdapter } from "./qbittorrent.js";
import { ProwlarrAdapter } from "./prowlarr.js";
import { SlskdAdapter } from "./slskd.js";
import { JellyfinAdapter } from "./jellyfin.js";
import { NavidromeAdapter } from "./navidrome.js";
import { KavitaAdapter } from "./kavita.js";
import type { AdapterConfig, HealthResult, ServiceAdapter } from "./types.js";

export type AnyAdapter =
  | ArrAdapter | QbittorrentAdapter | ProwlarrAdapter | SlskdAdapter
  | JellyfinAdapter | NavidromeAdapter | KavitaAdapter;

function build(kind: string, cfg: AdapterConfig): AnyAdapter {
  switch (kind) {
    case "radarr": return new ArrAdapter("radarr", cfg);
    case "sonarr": return new ArrAdapter("sonarr", cfg);
    case "lidarr": return new ArrAdapter("lidarr", cfg);
    case "qbittorrent": return new QbittorrentAdapter(cfg);
    case "prowlarr": return new ProwlarrAdapter(cfg);
    case "slskd": return new SlskdAdapter(cfg);
    case "jellyfin": return new JellyfinAdapter(cfg);
    case "navidrome": return new NavidromeAdapter(cfg);
    case "kavita": return new KavitaAdapter(cfg);
    default: throw new Error(`Unknown service kind: ${kind}`);
  }
}

/** Construct a configured adapter, or null if the service isn't set up. */
export function getAdapter(kind: string, masterKey: Buffer): AnyAdapter | null {
  const svc = getServiceDecrypted(kind, masterKey);
  if (!svc || !svc.enabled) return null;
  return build(kind, { baseUrl: svc.baseUrl, secret: svc.secret, extra: svc.extra });
}

/** Health-check one service using a *provided* config (used by the wizard's Test button). */
export async function testConfig(kind: string, cfg: AdapterConfig): Promise<HealthResult> {
  return (build(kind, cfg) as ServiceAdapter).health();
}

/** Health-check all configured services; persists last status. */
export async function checkAllHealth(kinds: string[], masterKey: Buffer): Promise<Record<string, HealthResult>> {
  const out: Record<string, HealthResult> = {};
  await Promise.all(kinds.map(async (kind) => {
    const a = getAdapter(kind, masterKey);
    if (!a) { out[kind] = { healthy: false, detail: "not configured" }; return; }
    const h = await (a as ServiceAdapter).health();
    out[kind] = h;
    setServiceHealth(kind, h.healthy, h.detail ?? (h.healthy ? "ok" : "error"));
  }));
  return out;
}
