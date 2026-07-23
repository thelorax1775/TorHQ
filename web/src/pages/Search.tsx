import { useEffect, useState } from "react";
import { api, bytes } from "../lib/api.js";

type Result = {
  title: string;
  magnet: string;
  seeders: number | null;
  leechers: number | null;
  sizeBytes: number | null;
  detailUrl: string | null;
};

// Category presets. qBittorrent = a raw grab TorHQ owns; the *arr presets tag the
// download so that *arr adopts and imports it (needs qB wired as its client).
const TARGETS: Array<{ category: string; label: string; kind: string }> = [
  { category: "torhq-manual", label: "qBittorrent", kind: "qbittorrent" },
  { category: "radarr", label: "Radarr", kind: "radarr" },
  { category: "sonarr", label: "Sonarr", kind: "sonarr" },
  { category: "lidarr", label: "Lidarr", kind: "lidarr" },
];

export function Search() {
  const [term, setTerm] = useState("");
  const [results, setResults] = useState<Result[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [configured, setConfigured] = useState<Set<string>>(new Set());
  const [grabState, setGrabState] = useState<Record<number, string>>({});

  useEffect(() => {
    api<{ services: Array<{ kind: string }> }>("/api/services")
      .then((d) => setConfigured(new Set(d.services.map((s) => s.kind))))
      .catch(() => { /* non-fatal: buttons just won't be filtered */ });
  }, []);

  const targets = TARGETS.filter((t) => configured.size === 0 || configured.has(t.kind));

  async function search() {
    if (!term.trim()) return;
    setMsg(null); setResults(null); setGrabState({}); setBusy(true);
    try {
      const r = await api<{ results: Result[] }>(`/api/search?q=${encodeURIComponent(term)}`);
      setResults(r.results);
      if (r.results.length === 0) setMsg("No results.");
    } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  }

  async function grab(i: number, r: Result, category: string) {
    setGrabState((s) => ({ ...s, [i]: "Sending…" }));
    try {
      const res = await api<{ category: string; importTriggered?: boolean }>("/api/search/grab", {
        method: "POST",
        body: JSON.stringify({ magnet: r.magnet, title: r.title, category }),
      });
      setGrabState((s) => ({ ...s, [i]: `Sent → ${res.category}${res.importTriggered ? " · import triggered" : ""}` }));
    } catch (e) {
      setGrabState((s) => ({ ...s, [i]: `Error: ${(e as Error).message}` }));
    }
  }

  const qbConfigured = configured.size === 0 || configured.has("qbittorrent");

  return (
    <div>
      <h1>Torrent search</h1>
      <div className="card">
        <p className="muted small">
          Search your configured torrent site and send a magnet straight to qBittorrent.
          "qBittorrent" grabs into a neutral <code>torhq-manual</code> category; the *arr
          buttons tag the download so that *arr adopts and imports it.
        </p>
        <div className="flex" style={{ marginTop: 10 }}>
          <input style={{ flex: 1 }} value={term} onChange={(e) => setTerm(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") search(); }}
            placeholder="e.g. Blade Runner 2049 2160p" />
          <button className="btn primary" onClick={search} disabled={!term.trim() || busy}>
            {busy ? "Searching…" : "Search"}
          </button>
        </div>
        {!qbConfigured && (
          <p className="err-text small" style={{ marginTop: 8 }}>
            qBittorrent isn't configured — add it on the Services page before grabbing.
          </p>
        )}
        {msg && <p className="err-text small" style={{ marginTop: 10 }}>{msg}</p>}
      </div>

      {results && results.length > 0 && (
        <div className="card">
          <h2>{results.length} result{results.length === 1 ? "" : "s"}</h2>
          <table className="table">
            <thead>
              <tr>
                <th>Title</th><th>Size</th><th>S / L</th><th>Send to</th>
              </tr>
            </thead>
            <tbody>
              {results.map((r, i) => (
                <tr key={i}>
                  <td>
                    {r.detailUrl
                      ? <a href={r.detailUrl} target="_blank" rel="noreferrer noopener">{r.title}</a>
                      : r.title}
                  </td>
                  <td className="nowrap">{r.sizeBytes ? bytes(r.sizeBytes) : "—"}</td>
                  <td className="nowrap">
                    <span className="ok-text">{r.seeders ?? "?"}</span>
                    {" / "}
                    <span className="muted">{r.leechers ?? "?"}</span>
                  </td>
                  <td>
                    <div className="flex" style={{ flexWrap: "wrap", gap: 6 }}>
                      {targets.map((t) => (
                        <button key={t.category} className="btn small"
                          disabled={!qbConfigured}
                          onClick={() => grab(i, r, t.category)}>{t.label}</button>
                      ))}
                    </div>
                    {grabState[i] && (
                      <div className={"small " + (grabState[i]!.startsWith("Sent") ? "ok-text" : grabState[i]!.startsWith("Error") ? "err-text" : "muted")}>
                        {grabState[i]}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
