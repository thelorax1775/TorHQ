import { useEffect, useState } from "react";
import { api, bytes } from "../lib/api.js";

export function Dashboard() {
  const [health, setHealth] = useState<any>(null);
  const [downloads, setDownloads] = useState<any>(null);
  const [storage, setStorage] = useState<any>(null);
  const [failures, setFailures] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);

  async function load() {
    try {
      const [h, s, f] = await Promise.all([
        api("/api/status/health"), api("/api/status/storage"), api("/api/status/failures"),
      ]);
      setHealth(h); setStorage(s); setFailures(f);
      try { setDownloads(await api("/api/status/downloads")); } catch { setDownloads(null); }
    } catch (e) { setErr((e as Error).message); }
  }
  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, []);

  return (
    <div>
      <h1>Dashboard</h1>
      {err && <p className="err-text">{err}</p>}

      <div className="card">
        <h2>Service health</h2>
        <div className="grid">
          {health && Object.entries<any>(health.health).map(([k, v]) => (
            <div key={k} className="row">
              <span><span className={"dot " + (v.healthy ? "ok" : "err")} />{k}</span>
              <span className="badge small">{v.healthy ? (v.version ?? "ok") : (v.detail ?? "down").slice(0, 22)}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="card">
        <h2>Active downloads by category</h2>
        {!downloads && <p className="muted small">qBittorrent not configured or unreachable.</p>}
        {downloads && Object.entries<any>(downloads.byCategory).map(([cat, list]) => (
          <div key={cat} style={{ marginBottom: 10 }}>
            <div className="flex" style={{ justifyContent: "space-between" }}>
              <strong>{cat}</strong><span className="badge">{list.length}</span>
            </div>
            {list.slice(0, 5).map((t: any) => (
              <div key={t.hash} className="row">
                <span className="small" style={{ maxWidth: 380, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.name}</span>
                <span className="small muted">{Math.round(t.progress * 100)}% · {t.state}</span>
              </div>
            ))}
          </div>
        ))}
      </div>

      <div className="card">
        <h2>Storage</h2>
        {storage?.disks?.map((d: any) => {
          const used = d.totalBytes - d.freeBytes; const pct = d.totalBytes ? used / d.totalBytes : 0;
          return (
            <div key={d.path} style={{ marginBottom: 10 }}>
              <div className="flex" style={{ justifyContent: "space-between" }}>
                <span className="small">{d.path}</span>
                <span className="small muted">{bytes(used)} / {bytes(d.totalBytes)}</span>
              </div>
              <div className="bar"><span style={{ width: `${Math.round(pct * 100)}%` }} /></div>
            </div>
          );
        })}
      </div>

      <div className="card">
        <h2>Failed imports</h2>
        {failures?.failed?.length === 0 && <p className="muted small">No failures. 🎉</p>}
        {failures?.failed?.map((j: any) => (
          <div key={j.id} className="row">
            <span className="small">{j.libraryKey} · {j.sourcePath}</span>
            <span className="badge err small">{(j.lastError ?? "").slice(0, 30)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
