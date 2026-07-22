import { useEffect, useState } from "react";
import { api } from "../lib/api.js";

const STATUS_CLASS: Record<string, string> = {
  completed: "ok", imported: "ok", failed: "err", dead: "err",
  queued: "warn", running: "warn",
};

export function Jobs() {
  const [jobs, setJobs] = useState<any[]>([]);
  const [activity, setActivity] = useState<any[]>([]);
  const [sel, setSel] = useState<any>(null);

  async function load() {
    setJobs((await api("/api/jobs")).jobs);
    setActivity((await api("/api/activity?limit=50")).activity);
  }
  useEffect(() => { load(); const t = setInterval(load, 8000); return () => clearInterval(t); }, []);

  async function open(id: string) { setSel(await api(`/api/jobs/${id}`)); }
  async function retry(id: string) { await api(`/api/jobs/${id}/retry`, { method: "POST" }); load(); }

  return (
    <div>
      <h1>Jobs & activity</h1>
      <div className="card">
        <h2>Jobs</h2>
        <table><thead><tr><th>Library</th><th>Source</th><th>Status</th><th>Attempts</th><th></th></tr></thead>
          <tbody>{jobs.map((j) => (
            <tr key={j.id}>
              <td>{j.libraryKey}</td>
              <td className="small" style={{ maxWidth: 300, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{j.sourcePath}</td>
              <td><span className={"badge " + (STATUS_CLASS[j.status] ?? "")}>{j.status}</span></td>
              <td className="muted">{j.attempts}/{j.maxAttempts}</td>
              <td className="flex">
                <button className="btn small" onClick={() => open(j.id)}>Log</button>
                {(j.status === "dead" || j.status === "failed") && <button className="btn small" onClick={() => retry(j.id)}>Retry</button>}
              </td>
            </tr>
          ))}</tbody>
        </table>
        {!jobs.length && <p className="muted small">No jobs yet.</p>}
      </div>

      {sel && (
        <div className="card">
          <h2>Job {sel.job.id.slice(0, 8)} — {sel.job.status}</h2>
          {sel.job.lastError && <p className="err-text small">{sel.job.lastError}</p>}
          {sel.activity.map((a: any) => (
            <div key={a.id} className="row"><span className="small">{a.kind}: {a.message}</span>
              <span className="muted small">{new Date(a.createdAt).toLocaleTimeString()}</span></div>
          ))}
        </div>
      )}

      <div className="card">
        <h2>Recent activity</h2>
        {activity.map((a) => (
          <div key={a.id} className="row">
            <span className="small"><span className="badge">{a.kind}</span> {a.message}</span>
            <span className="muted small">{new Date(a.createdAt).toLocaleTimeString()}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
