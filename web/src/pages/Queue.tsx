/**
 * Queue — the *arr side of the same downloads, plus the health of the path
 * between them.
 *
 * Three stacked concerns, most actionable first: pipeline checks (why an import
 * would fail before it ever fails), failed imports (what is stuck right now),
 * and the merged queue itself. Every action here is a request to the owning
 * *arr — TorHQ moves no files and renames nothing.
 */
import { Fragment, useMemo, useState } from "react";
import { apiSend } from "../lib/api.js";
import { useMutation } from "../lib/useMutation.js";
import { usePolled } from "../lib/usePolled.js";
import { bytes, percent, plural, ago } from "../lib/format.js";
import {
  Alert, Async, Badge, Button, Card, Checkbox, ConfirmDialog, EmptyState, PageHeader,
  ProgressBar, RefreshButton, StaleNotice, Stat, TableWrap, type Tone,
} from "../components/ui.js";
import { Icon } from "../components/Icon.js";

type ArrFlavor = "radarr" | "sonarr" | "lidarr";

interface QueueItem {
  service: ArrFlavor;
  id: number;
  title: string;
  status: string;
  trackedDownloadStatus?: string;
  trackedDownloadState?: string;
  errorMessage?: string;
  statusMessages: string[];
  size: number;
  sizeleft: number;
  downloadId?: string;
  outputPath?: string;
  added?: string;
}

interface Unavailable { service: ArrFlavor; detail: string }
interface QueueResponse { items: QueueItem[]; unavailable: Unavailable[] }

interface PipelineCheck {
  id: string;
  label: string;
  ok: boolean;
  severity: "error" | "warn" | "info";
  detail: string;
  fix?: string;
}
interface CheckResponse { checks: PipelineCheck[] }

interface FailedImport {
  service: ArrFlavor;
  id: number;
  title: string;
  path?: string;
  reason: string;
  downloadId?: string;
}
interface FailedResponse { items: FailedImport[]; unavailable: Unavailable[] }

const SERVICE_LABEL: Record<ArrFlavor, string> = { radarr: "Radarr", sonarr: "Sonarr", lidarr: "Lidarr" };

/** The *arr's own verdict on a queue item → how loudly to show it. */
function itemTone(item: QueueItem): Tone {
  if (item.trackedDownloadStatus === "error" || item.errorMessage) return "err";
  if (item.trackedDownloadStatus === "warning") return "warn";
  if (item.trackedDownloadState === "imported") return "ok";
  return "neutral";
}

const SEVERITY_TONE: Record<PipelineCheck["severity"], Tone> = { error: "err", warn: "warn", info: "info" };

export function Queue() {
  const q = usePolled<QueueResponse>("/api/queue", 10000);
  const checks = usePolled<CheckResponse>("/api/pipeline/check", 60000);
  const failed = usePolled<FailedResponse>("/api/pipeline/failed-imports", 30000);

  const [service, setService] = useState("all");
  const [filter, setFilter] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<QueueItem | null>(null);
  const [removeFromClient, setRemoveFromClient] = useState(true);
  const [blocklist, setBlocklist] = useState(false);
  const [showHealthy, setShowHealthy] = useState(false);

  const refresh = useMutation(
    () => apiSend<{ refreshed: ArrFlavor[]; unavailable: Unavailable[] }>("/api/queue/refresh", "POST"),
    { invalidates: ["/api/queue", "/api/pipeline"] },
  );

  const remove = useMutation(
    (item: QueueItem, opts: { removeFromClient: boolean; blocklist: boolean }) =>
      apiSend<{ ok: true }>(`/api/queue/${item.service}/${item.id}/remove`, "POST", opts),
    { invalidates: ["/api/queue", "/api/pipeline", "/api/downloads"] },
  );

  const reimport = useMutation(
    (item: { service: ArrFlavor; downloadId: string }) =>
      apiSend<{ ok: true; command: string; path: string | null }>("/api/pipeline/manual-import", "POST", item),
    { invalidates: ["/api/queue", "/api/pipeline"] },
  );

  const items = q.data?.items ?? [];
  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return items.filter((i) =>
      (service === "all" || i.service === service)
      && (!needle || i.title.toLowerCase().includes(needle)));
  }, [items, filter, service]);

  const failing = items.filter((i) => itemTone(i) === "err" || itemTone(i) === "warn").length;
  const allChecks = checks.data?.checks ?? [];
  const problems = allChecks.filter((c) => !c.ok);
  const shownChecks = showHealthy ? allChecks : problems;
  const failedItems = failed.data?.items ?? [];

  return (
    <>
      <PageHeader
        title="Queue"
        subtitle="What Radarr, Sonarr and Lidarr are waiting on — and whether they can actually import it."
        actions={
          <>
            <Button
              icon="refresh"
              pending={refresh.pending}
              onClick={() => void refresh.run()}
              title="Ask every *arr to poll its download client now"
            >
              Poll download clients
            </Button>
            <RefreshButton q={q} />
          </>
        }
      />

      {refresh.error && <Alert tone="err" title="Refresh failed">{refresh.error}</Alert>}
      {refresh.data && refresh.data.unavailable.length > 0 && (
        <Alert tone="warn" title="Some services could not be polled">
          {refresh.data.unavailable.map((u) => `${SERVICE_LABEL[u.service]}: ${u.detail}`).join(" · ")}
        </Alert>
      )}

      {/* Pipeline health first: these explain most stuck imports before you dig. */}
      <Card
        title="Pipeline health"
        subtitle="Can a completed grab actually reach the right *arr, in a directory it can see?"
        icon="shield"
        actions={
          allChecks.length > 0 && (
            <Checkbox
              label="Show passing checks"
              checked={showHealthy}
              onChange={setShowHealthy}
            />
          )
        }
      >
        <Async q={checks} what="pipeline checks">
          {(data) => (
            data.checks.length === 0 ? (
              <EmptyState icon="shield" title="No checks ran" message="Configure qBittorrent and at least one *arr on the Services page." />
            ) : shownChecks.length === 0 ? (
              <div className="row ok-text">
                <Icon name="check" size={16} />
                <span>All {plural(allChecks.length, "check")} pass — grabs should import cleanly.</span>
              </div>
            ) : (
              <div className="list">
                {shownChecks.map((c) => (
                  <div key={c.id} className="list-row">
                    <Badge tone={c.ok ? "ok" : SEVERITY_TONE[c.severity]}>{c.ok ? "pass" : c.severity}</Badge>
                    <div className="grow">
                      <div>{c.label}</div>
                      <div className="small muted">{c.detail}</div>
                      {!c.ok && c.fix && (
                        <div className="small" style={{ marginTop: 4 }}>
                          <span className="dim">Fix: </span>{c.fix}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )
          )}
        </Async>
      </Card>

      {/* Downloads that finished but the *arr refused to import. */}
      {failedItems.length > 0 && (
        <Card
          title="Failed imports"
          subtitle="Downloaded, but the *arr could not move it into the library."
          icon="alert"
        >
          {reimport.error && <Alert tone="err" title="Import request failed">{reimport.error}</Alert>}
          <TableWrap>
            <table className="table">
              <thead>
                <tr>
                  <th>Title</th>
                  <th>Service</th>
                  <th>Why</th>
                  <th className="shrink" />
                </tr>
              </thead>
              <tbody>
                {failedItems.map((f) => (
                  <tr key={`${f.service}-${f.id}`}>
                    <td style={{ maxWidth: 360 }}>
                      <div className="truncate" title={f.title}>{f.title}</div>
                      {f.path && <div className="truncate dim xs mono" title={f.path}>{f.path}</div>}
                    </td>
                    <td className="nowrap"><Badge>{SERVICE_LABEL[f.service]}</Badge></td>
                    <td className="small">{f.reason}</td>
                    <td className="shrink">
                      <Button
                        size="sm"
                        icon="refresh"
                        disabled={!f.downloadId}
                        pending={reimport.pending}
                        title={f.downloadId
                          ? `Ask ${SERVICE_LABEL[f.service]} to scan this download again`
                          : "No download-client id — the *arr cannot be pointed at this one"}
                        onClick={() => void reimport.run({ service: f.service, downloadId: f.downloadId! })}
                      >
                        Retry import
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        </Card>
      )}

      <Async q={q} what="the *arr queue">
        {(data) => (
          <div className="stack">
            <div className="stat-grid">
              <Stat label="In queue" value={data.items.length} />
              <Stat label="Needs attention" value={failing} tone={failing ? "warn" : "ok"} />
              <Stat label="Remaining" value={bytes(data.items.reduce((n, i) => n + (i.sizeleft || 0), 0))} />
              <Stat
                label="Services reporting"
                value={`${3 - data.unavailable.length}/3`}
                tone={data.unavailable.length ? "warn" : "ok"}
              />
            </div>

            {data.unavailable.length > 0 && (
              <Alert tone="warn" title="Not every service could be read">
                {data.unavailable.map((u) => `${SERVICE_LABEL[u.service]}: ${u.detail}`).join(" · ")}
                {" — the rest of the queue below is still complete for the services that answered."}
              </Alert>
            )}

            {remove.error && <Alert tone="err" title="Remove failed">{remove.error}</Alert>}

            <Card flush>
              <div className="toolbar">
                <div className="searchbar">
                  <Icon name="search" size={14} />
                  <input
                    className="input"
                    placeholder="Filter by title…"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    aria-label="Filter queue by title"
                  />
                </div>
                <select
                  className="select input-sm"
                  value={service}
                  onChange={(e) => setService(e.target.value)}
                  aria-label="Filter by service"
                  style={{ width: "auto" }}
                >
                  <option value="all">All services</option>
                  {(["radarr", "sonarr", "lidarr"] as const).map((s) => (
                    <option key={s} value={s}>{SERVICE_LABEL[s]}</option>
                  ))}
                </select>
                <span className="muted small">{plural(visible.length, "item")}</span>
              </div>

              {visible.length === 0 ? (
                <EmptyState
                  icon="queue"
                  title={data.items.length ? "Nothing matches those filters" : "No *arr is waiting on anything"}
                  message={data.items.length
                    ? "Clear the filters to see the rest of the queue."
                    : "When an *arr grabs a release it appears here until it has been imported."}
                />
              ) : (
                <TableWrap>
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Title</th>
                        <th>Service</th>
                        <th>State</th>
                        <th style={{ minWidth: 140 }}>Progress</th>
                        <th className="num">Size</th>
                        <th className="num">Added</th>
                        <th className="shrink" />
                      </tr>
                    </thead>
                    <tbody>
                      {visible.map((item) => {
                        const rowKey = `${item.service}-${item.id}`;
                        const tone = itemTone(item);
                        const done = item.size > 0 ? 1 - item.sizeleft / item.size : 0;
                        const notes = [item.errorMessage, ...item.statusMessages].filter(Boolean) as string[];
                        const open = expanded === rowKey;
                        return (
                          <Fragment key={rowKey}>
                            <tr>
                              <td style={{ maxWidth: 380 }}>
                                <div className="truncate" title={item.title}>{item.title}</div>
                                {item.outputPath && (
                                  <div className="truncate dim xs mono" title={item.outputPath}>{item.outputPath}</div>
                                )}
                              </td>
                              <td className="nowrap"><Badge>{SERVICE_LABEL[item.service]}</Badge></td>
                              <td className="nowrap">
                                <Badge tone={tone} title={item.status}>
                                  {item.trackedDownloadState ?? item.status}
                                </Badge>
                              </td>
                              <td>
                                <div className="progress-label">
                                  <ProgressBar value={done} tone={tone === "err" ? "err" : done >= 1 ? "ok" : undefined} />
                                  <span className="small dim">{percent(done)}</span>
                                </div>
                              </td>
                              <td className="num">{bytes(item.size)}</td>
                              <td className="num dim">{item.added ? ago(item.added) : "—"}</td>
                              <td className="shrink row-nowrap">
                                {notes.length > 0 && (
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    icon={open ? "up" : "down"}
                                    title={open ? "Hide messages" : `${plural(notes.length, "message")} from ${SERVICE_LABEL[item.service]}`}
                                    aria-label={open ? "Hide messages" : "Show messages"}
                                    aria-expanded={open}
                                    onClick={() => setExpanded(open ? null : rowKey)}
                                  />
                                )}
                                <Button
                                  size="sm"
                                  variant="danger"
                                  icon="trash"
                                  title="Remove from the queue"
                                  aria-label={`Remove ${item.title} from the queue`}
                                  onClick={() => {
                                    setRemoveFromClient(true);
                                    setBlocklist(false);
                                    setConfirm(item);
                                  }}
                                />
                              </td>
                            </tr>
                            {open && (
                              <tr className="selected">
                                <td colSpan={7}>
                                  <ul className="muted small" style={{ margin: 0, paddingLeft: "1.2em" }}>
                                    {notes.map((m, i) => <li key={i} className="break">{m}</li>)}
                                  </ul>
                                </td>
                              </tr>
                            )}
                          </Fragment>
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

      {confirm && (
        <ConfirmDialog
          title={`Remove from ${SERVICE_LABEL[confirm.service]}'s queue?`}
          confirmLabel="Remove"
          tone="danger-solid"
          pending={remove.pending}
          error={remove.error}
          onClose={() => { setConfirm(null); remove.reset(); }}
          onConfirm={async () => {
            const r = await remove.run(confirm, { removeFromClient, blocklist });
            if (r.ok) setConfirm(null);
          }}
          body={
            <>
              <p className="break"><strong>{confirm.title}</strong></p>
              <Checkbox
                label="Also remove the torrent from qBittorrent"
                checked={removeFromClient}
                onChange={setRemoveFromClient}
              />
              <Checkbox
                label="Blocklist this release so it is not grabbed again"
                checked={blocklist}
                onChange={setBlocklist}
              />
              <p className="muted small">
                Downloaded files are left on disk either way. Leaving the torrent in qBittorrent keeps it seeding,
                but nothing will import it.
              </p>
            </>
          }
        />
      )}
    </>
  );
}
