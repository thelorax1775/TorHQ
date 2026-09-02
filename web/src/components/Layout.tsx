/**
 * App shell: persistent sidebar + sticky header, off-canvas drawer on narrow
 * screens. Navigation is real `<NavLink>`s, so every view is a deep link and
 * keyboard/browser navigation works without any custom handling.
 */
import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { ErrorBoundary } from "./ErrorBoundary.js";
import { Icon, type IconName } from "./Icon.js";
import { Button } from "./ui.js";
import { usePolled } from "../lib/usePolled.js";
import { speed } from "../lib/format.js";

interface NavItem { to: string; label: string; icon: IconName; end?: boolean }

export const NAV: Array<{ group: string; items: NavItem[] }> = [
  {
    group: "Overview",
    items: [{ to: "/", label: "Dashboard", icon: "dashboard", end: true }],
  },
  {
    group: "Acquire",
    items: [
      { to: "/get", label: "Get", icon: "plus" },
      { to: "/search", label: "Raw search", icon: "search" },
      { to: "/downloads", label: "Downloads", icon: "download" },
      { to: "/queue", label: "Queue", icon: "queue" },
      { to: "/requests", label: "Requests", icon: "star" },
    ],
  },
  {
    group: "Library",
    items: [
      { to: "/intake", label: "Intake", icon: "inbox" },
      { to: "/libraries", label: "Libraries", icon: "book" },
      { to: "/jobs", label: "Jobs & activity", icon: "clock" },
    ],
  },
  {
    group: "System",
    items: [
      { to: "/services", label: "Services", icon: "plug" },
      { to: "/mounts", label: "Mounts", icon: "server" },
      { to: "/settings", label: "Settings", icon: "settings" },
    ],
  },
];

/** Route → header title. Falls back to the nav label lookup. */
export function titleForPath(pathname: string): string {
  for (const g of NAV) {
    for (const item of g.items) {
      if (item.end ? pathname === item.to : pathname === item.to || pathname.startsWith(`${item.to}/`)) {
        return item.label;
      }
    }
  }
  return "TorHQ";
}

interface TransferSummary { transfer?: { dlspeed?: number; upspeed?: number } }

export function Layout({ onLogout }: { onLogout: () => void }) {
  const [navOpen, setNavOpen] = useState(false);
  const location = useLocation();

  // Close the drawer on navigation, and on Escape.
  useEffect(() => { setNavOpen(false); }, [location.pathname]);
  useEffect(() => {
    if (!navOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setNavOpen(false); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [navOpen]);

  // Global transfer readout. Shares the Downloads page's cache entry, and stays
  // hidden when qBittorrent isn't configured or the route isn't there yet.
  const transfer = usePolled<TransferSummary>("/api/downloads", 15000);
  const t = transfer.data?.transfer;

  return (
    <div className={`shell${navOpen ? " nav-open" : ""}`}>
      <aside className="sidebar" id="app-nav" aria-label="Main">
        <NavLink to="/" className="brand">
          <span className="mark"><Icon name="download" size={16} /></span>
          <span>Tor<em>HQ</em></span>
        </NavLink>

        <nav>
          {NAV.map((g) => (
            <div className="nav-group" key={g.group}>
              <div className="nav-group-label">{g.group}</div>
              {g.items.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  className={({ isActive }) => `nav-link${isActive ? " active" : ""}`}
                >
                  <Icon name={item.icon} size={16} />
                  {item.label}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>

        <div className="sidebar-foot">
          <button className="nav-link" style={{ width: "100%" }} onClick={onLogout}>
            <Icon name="logout" size={16} />
            Sign out
          </button>
        </div>
      </aside>

      {navOpen && <button className="scrim" aria-label="Close navigation" onClick={() => setNavOpen(false)} />}

      <div>
        <header className="topbar">
          <Button
            className="nav-toggle"
            variant="ghost"
            icon="menu"
            aria-label="Toggle navigation"
            aria-expanded={navOpen}
            aria-controls="app-nav"
            onClick={() => setNavOpen((v) => !v)}
          />
          <h1>{titleForPath(location.pathname)}</h1>
          <div className="spacer" />
          {t && (
            <div className="transfer-chip" title="qBittorrent transfer rates">
              <span className="dl"><Icon name="down" size={12} /> {speed(t.dlspeed ?? 0)}</span>
              <span className="ul"><Icon name="up" size={12} /> {speed(t.upspeed ?? 0)}</span>
            </div>
          )}
        </header>
        <main className="content">
          {/* Keyed on the path so navigating away clears a failed render, and so
              the boundary is scoped to one page rather than the whole session. */}
          <ErrorBoundary key={location.pathname}>
            <Outlet />
          </ErrorBoundary>
        </main>
      </div>
    </div>
  );
}
