import { useState } from "react";
import { api, setCsrf } from "../lib/api.js";

export function Login({ needsSetup, onDone }: { needsSetup: boolean; onDone: () => void }) {
  const [username, setU] = useState("");
  const [password, setP] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      const path = needsSetup ? "/api/auth/register" : "/api/auth/login";
      const r = await api<{ csrfToken: string }>(path, { method: "POST", body: JSON.stringify({ username, password }) });
      setCsrf(r.csrfToken);
      onDone();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <div className="center">
      <form className="card login" onSubmit={submit}>
        <div className="brand">Tor<span>HQ</span></div>
        <h2>{needsSetup ? "Create admin account" : "Sign in"}</h2>
        <label>Username</label>
        <input value={username} onChange={(e) => setU(e.target.value)} autoFocus />
        <label>Password</label>
        <input type="password" value={password} onChange={(e) => setP(e.target.value)} />
        {err && <p className="err-text small">{err}</p>}
        <div style={{ marginTop: 14 }}>
          <button className="btn primary" disabled={busy}>{needsSetup ? "Create & continue" : "Sign in"}</button>
        </div>
        {needsSetup && <p className="muted small" style={{ marginTop: 10 }}>Password must be at least 8 characters.</p>}
      </form>
    </div>
  );
}
