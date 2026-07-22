import { useEffect, useState } from "react";
import { api, bytes } from "../lib/api.js";

export function Intake() {
  const [libs, setLibs] = useState<any[]>([]);
  const [libraryKey, setLibraryKey] = useState("");
  const [sourcePath, setSourcePath] = useState("");
  const [targetName, setTargetName] = useState("");
  const [preview, setPreview] = useState<any>(null);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => { api("/api/libraries").then((r) => { setLibs(r.libraries); if (r.libraries[0]) setLibraryKey(r.libraries[0].key); }); }, []);

  const payload = () => JSON.stringify({ libraryKey, sourcePath, targetName: targetName || undefined });

  async function doPreview() {
    setMsg(null); setPreview(null);
    try { setPreview(await api("/api/intake/preview", { method: "POST", body: payload() })); }
    catch (e) { setMsg((e as Error).message); }
  }
  async function commit() {
    setMsg(null);
    try { const r = await api("/api/intake", { method: "POST", body: payload() });
      setMsg(`Queued job ${r.jobId}`); setPreview(null); setSourcePath("");
    } catch (e) { setMsg((e as Error).message); }
  }

  return (
    <div>
      <h1>Manual intake</h1>
      <div className="card">
        <p className="muted small">Import a completed file/folder into a Kavita or Navidrome library. Validated against approved roots; symlink escapes rejected; atomic move; then a rescan is requested.</p>
        <label>Destination library</label>
        <select value={libraryKey} onChange={(e) => setLibraryKey(e.target.value)}>
          {libs.map((l) => <option key={l.key} value={l.key}>{l.label} ({l.kind})</option>)}
        </select>
        <label>Source path</label>
        <input value={sourcePath} onChange={(e) => setSourcePath(e.target.value)} placeholder="/srv/torhq/downloads/torhq-music/Album" />
        <label>Final name (optional)</label>
        <input value={targetName} onChange={(e) => setTargetName(e.target.value)} placeholder="Artist - Album (2024)" />
        <div className="flex" style={{ marginTop: 14 }}>
          <button className="btn" onClick={doPreview} disabled={!libraryKey || !sourcePath}>Preview</button>
          <button className="btn primary" onClick={commit} disabled={!preview}>Import</button>
          {msg && <span className={"small " + (msg.startsWith("Queued") ? "ok-text" : "err-text")}>{msg}</span>}
        </div>
      </div>

      {preview && (
        <div className="card">
          <h2>Preview</h2>
          <p className="small">→ {preview.destPath} · {bytes(preview.totalBytes)} · {preview.entries.length} entries</p>
          {preview.warnings?.map((w: string, i: number) => <p key={i} className="err-text small">⚠ {w}</p>)}
          <table><thead><tr><th>Name</th><th>Type</th><th>Size</th></tr></thead>
            <tbody>{preview.entries.map((e: any, i: number) => (
              <tr key={i}><td>{e.name}</td><td className="muted">{e.isDir ? "dir" : "file"}</td><td className="muted">{bytes(e.size)}</td></tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}
