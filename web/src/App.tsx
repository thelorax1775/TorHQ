/**
 * Auth gate + route table.
 *
 * The gate deliberately wraps the router rather than redirecting: an
 * unauthenticated user sees the login/setup screen at whatever URL they asked
 * for, and once the session exists the same URL renders. Deep links therefore
 * survive both a reload and a sign-in.
 */
import { useCallback, useEffect, useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { api, apiSend, errorMessage, setCsrf, setUnauthorizedHandler } from "./lib/api.js";
import { resetCache } from "./lib/usePolled.js";
import { Layout } from "./components/Layout.js";
import { Button, Card } from "./components/ui.js";
import { Login } from "./pages/Login.js";
import { Dashboard } from "./pages/Dashboard.js";
import { Acquire } from "./pages/Acquire.js";
import { Search } from "./pages/Search.js";
import { Downloads } from "./pages/Downloads.js";
import { Queue } from "./pages/Queue.js";
import { Requests } from "./pages/Requests.js";
import { Intake } from "./pages/Intake.js";
import { Jobs } from "./pages/Jobs.js";
import { Libraries } from "./pages/Libraries.js";
import { Mounts } from "./pages/Mounts.js";
import { Services } from "./pages/Services.js";
import { Settings } from "./pages/Settings.js";
import { NotFound } from "./pages/NotFound.js";

interface Me { authenticated: boolean; needsSetup: boolean; csrfToken: string | null }

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const m = await api<Me>("/api/auth/me");
      setMe(m);
      setCsrf(m.csrfToken);
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  // Any 401 from anywhere in the app drops us back to the login screen instead
  // of leaving a half-dead UI polling a dead session.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      setCsrf(null);
      setMe((prev) => (prev?.authenticated ? { ...prev, authenticated: false, csrfToken: null } : prev));
    });
    return () => setUnauthorizedHandler(null);
  }, []);

  const logout = useCallback(async () => {
    try { await apiSend("/api/auth/logout", "POST"); } catch { /* session may already be gone */ }
    setCsrf(null);
    resetCache();
    await refresh();
  }, [refresh]);

  if (error && !me) {
    return (
      <div className="auth-screen">
        <div className="auth-card">
          <Card title="Can't reach the TorHQ server">
            <p className="muted small">{error}</p>
            <Button variant="primary" icon="refresh" onClick={() => { setError(null); void refresh(); }}>
              Retry
            </Button>
          </Card>
        </div>
      </div>
    );
  }

  if (!me) {
    return (
      <div className="auth-screen">
        <div className="muted">Loading…</div>
      </div>
    );
  }

  if (!me.authenticated) {
    return <Login needsSetup={me.needsSetup} onDone={refresh} />;
  }

  return (
    <Routes>
      <Route element={<Layout onLogout={logout} />}>
        <Route path="/" element={<Dashboard />} />
        <Route path="/get" element={<Acquire />} />
        <Route path="/search" element={<Search />} />
        <Route path="/downloads" element={<Downloads />} />
        <Route path="/queue" element={<Queue />} />
        <Route path="/requests" element={<Requests />} />
        <Route path="/intake" element={<Intake />} />
        <Route path="/jobs" element={<Jobs />} />
        <Route path="/libraries" element={<Libraries />} />
        <Route path="/mounts" element={<Mounts />} />
        <Route path="/services" element={<Services />} />
        <Route path="/settings" element={<Settings />} />
        {/* Legacy hash-free aliases from the prototype's page names. */}
        <Route path="/dashboard" element={<Navigate to="/" replace />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
