/**
 * Downloads — the qBittorrent view.
 *
 * Consumes `GET /api/downloads` (polled) and `POST /api/downloads/action`.
 * Multi-select drives bulk pause/resume/recheck/priority/setCategory; both
 * delete actions confirm, and delete-with-files — the only action that destroys
 * data on disk — needs a typed confirmation.
 */
import { useMemo, useState } from "react";
import { apiSend } from "../lib/api.js";
import { useMutation } from "../lib/useMutation.js";
import { usePolled } from "../lib/usePolled.js";
import { bytes, eta as fmtEta, percent, speed, ago, plural } from "../lib/format.js";
import {
  Alert, Async, Badge, Button, Card, ConfirmDialog, EmptyState, PageHeader,
  ProgressBar, RefreshButton, StaleNotice, Stat, TableWrap, type Tone,
} from "../components/ui.js";
import { Icon } from "../components/Icon.js";

interface Torrent {
  hash: string;
  name: string;
  category: string;
  state: string;
  progress: number;
  dlspeed: number;
  upspeed: number;
  size: number;
  eta: number;
  savePath: string;
  ratio: number;
  addedOn: number;
  tags?: string[];
}

interface DownloadsResponse {
  torrents: Torrent[];
  transfer?: { dlspeed?: number; upspeed?: number };
  categories?: Record<string, { name: string; savePath: string }>;
}

type Action =
  | "pause" | "resume" | "recheck" | "delete" | "deleteWithFiles"
  | "topPriority" | "bottomPriority" | "setCategory";

/** qBittorrent state → (tone, human label). */
const STATE_META: Record<string, { tone: Tone; label: string }> = {
  downloading: { tone: "accent", label: "Downloading" },
  forcedDL: { tone: "accent", label: "Downloading (forced)" },
  metaDL: { tone: "accent", label: "Fetching metadata" },
  stalledDL: { tone: "warn", label: "Stalled" },
  queuedDL: { tone: "neutral", label: "Queued" },
  allocating: { tone: "neutral", label: "Allocating" },
  checkingDL: { tone: "info", label: "Checking" },
  checkingUP: { tone: "info", label: "Checking" },
  checkingResumeData: { tone: "info", label: "Checking" },
  uploading: { tone: "ok", label: "Seeding" },
  forcedUP: { tone: "ok", label: "Seeding (forced)" },
  stalledUP: { tone: "ok", label: "Seeding (idle)" },
  queuedUP: { tone: "neutral", label: "Queued (seed)" },
  pausedDL: { tone: "neutral", label: "Paused" },
  pausedUP: { tone: "ok", label: "Completed" },
  moving: { tone: "info", label: "Moving" },
  error: { tone: "err", label: "Error" },
  missingFiles: { tone: "err", label: "Missing files" },
  unknown: { tone: "neutral", label: "Unknown" },
};

const stateMeta = (s: string) => STATE_META[s] ?? { tone: "neutral" as Tone, label: s };
const isPaused = (s: string) => s.startsWith("paused");
const isDone = (t: Torrent) => t.progress >= 1;

const GROUPS: Array<{ id: string; label: string; match: (t: Torrent) => boolean }> = [
  { id: "all", label: "All", match: () => true },
  { id: "downloading", label: "Downloading", match: (t) => !isPaused(t.state) && !isDone(t) },
  { id: "seeding", label: "Seeding", match: (t) => t.state.endsWith("UP") && !isPaused(t.state) },
  { id: "paused", label: "Paused", match: (t) => isPaused(t.state) },
  { id: "completed", label: "Completed", match: isDone },
  { id: "error", label: "Errored", match: (t) => t.state === "error" || t.state === "missingFiles" },
];

export function Downloads() {
  const q = usePolled<DownloadsResponse>("/api/downloads", 5000);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [category, setCategory] = useState("all");
  const [group, setGroup] = useState("all");
  const [moveTo, setMoveTo] = useState("");
  const [confirm, setConfirm] = useState<null | { action: Extract<Action, "delete" | "deleteWithFiles">; hashes: string[] }>(null);

  const act = useMutation(
    (action: Action, hashes: string[], cat?: string) =>
      apiSend<{ ok: true }>("/api/downloads/action", "POST", {
        hashes, action, ...(cat !== undefined ? { category: cat } : {}),
      }),
    { invalidates: ["/api/downloads", "/api/queue", "/api/status/downloads"] },
  );

  const torrents = q.data?.torrents ?? [];
  const categories = useMemo(() => {
    const fromServer = Object.keys(q.data?.categories ?? {});
    const fromTorrents = torrents.map((t) => t.category).filter(Boolean);
    return [...new Set([...fromServer, ...fromTorrents])].sort();
  }, [q.data?.categories, torrents]);

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const groupMatch = GROUPS.find((g) => g.id === group)?.match ?? (() => true);
    return torrents.filter((t) =>
      groupMatch(t)
      && (category === "all" || (t.category || "") === category)
      && (!needle || t.name.toLowerCase().includes(needle)));
  }, [torrents, filter, category, group]);

  const visibleHashes = visible.map((t) => t.hash);
  const selectedVisible = visibleHashes.filter((h) => selected.has(h));
  const allSelected = visibleHashes.length > 0 && selectedVisible.length === visibleHashes.length;

  function toggle(hash: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(hash)) next.delete(hash); else next.add(hash);
      return next;
    });
  }
  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(visibleHashes));
  }

  async function run(action: Action, hashes: string[], cat?: string) {
    const r = await act.run(action, hashes, cat);
    if (r.ok) setSelected(new Set());
    return r;
  }

  const totals = useMemo(() => ({
    count: torrents.length,
    active: torrents.filter((t) => !isPaused(t.state) && !isDone(t)).length,
    errored: torrents.filter((t) => t.state === "error" || t.state === "missingFiles").length,
    size: torrents.reduce((n, t) => n + (t.size ?? 0), 0),
  }), [torrents]);

  return (
    <>
      <PageHeader
        title="Downloads"
        subtitle="Everything qBittorrent is working on. Selecting rows enables bulk actions; deleting always asks first."
        actions={<RefreshButton q={q} />}
      />

      <Async q={q} what="qBittorrent data">
        {(data) => (
          <div className="stack">
            <div className="stat-grid">
              <Stat label="Download" value={speed(data.transfer?.dlspeed ?? 0)} meta={plural(totals.active, "active transfer")} />
              <Stat label="Upload" value={speed(data.transfer?.upspeed ?? 0)} />
              <Stat label="Torrents" value={totals.count} meta={bytes(totals.size)} />
              <Stat label="Errored" value={totals.errored} tone={totals.errored ? "err" : undefined}
                meta={totals.errored ? "Check the Queue page" : "None"} />
            </div>

            {act.error && <Alert tone="err" title="Action failed">{act.error}</Alert>}

            <Card flush>
              <div className="toolbar">
                <div className="searchbar">
                  <Icon name="search" size={14} />
                  <input
                    className="input"
                    placeholder="Filter by name…"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    aria-label="Filter torrents by name"
                  />
                </div>
                <select className="select input-sm" value={group} onChange={(e) => setGroup(e.target.value)} aria-label="Filter by state" style={{ width: "auto" }}>
                  {GROUPS.map((g) => <option key={g.id} value={g.id}>{g.label}</option>)}
                </select>
                <select className="select input-sm" value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Filter by category" style={{ width: "auto" }}>
                  <option value="all">All categories</option>
                  {categories.map((c) => <option key={c} value={c}>{c || "(none)"}</option>)}
                </select>
                <span className="muted small">{plural(visible.length, "torrent")}</span>
              </div>

              {selectedVisible.length > 0 && (
                <div className="toolbar">
                  <strong className="small">{plural(selectedVisible.length, "torrent")} selected</strong>
                  <Button size="sm" icon="pause" pending={act.pending} onClick={() => void run("pause", selectedVisible)}>Pause</Button>
                  <Button size="sm" icon="play" pending={act.pending} onClick={() => void run("resume", selectedVisible)}>Resume</Button>
                  <Button size="sm" icon="refresh" pending={act.pending} onClick={() => void run("recheck", selectedVisible)}>Recheck</Button>
                  <Button size="sm" icon="up" pending={act.pending} onClick={() => void run("topPriority", selectedVisible)}>Top</Button>
                  <Button size="sm" icon="down" pending={act.pending} onClick={() => void run("bottomPriority", selectedVisible)}>Bottom</Button>
                  <span className="row-nowrap">
                    <select
                      className="select input-sm"
                      value={moveTo}
                      onChange={(e) => setMoveTo(e.target.value)}
                      aria-label="Move selection to category"
                      style={{ width: "auto" }}
                    >
                      <option value="">Set category…</option>
                      {categories.map((c) => <option key={c} value={c}>{c || "(none)"}</option>)}
                    </select>
                    <Button size="sm" disabled={!moveTo} pending={act.pending}
                      onClick={() => void run("setCategory", selectedVisible, moveTo)}>Apply</Button>
                  </span>
                  <span className="grow" />
                  <Button size="sm" variant="danger" icon="trash"
                    onClick={() => setConfirm({ action: "delete", hashes: selectedVisible })}>Remove</Button>
                  <Button size="sm" variant="danger" icon="trash"
                    onClick={() => setConfirm({ action: "deleteWithFiles", hashes: selectedVisible })}>Remove + delete files</Button>
                  <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>Clear</Button>
                </div>
              )}

              {visible.length === 0 ? (
                <EmptyState
                  icon="download"
                  title={torrents.length ? "Nothing matches those filters" : "No torrents in qBittorrent"}
                  message={torrents.length
                    ? "Clear the filters to see the rest of the list."
                    : "Grab something from the Search page, or let Radarr/Sonarr/Lidarr push their own downloads here."}
                />
              ) : (
                <TableWrap>
                  <table className="table">
                    <thead>
                      <tr>
                        <th className="shrink">
                          <input
                            type="checkbox"
                            checked={allSelected}
                            onChange={toggleAll}
                            aria-label="Select all visible torrents"
                          />
                        </th>
                        <th>Name</th>
                        <th>Category</th>
                        <th>State</th>
                        <th style={{ minWidth: 140 }}>Progress</th>
                        <th className="num">Size</th>
                        <th className="num">↓</th>
                        <th className="num">↑</th>
                        <th className="num">ETA</th>
                        <th className="num">Ratio</th>
                        <th className="num">Added</th>
                        <th className="shrink" />
                      </tr>
                    </thead>
                    <tbody>
                      {visible.map((t) => {
                        const meta = stateMeta(t.state);
                        const checked = selected.has(t.hash);
                        return (
                          <tr key={t.hash} className={checked ? "selected" : undefined}>
                            <td className="shrink">
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => toggle(t.hash)}
                                aria-label={`Select ${t.name}`}
                              />
                            </td>
                            <td style={{ maxWidth: 380 }}>
                              <div className="truncate" title={t.name}>{t.name}</div>
                              <div className="truncate dim xs mono" title={t.savePath}>{t.savePath}</div>
                            </td>
                            <td className="nowrap">{t.category ? <Badge>{t.category}</Badge> : <span className="dim">—</span>}</td>
                            <td className="nowrap"><Badge tone={meta.tone}>{meta.label}</Badge></td>
                            <td>
                              <div className="progress-label">
                                <ProgressBar
                                  value={t.progress}
                                  tone={t.state === "error" || t.state === "missingFiles" ? "err" : isDone(t) ? "ok" : undefined}
                                />
                                <span className="small dim">{percent(t.progress)}</span>
                              </div>
                            </td>
                            <td className="num">{bytes(t.size)}</td>
                            <td className="num">{t.dlspeed ? speed(t.dlspeed) : "—"}</td>
                            <td className="num">{t.upspeed ? speed(t.upspeed) : "—"}</td>
                            <td className="num">{isDone(t) ? "—" : fmtEta(t.eta)}</td>
                            <td className="num">{typeof t.ratio === "number" ? t.ratio.toFixed(2) : "—"}</td>
                            <td className="num dim">{ago(t.addedOn)}</td>
                            <td className="shrink">
                              <Button
                                size="sm"
                                variant="ghost"
                                icon={isPaused(t.state) ? "play" : "pause"}
                                aria-label={isPaused(t.state) ? `Resume ${t.name}` : `Pause ${t.name}`}
                                title={isPaused(t.state) ? "Resume" : "Pause"}
                                onClick={() => void act.run(isPaused(t.state) ? "resume" : "pause", [t.hash])}
                              />
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </TableWrap>
              )}
            </Card>

            <StaleNotice q={q} />
          </div>
        )}
      </Async>

      {confirm && confirm.action === "delete" && (
        <ConfirmDialog
          title="Remove from qBittorrent?"
          confirmLabel={`Remove ${plural(confirm.hashes.length, "torrent")}`}
          tone="danger-solid"
          pending={act.pending}
          error={act.error}
          onClose={() => { setConfirm(null); act.reset(); }}
          onConfirm={async () => {
            const r = await run("delete", confirm.hashes);
            if (r.ok) setConfirm(null);
          }}
          body={
            <>
              <p>
                {plural(confirm.hashes.length, "torrent")} will be removed from qBittorrent.
                <strong> Downloaded files are kept on disk</strong> — only the torrent entry goes away.
              </p>
              <p className="muted small">
                If an *arr was going to import this download, removing it here means the *arr will never see it.
              </p>
            </>
          }
        />
      )}

      {confirm && confirm.action === "deleteWithFiles" && (
        <ConfirmDialog
          title="Delete torrents and their files?"
          confirmLabel="Delete files permanently"
          tone="danger-solid"
          requireText="DELETE"
          pending={act.pending}
          error={act.error}
          onClose={() => { setConfirm(null); act.reset(); }}
          onConfirm={async () => {
            const r = await run("deleteWithFiles", confirm.hashes);
            if (r.ok) setConfirm(null);
          }}
          body={
            <>
              <p>
                This removes {plural(confirm.hashes.length, "torrent")} <strong>and deletes the downloaded
                data from disk</strong>. It cannot be undone, and any media already imported from these files
                stays where the *arr put it.
              </p>
              <ul className="muted small" style={{ margin: 0, paddingLeft: "1.2em" }}>
                {confirm.hashes.slice(0, 5).map((h) => {
                  const t = torrents.find((x) => x.hash === h);
                  return <li key={h} className="break">{t?.name ?? h}</li>;
                })}
                {confirm.hashes.length > 5 && <li>…and {confirm.hashes.length - 5} more</li>}
              </ul>
            </>
          }
        />
      )}
    </>
  );
}

export { STATE_META };
