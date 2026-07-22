import { useEffect, useState } from "react";
import { api, setCsrf } from "./lib/api.js";
import { Login } from "./pages/Login.js";
import { Dashboard } from "./pages/Dashboard.js";
import { Services } from "./pages/Services.js";
import { Libraries } from "./pages/Libraries.js";
import { Requests } from "./pages/Requests.js";
import { Intake } from "./pages/Intake.js";
import { Jobs } from "./pages/Jobs.js";

type Me = { authenticated: boolean; needsSetup: boolean; csrfToken: string | null };
const PAGES = ["Dashboard", "Requests", "Intake", "Jobs", "Services", "Libraries"] as const;
type Page = (typeof PAGES)[number];

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [page, setPage] = useState<Page>("Dashboard");

  const refresh = () => api<Me>("/api/auth/me").then((m) => { setMe(m); setCsrf(m.csrfToken); });
  useEffect(() => { refresh(); }, []);

  if (!me) return <div className="center muted">Loading…</div>;
  if (!me.authenticated) return <Login needsSetup={me.needsSetup} onDone={refresh} />;

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">Tor<span>HQ</span></div>
        <nav className="nav">
          {PAGES.map((p) => (
            <button key={p} className={p === page ? "active" : ""} onClick={() => setPage(p)}>{p}</button>
          ))}
          <button onClick={async () => { await api("/api/auth/logout", { method: "POST" }); refresh(); }}>Logout</button>
        </nav>
      </aside>
      <main className="main">
        {page === "Dashboard" && <Dashboard />}
        {page === "Requests" && <Requests />}
        {page === "Intake" && <Intake />}
        {page === "Jobs" && <Jobs />}
        {page === "Services" && <Services />}
        {page === "Libraries" && <Libraries />}
      </main>
    </div>
  );
}
