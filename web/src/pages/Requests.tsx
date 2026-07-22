import { useState } from "react";
import { api } from "../lib/api.js";

const TABS = [
  { route: "movie", label: "Movie → Radarr" },
  { route: "tv", label: "TV → Sonarr" },
  { route: "music", label: "Artist → Lidarr" },
];

type Candidate = {
  selectionId: string;
  title: string;
  subtitle?: string;
  year?: number;
  poster?: string;
  overview?: string;
  alreadyAdded: boolean;
};

export function Requests() {
  const [tab, setTab] = useState("movie");
  const [term, setTerm] = useState("");
  const [opts, setOpts] = useState<any>(null);
  const [profile, setProfile] = useState<number | "">("");
  const [metaProfile, setMetaProfile] = useState<number | "">("");
  const [root, setRoot] = useState("");
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [selection, setSelection] = useState<Candidate | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const isMusic = tab === "music";

  async function loadOpts(route: string) {
    setTab(route); setOpts(null); setMsg(null);
    setProfile(""); setMetaProfile(""); setRoot("");
    setCandidates(null); setSelection(null); setTerm("");
    try {
      const o = await api(`/api/requests/${route}/options`);
      setOpts(o);
      if (o.profiles?.[0]) setProfile(o.profiles[0].id);
      if (o.roots?.[0]) setRoot(o.roots[0].path);
      if (o.metadataProfiles?.[0]) setMetaProfile(o.metadataProfiles[0].id);
    } catch (e) { setMsg((e as Error).message); }
  }

  async function search() {
    setMsg(null); setCandidates(null); setSelection(null);
    if (!term) return;
    setBusy(true);
    try {
      const r = await api<{ candidates: Candidate[] }>(`/api/requests/${tab}/search?term=${encodeURIComponent(term)}`);
      setCandidates(r.candidates);
      if (r.candidates.length === 0) setMsg("No matches found.");
    } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  }

  async function submit() {
    if (!selection) return;
    setMsg(null); setBusy(true);
    try {
      const payload: any = {
        term, selectionId: selection.selectionId,
        qualityProfileId: Number(profile), rootFolderPath: root, searchNow: true,
      };
      if (isMusic && metaProfile !== "") payload.metadataProfileId = Number(metaProfile);
      const r = await api(`/api/requests/${tab}`, { method: "POST", body: JSON.stringify(payload) });
      setMsg(`Requested: ${r.title}`);
      setCandidates(null); setSelection(null); setTerm("");
    } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  }

  const canSubmit = !!selection && !!profile && !!root && (!isMusic || metaProfile !== "");

  return (
    <div>
      <h1>Requests</h1>
      <div className="flex" style={{ marginBottom: 14 }}>
        {TABS.map((t) => (
          <button key={t.route} className={"btn " + (tab === t.route ? "primary" : "")} onClick={() => loadOpts(t.route)}>{t.label}</button>
        ))}
      </div>

      <div className="card">
        <p className="muted small">TorHQ only submits the request. Search, pick the intended result, then confirm — the *arr owns search, grab, import, rename, and final placement.</p>

        {!opts && <p className="muted small" style={{ marginTop: 10 }}>Select a tab above to load its quality profiles and root folders.</p>}

        {opts && (
          <>
            <label>Search term</label>
            <div className="flex">
              <input style={{ flex: 1 }} value={term} onChange={(e) => setTerm(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") search(); }}
                placeholder={isMusic ? "e.g. Radiohead" : "e.g. Blade Runner 2049"} />
              <button className="btn" onClick={search} disabled={!term || busy}>Search</button>
            </div>

            <label>Quality profile</label>
            <select value={profile} onChange={(e) => setProfile(Number(e.target.value))}>
              {opts.profiles?.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>

            {isMusic && (
              <>
                <label>Metadata profile (required for Lidarr)</label>
                <select value={metaProfile} onChange={(e) => setMetaProfile(Number(e.target.value))}>
                  {opts.metadataProfiles?.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </>
            )}

            <label>Root folder</label>
            <select value={root} onChange={(e) => setRoot(e.target.value)}>
              {opts.roots?.map((r: any) => <option key={r.id} value={r.path}>{r.path}</option>)}
            </select>
          </>
        )}
        {msg && <p className={"small " + (msg.startsWith("Requested") ? "ok-text" : "err-text")} style={{ marginTop: 10 }}>{msg}</p>}
      </div>

      {candidates && candidates.length > 0 && (
        <div className="card">
          <h2>Choose a result</h2>
          {candidates.map((c) => (
            <label key={c.selectionId} className="row" style={{ cursor: "pointer", alignItems: "flex-start", gap: 10 }}>
              <input type="radio" name="candidate" style={{ marginTop: 4 }}
                checked={selection?.selectionId === c.selectionId}
                onChange={() => setSelection(c)} />
              <span style={{ flex: 1 }}>
                <strong>{c.title}</strong>{c.year ? ` (${c.year})` : ""}
                {c.subtitle ? <span className="muted small"> · {c.subtitle}</span> : null}
                {c.alreadyAdded ? <span className="badge small" style={{ marginLeft: 6 }}>already added</span> : null}
                {c.overview ? <div className="muted small" style={{ marginTop: 2 }}>{c.overview}</div> : null}
              </span>
            </label>
          ))}
          <div className="flex" style={{ marginTop: 14 }}>
            <button className="btn primary" onClick={submit} disabled={!canSubmit || busy}>Confirm request</button>
            {selection?.alreadyAdded && <span className="muted small">This title is already in the library; confirming will not duplicate it.</span>}
          </div>
        </div>
      )}
    </div>
  );
}
