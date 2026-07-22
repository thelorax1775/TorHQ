import { useEffect, useState } from "react";
import { api } from "../lib/api.js";

export function Libraries() {
  const [libs, setLibs] = useState<any[]>([]);
  const [roots, setRoots] = useState<string[]>([]);
  const [form, setForm] = useState({
    key: "", label: "", kind: "books", targetService: "kavita",
    destPath: "", stagingPath: "", rescan: true,
  });
  const [msg, setMsg] = useState<string | null>(null);

  const load = async () => {
    setLibs((await api("/api/libraries")).libraries);
    setRoots((await api("/api/config/roots")).approvedRoots);
  };
  useEffect(() => { load(); }, []);

  async function save() {
    setMsg(null);
    try { await api("/api/libraries", { method: "POST", body: JSON.stringify(form) }); await load(); setMsg("Saved."); }
    catch (e) { setMsg((e as Error).message); }
  }
  const set = (k: string, v: any) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <div>
      <h1>Intake libraries</h1>
      <p className="muted small">Destination rules for manual intake. Paths must live inside approved roots: {roots.join(", ")}</p>

      <div className="card">
        <h2>Configured</h2>
        {libs.map((l) => (
          <div key={l.key} className="row">
            <span>{l.label} <span className="badge">{l.kind}</span></span>
            <span className="muted small">→ {l.targetService} · {l.destPath}</span>
          </div>
        ))}
        {!libs.length && <p className="muted small">No libraries yet.</p>}
      </div>

      <div className="card">
        <h2>Add / update</h2>
        <label>Key (a-z0-9-)</label>
        <input value={form.key} onChange={(e) => set("key", e.target.value)} placeholder="kavita-manga" />
        <label>Label</label>
        <input value={form.label} onChange={(e) => set("label", e.target.value)} placeholder="Kavita Manga" />
        <div className="flex">
          <div style={{ flex: 1 }}>
            <label>Content kind</label>
            <select value={form.kind} onChange={(e) => set("kind", e.target.value)}>
              {["books", "manga", "comics", "music"].map((k) => <option key={k}>{k}</option>)}
            </select>
          </div>
          <div style={{ flex: 1 }}>
            <label>Target service</label>
            <select value={form.targetService} onChange={(e) => set("targetService", e.target.value)}>
              {["kavita", "navidrome"].map((k) => <option key={k}>{k}</option>)}
            </select>
          </div>
        </div>
        <label>Destination path (final library dir)</label>
        <input value={form.destPath} onChange={(e) => set("destPath", e.target.value)} placeholder="/srv/torhq/libraries/manga" />
        <label>Staging path</label>
        <input value={form.stagingPath} onChange={(e) => set("stagingPath", e.target.value)} placeholder="/srv/torhq/staging/manga" />
        <div className="flex" style={{ marginTop: 14 }}>
          <button className="btn primary" onClick={save}>Save</button>
          {msg && <span className={"small " + (msg === "Saved." ? "ok-text" : "err-text")}>{msg}</span>}
        </div>
      </div>
    </div>
  );
}
