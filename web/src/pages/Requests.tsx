import { useState } from "react";
import { api } from "../lib/api.js";

const TABS = [
  { route: "movie", label: "Movie → Radarr" },
  { route: "tv", label: "TV → Sonarr" },
  { route: "music", label: "Artist/Album → Lidarr" },
];

export function Requests() {
  const [tab, setTab] = useState("movie");
  const [term, setTerm] = useState("");
  const [opts, setOpts] = useState<any>(null);
  const [profile, setProfile] = useState<number | "">("");
  const [root, setRoot] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  async function loadOpts(route: string) {
    setTab(route); setOpts(null); setMsg(null); setProfile(""); setRoot("");
    try {
      const o = await api(`/api/requests/${route}/options`);
      setOpts(o);
      if (o.profiles?.[0]) setProfile(o.profiles[0].id);
      if (o.roots?.[0]) setRoot(o.roots[0].path);
    } catch (e) { setMsg((e as Error).message); }
  }

  async function submit() {
    setMsg(null);
    try {
      const r = await api(`/api/requests/${tab}`, {
        method: "POST",
        body: JSON.stringify({ term, qualityProfileId: Number(profile), rootFolderPath: root, searchNow: true }),
      });
      setMsg(`Requested: ${r.title}`); setTerm("");
    } catch (e) { setMsg((e as Error).message); }
  }

  return (
    <div>
      <h1>Requests</h1>
      <div className="flex" style={{ marginBottom: 14 }}>
        {TABS.map((t) => (
          <button key={t.route} className={"btn " + (tab === t.route ? "primary" : "")} onClick={() => loadOpts(t.route)}>{t.label}</button>
        ))}
      </div>
      <div className="card">
        <p className="muted small">TorHQ only submits the request. The *arr owns search, grab, import, rename, and final placement.</p>
        <label>Search term</label>
        <input value={term} onChange={(e) => setTerm(e.target.value)} placeholder="e.g. Blade Runner 2049" />
        {opts && (
          <>
            <label>Quality profile</label>
            <select value={profile} onChange={(e) => setProfile(Number(e.target.value))}>
              {opts.profiles?.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <label>Root folder</label>
            <select value={root} onChange={(e) => setRoot(e.target.value)}>
              {opts.roots?.map((r: any) => <option key={r.id} value={r.path}>{r.path}</option>)}
            </select>
          </>
        )}
        {!opts && <p className="muted small" style={{ marginTop: 10 }}>Load a tab above to fetch profiles/root folders.</p>}
        <div className="flex" style={{ marginTop: 14 }}>
          <button className="btn primary" onClick={submit} disabled={!opts || !term || !profile || !root}>Submit request</button>
          {msg && <span className={"small " + (msg.startsWith("Requested") ? "ok-text" : "err-text")}>{msg}</span>}
        </div>
      </div>
    </div>
  );
}
