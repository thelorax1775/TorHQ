import { useState } from "react";
import { apiSend } from "../lib/api.js";
import { ago } from "../lib/format.js";
import { useMutation } from "../lib/useMutation.js";
import { usePolled } from "../lib/usePolled.js";
import { Alert, Badge, Button, Card, ConfirmDialog, InlineStatus, Stat } from "./ui.js";

type Action = "check" | "apply";
type State = "idle" | "running" | "restarting" | "done" | "failed";
interface Commit { sha: string; subject: string }
interface UpdateView {
  available: boolean;
  pending: { action: Action; requestedAt: number; stale: boolean } | null;
  status: {
    state: State;
    action?: Action;
    step?: string | null;
    message?: string | null;
    branch?: string;
    current?: Commit;
    latest?: string;
    behind?: number;
    diverged?: boolean;
    commits?: Commit[];
    checkedAt?: number;
    finishedAt?: number | null;
  };
  log: string[];
}

const PATH = "/api/system/update";

/** Check GitHub for new commits and install them, driven by the root-side torhq-update helper. */
export function UpdateCard() {
  const [confirming, setConfirming] = useState(false);
  const probe = usePolled<UpdateView>(PATH, 30000);
  const s = probe.data?.status;
  const queued = !!probe.data?.pending && !probe.data.pending.stale;
  const busy = queued || s?.state === "running" || s?.state === "restarting";
  const q = usePolled<UpdateView>(PATH, busy ? 2000 : 30000);
  const view = q.data;
  const status = view?.status;

  const check = useMutation(() => apiSend<UpdateView>(`${PATH}/check`, "POST"), { invalidates: [PATH] });
  const apply = useMutation(() => apiSend<UpdateView>(`${PATH}/apply`, "POST"), { invalidates: [PATH] });

  const restarting = status?.state === "restarting" || (busy && status?.action === "apply" && !!q.error);
  const stateBadge = (() => {
    if (!view) return null;
    if (!view.available) return <Badge tone="warn">not installed</Badge>;
    if (queued) return <Badge tone="info">queued</Badge>;
    if (restarting) return <Badge tone="info">restarting</Badge>;
    if (status?.state === "running") return <Badge tone="info">{status.step ?? status.action ?? "running"}</Badge>;
    if (status?.state === "failed") return <Badge tone="err">failed</Badge>;
    if (status?.behind) return <Badge tone="warn">update available</Badge>;
    if (status?.checkedAt) return <Badge tone="ok">up to date</Badge>;
    return null;
  })();

  return (
    <Card
      title="Updates"
      subtitle="Pull the latest TorHQ from GitHub, rebuild, migrate and restart — without a shell."
      icon="download"
      actions={stateBadge}
    >
      {view && !view.available ? (
        <Alert tone="warn" title="Updater not installed on this host">
          Run <code className="mono">/srv/torhq/app/scripts/upgrade.sh</code> once as root inside the container. It
          installs the <code className="mono">torhq-update</code> helper, after which updates can be started from here.
        </Alert>
      ) : (
        <div className="stack">
          <div className="stat-grid">
            <Stat
              label="Running"
              value={<span className="mono">{status?.current?.sha ?? "—"}</span>}
              meta={status?.current?.subject}
            />
            <Stat
              label={`Latest on ${status?.branch ? `origin/${status.branch}` : "GitHub"}`}
              value={<span className="mono">{status?.latest ?? "—"}</span>}
              meta={status?.checkedAt ? `checked ${ago(status.checkedAt)}` : "not checked yet"}
            />
            <Stat
              label="Behind"
              value={status?.behind ?? "—"}
              tone={status?.behind ? "warn" : status?.checkedAt ? "ok" : "neutral"}
            />
          </div>

          {view?.pending?.stale && (
            <Alert tone="warn" title="The update helper hasn't picked up the last request">
              Check <code className="mono">systemctl status torhq-update.path</code> in the container.
            </Alert>
          )}
          {restarting && (
            <Alert tone="info" title="Restarting TorHQ">
              The new build is installed and the service is restarting. This page will reconnect on its own.
            </Alert>
          )}
          {status?.state === "failed" && status.message && (
            <Alert tone="err" title={`${status.action === "apply" ? "Update" : "Check"} failed`}>
              <span className="break">{status.message}</span>
            </Alert>
          )}
          {status?.state === "done" && status.message && !busy && (
            <InlineStatus tone="ok">
              {status.message}{status.finishedAt ? ` · ${ago(status.finishedAt)}` : ""}
            </InlineStatus>
          )}

          {!!status?.commits?.length && (
            <div className="list">
              {status.commits.map((c) => (
                <div key={c.sha} className="list-row">
                  <Badge tone="info">{c.sha}</Badge>
                  <span className="small break grow">{c.subject}</span>
                </div>
              ))}
            </div>
          )}

          <div className="row">
            <Button icon="refresh" onClick={() => check.run()} pending={check.pending} disabled={busy}>
              Check for updates
            </Button>
            <Button
              variant="primary"
              icon="download"
              onClick={() => { apply.reset(); setConfirming(true); }}
              disabled={busy || !status?.behind || status.diverged}
              pending={busy && status?.action === "apply"}
            >
              Update now
            </Button>
          </div>
          {check.error && <InlineStatus tone="err">{check.error}</InlineStatus>}

          {view && view.log.length > 0 && (busy || status?.state === "failed" || status?.action === "apply") && (
            <details open={busy || status?.state === "failed"}>
              <summary className="small muted">Update log</summary>
              <pre className="small">{view.log.join("\n")}</pre>
            </details>
          )}
        </div>
      )}

      {confirming && (
        <ConfirmDialog
          title="Update TorHQ now?"
          body={
            <>
              TorHQ will back up its database, pull {status?.behind ?? "the new"} commit
              {status?.behind === 1 ? "" : "s"} from GitHub, rebuild and run migrations, then restart. The UI is
              unavailable for a minute or so while it restarts.
            </>
          }
          confirmLabel="Update and restart"
          tone="primary"
          pending={apply.pending}
          error={apply.error}
          onClose={() => setConfirming(false)}
          onConfirm={async () => {
            const r = await apply.run();
            if (r.ok) setConfirming(false);
          }}
        />
      )}
    </Card>
  );
}
