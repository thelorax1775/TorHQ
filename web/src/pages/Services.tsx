import { useEffect, useState } from "react";
import { api } from "../lib/api.js";

const DEFAULTS: Record<string, string> = {
  qbittorrent: "http://127.0.0.1:8080", radarr: "http://127.0.0.1:7878",
  sonarr: "http://127.0.0.1:8989", lidarr: "http://127.0.0.1:8686",
  prowlarr: "http://127.0.0.1:9696", slskd: "http://127.0.0.1:5030",
  jellyfin: "http://127.0.0.1:8096", navidrome: "http://127.0.0.1:4533",
  kavita: "http://127.0.0.1:5000",
};
const SECRET_HINT: Record<string, string> = {
  qbittorrent: "username:password", navidrome: "username:password", slskd: "API key",
  radarr: "API key", sonarr: "API key", lidarr: "API key", prowlarr: "API key",
  jellyfin: "API token", kavita: "API key",
};

export function Services() {
  const [data, setData] = useState<any>(null);
  const [sel, setSel] = useState<string>("qbittorrent");
  const [baseUrl, setBaseUrl] = useState("");
  const [secret, setSecret] = useState("");
  const [test, setTest] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => api("/api/services").then(setData);
  useEffect(() => { load(); }, []);
  useEffect(() => {
    const svc = data?.services?.find((s: any) => s.kind === sel);
    setBaseUrl(svc?.baseUrl ?? DEFAULTS[sel] ?? ""); setSecret(""); setTest(null);
  }, [sel, data]);

  const body = () => JSON.stringify({ kind: sel, label: sel, baseUrl, secret: secret || undefined });

  async function doTest() {
    setBusy(true); setTest(null);
    try { const r = await api("/api/services/test", { method: "POST", body: body() });
      setTest(r.healthy ? `OK — ${r.version ?? r.detail ?? "healthy"}` : `Fail — ${r.detail}`);
    } catch (e) { setTest(`Fail — ${(e as Error).message}`); } finally { setBusy(false); }
  }
  async function save() {
    setBusy(true);
    try { await api("/api/services", { method: "POST", body: body() }); await load(); setTest("Saved."); }
    catch (e) { setTest((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <div>
      <h1>Services (setup wizard)</h1>
      <div className="card">
        <h2>Configured</h2>
        {data?.services?.map((s: any) => (
          <div key={s.kind} className="row">
            <span><span className={"dot " + (s.lastHealthy ? "ok" : "warn")} />{s.kind}</span>
            <span className="muted small">{s.baseUrl} · {s.secretMask ?? "no secret"}</span>
          </div>
        ))}
        {!data?.services?.length && <p className="muted small">Nothing configured yet.</p>}
      </div>

      <div className="card">
        <h2>Add / update</h2>
        <label>Service</label>
        <select value={sel} onChange={(e) => setSel(e.target.value)}>
          {data?.kinds?.map((k: string) => <option key={k} value={k}>{k}</option>)}
        </select>
        <label>Base URL</label>
        <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
        <label>Secret ({SECRET_HINT[sel]}) — leave blank to keep existing</label>
        <input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="••••••••" />
        <div className="flex" style={{ marginTop: 14 }}>
          <button className="btn" onClick={doTest} disabled={busy}>Test connection</button>
          <button className="btn primary" onClick={save} disabled={busy}>Save</button>
          {test && <span className={"small " + (test.startsWith("OK") || test === "Saved." ? "ok-text" : "err-text")}>{test}</span>}
        </div>
      </div>
    </div>
  );
}
