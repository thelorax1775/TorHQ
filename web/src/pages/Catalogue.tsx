/**
 * Catalogue — browse what's out there, instead of searching for what you
 * already know the name of.
 *
 * Movies and TV come from TMDB, games from RAWG. The page only *shows* things;
 * getting one hands off to the flow that already does it properly:
 *
 *   movie / tv  -> Get (admin) or Requests (member), with the exact title
 *                  pre-selected, so the *arr adds, grabs, imports and files it.
 *   game        -> Raw search over Prowlarr's game categories, grabbing into
 *                  `torhq-games`. Nothing imports a game — there is no *arr
 *                  for them — and the detail panel says so before you click.
 *
 * Every filter lives in the URL, so a view is a link you can bookmark or send.
 */
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { usePolled } from "../lib/usePolled.js";
import {
  Alert, Async, Badge, Button, Card, EmptyState, LinkButton, Modal, PageHeader, Skeleton, StaleNotice, cx,
} from "../components/ui.js";
import { Icon, type IconName } from "../components/Icon.js";

type Kind = "movie" | "tv" | "game";
type Role = "admin" | "member" | null;

interface SourceInfo { available: boolean; source: string; detail?: string; lists: string[] }
interface SourcesResponse {
  kinds: Record<Kind, SourceInfo>;
  platforms: Array<{ id: number; name: string }>;
}
interface Genre { id: string; name: string }

interface Item {
  kind: Kind;
  id: string;
  title: string;
  year?: number;
  released?: string;
  overview?: string;
  poster?: string;
  backdrop?: string;
  rating?: number;
  votes?: number;
  genres: string[];
  platforms?: string[];
  selectionId?: string;
  inLibrary?: boolean;
}
interface Detail extends Item {
  runtime?: number;
  seasons?: number;
  status?: string;
  homepage?: string;
  developers?: string[];
  sourceUrl?: string;
}
interface BrowseResponse { kind: Kind; items: Item[]; page: number; totalPages: number; libraryChecked: boolean }

const KIND_DEFS: Array<{ id: Kind; label: string; icon: IconName }> = [
  { id: "movie", label: "Movies", icon: "star" },
  { id: "tv", label: "TV shows", icon: "queue" },
  { id: "game", label: "Games", icon: "grid" },
];

const LIST_LABEL: Record<string, string> = {
  trending: "Trending",
  popular: "Popular",
  top_rated: "Top rated",
  upcoming: "Upcoming",
  now_playing: "In cinemas",
  on_the_air: "On the air",
  new: "New releases",
};

/** Newznab's top-level Console and PC categories — where games live on every indexer. */
const GAME_CATEGORIES = "1000,4000";

/**
 * Release names drop the punctuation a store title is full of, so a search for
 * "Baldur's Gate 3" or "Hades II™" finds fewer releases than it should.
 */
export function releaseSearchTerm(title: string): string {
  return title.replace(/[™®©]/g, "").replace(/[:'’!?]/g, "").replace(/\s+/g, " ").trim();
}

/** Where "get this" goes for a given title and viewer. Null when there is nowhere. */
export function handoffFor(item: Item, role: Role): { to: string; label: string; icon: IconName } | null {
  if (item.kind === "game") {
    if (role !== "admin") return null;
    const q = encodeURIComponent(releaseSearchTerm(item.title));
    return {
      to: `/search?source=prowlarr&q=${q}&categories=${GAME_CATEGORIES}&target=games`,
      label: "Find releases",
      icon: "search",
    };
  }
  const params = new URLSearchParams({ q: item.title });
  if (item.selectionId) params.set("pick", item.selectionId);
  if (role === "admin") {
    params.set("service", item.kind === "movie" ? "radarr" : "sonarr");
    return { to: `/get?${params}`, label: item.inLibrary ? "Get releases" : "Get", icon: "download" };
  }
  params.set("route", item.kind);
  return { to: `/requests?${params}`, label: "Request", icon: "send" };
}

export function Catalogue({ role }: { role: Role }) {
  const [params, setParams] = useSearchParams();
  const kind = (["movie", "tv", "game"].includes(params.get("kind") ?? "") ? params.get("kind") : "movie") as Kind;
  const list = params.get("list") ?? "trending";
  const genre = params.get("genre") ?? "";
  const platform = params.get("platform") ?? "";
  const q = params.get("q") ?? "";
  const page = Math.max(1, Number(params.get("page") ?? "1") || 1);

  const [term, setTerm] = useState(q);
  useEffect(() => { setTerm(q); }, [q]);
  const [open, setOpen] = useState<Item | null>(null);

  const sourcesQ = usePolled<SourcesResponse>("/api/catalogue/sources", 0);
  const source = sourcesQ.data?.kinds[kind];
  const available = source?.available ?? false;

  const genresQ = usePolled<{ genres: Genre[] }>(available ? `/api/catalogue/genres?kind=${kind}` : null, 0);

  const browsePath = (() => {
    if (!available) return null;
    const p = new URLSearchParams({ kind, page: String(page) });
    if (q) p.set("q", q);
    else {
      p.set("list", list);
      if (genre) p.set("genre", genre);
    }
    if (kind === "game" && platform) p.set("platform", platform);
    return `/api/catalogue/browse?${p}`;
  })();
  const browseQ = usePolled<BrowseResponse>(browsePath, 0);

  /** Change some filters; any change but paging goes back to page one. */
  function update(next: Record<string, string | null>) {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) {
      if (v) p.set(k, v); else p.delete(k);
    }
    if (!("page" in next)) p.delete("page");
    setParams(p);
  }

  function chooseKind(k: Kind) {
    // Lists, genres and platforms mean different things per kind; start clean.
    setParams(new URLSearchParams({ kind: k }));
  }

  function runSearch() {
    update({ q: term.trim() || null });
  }

  const lists = source?.lists ?? [];

  return (
    <>
      <PageHeader
        title="Catalogue"
        subtitle={role === "admin"
          ? "Browse what's trending, popular and coming soon. Movies and shows go through Get, so their *arr downloads, imports and files them. Games go to a Prowlarr search."
          : "Browse what's trending, popular and coming soon, and request the movies and shows you want."}
      />

      <Card flush>
        <div className="tabs" role="group" aria-label="What are you browsing?">
          {KIND_DEFS.map((k) => (
            <button
              key={k.id}
              type="button"
              className={cx("tab", kind === k.id && "active")}
              aria-pressed={kind === k.id}
              onClick={() => chooseKind(k.id)}
            >
              <Icon name={k.icon} size={14} />
              {k.label}
            </button>
          ))}
        </div>

        {sourcesQ.data && !available ? (
          <div className="card-body">
            <Alert
              tone="info"
              title={`${KIND_DEFS.find((k) => k.id === kind)!.label} aren't set up yet`}
              actions={role === "admin" ? <LinkButton to="/services" icon="plug" size="sm">Open Services</LinkButton> : undefined}
            >
              {role === "admin"
                ? source?.detail
                : `Browsing ${KIND_DEFS.find((k) => k.id === kind)!.label.toLowerCase()} needs a ${source?.source} key, which only the admin can add.`}
            </Alert>
          </div>
        ) : (
          <>
            <div className="toolbar">
              <div className="searchbar grow" style={{ minWidth: 200 }}>
                <Icon name="search" size={14} />
                <input
                  className="input"
                  value={term}
                  placeholder={kind === "game" ? "Search games" : kind === "tv" ? "Search TV shows" : "Search movies"}
                  onChange={(e) => setTerm(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") runSearch(); }}
                  aria-label="Search the catalogue"
                />
              </div>
              <Button variant="primary" icon="search" onClick={runSearch}>Search</Button>
              {q && <Button variant="ghost" icon="close" onClick={() => { setTerm(""); update({ q: null }); }}>Clear</Button>}
            </div>

            {!q && (
              <div className="toolbar">
                {lists.map((l) => (
                  <button
                    key={l}
                    type="button"
                    className={cx("chip", list === l && "on")}
                    aria-pressed={list === l}
                    onClick={() => update({ list: l })}
                  >
                    {LIST_LABEL[l] ?? l}
                  </button>
                ))}
                <span className="grow" />
                <label className="small muted" htmlFor="cat-genre">Genre</label>
                <select
                  id="cat-genre"
                  className="select input-sm"
                  style={{ width: "auto" }}
                  value={genre}
                  onChange={(e) => update({ genre: e.target.value || null })}
                  disabled={!genresQ.data}
                >
                  <option value="">Any</option>
                  {genresQ.data?.genres.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                </select>
              </div>
            )}

            {kind === "game" && sourcesQ.data && (
              <div className="toolbar">
                <span className="small muted">Platform</span>
                <button
                  type="button"
                  className={cx("chip", !platform && "on")}
                  aria-pressed={!platform}
                  onClick={() => update({ platform: null })}
                >
                  Any
                </button>
                {sourcesQ.data.platforms.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className={cx("chip", platform === String(p.id) && "on")}
                    aria-pressed={platform === String(p.id)}
                    onClick={() => update({ platform: String(p.id) })}
                  >
                    {p.name}
                  </button>
                ))}
              </div>
            )}

            {!sourcesQ.data ? (
              <div className="card-body"><Skeleton rows={4} /></div>
            ) : (
              <Async q={browseQ} what="the catalogue" skeleton={<div className="card-body"><Skeleton rows={6} /></div>}>
                {(data) => (
                  data.items.length === 0 ? (
                    <div className="card-body">
                      <EmptyState
                        icon="search"
                        title="Nothing here"
                        message={q ? `${source?.source} has nothing matching "${q}".` : "Nothing matches these filters. Try another list or genre."}
                      />
                    </div>
                  ) : (
                    <>
                      <div className={cx("catalogue-grid", kind === "game" && "wide")}>
                        {data.items.map((item) => (
                          <PosterCard key={`${item.kind}:${item.id}`} item={item} onOpen={() => setOpen(item)} />
                        ))}
                      </div>
                      {data.totalPages > 1 && (
                        <div className="pager">
                          <Button size="sm" disabled={page <= 1} onClick={() => update({ page: String(page - 1) })}
                            aria-label="Previous page">Previous</Button>
                          <span className="small muted num">Page {data.page} of {data.totalPages}</span>
                          <Button size="sm" disabled={page >= data.totalPages} onClick={() => update({ page: String(page + 1) })}
                            aria-label="Next page">Next</Button>
                        </div>
                      )}
                    </>
                  )
                )}
              </Async>
            )}
          </>
        )}
      </Card>

      {browsePath && <StaleNotice q={browseQ} />}

      <p className="xs dim mt-3">
        Film and TV data from TMDB, game data from RAWG. Posters load directly from their image servers.
        This product uses the TMDB API but is not endorsed or certified by TMDB.
      </p>

      {open && <DetailDialog item={open} role={role} onClose={() => setOpen(null)} />}
    </>
  );
}

function PosterCard({ item, onOpen }: { item: Item; onOpen: () => void }) {
  const [broken, setBroken] = useState(false);
  return (
    <button type="button" className="cat-card" onClick={onOpen} aria-label={`${item.title}${item.year ? ` (${item.year})` : ""}`}>
      <div className="cat-art">
        {item.poster && !broken
          ? <img src={item.poster} alt="" loading="lazy" onError={() => setBroken(true)} />
          : <Icon name={item.kind === "game" ? "grid" : "star"} size={28} />}
        {item.inLibrary && <Badge tone="ok">✓ In library</Badge>}
        {item.rating ? <span className="cat-rating">★ {item.rating.toFixed(1)}</span> : null}
      </div>
      <div className="cat-meta">
        <span className="cat-title clamp-2">{item.title}</span>
        <span className="xs muted truncate">
          {[item.year, item.kind === "game" ? item.platforms?.slice(0, 3).join(" · ") : item.genres.slice(0, 2).join(", ")]
            .filter(Boolean).join(" · ") || " "}
        </span>
      </div>
    </button>
  );
}

function DetailDialog({ item, role, onClose }: { item: Item; role: Role; onClose: () => void }) {
  const detailQ = usePolled<{ item: Detail }>(`/api/catalogue/details?kind=${item.kind}&id=${item.id}`, 0);
  // Show what the list row already knows while the detail loads, then upgrade.
  const d: Detail = detailQ.data?.item ?? item;
  const handoff = handoffFor(d, role);
  const facts = [
    d.released,
    d.runtime ? `${d.runtime} min` : null,
    d.seasons ? `${d.seasons} season${d.seasons === 1 ? "" : "s"}` : null,
    d.status && d.status !== "Released" ? d.status : null,
  ].filter(Boolean);

  return (
    <Modal
      wide
      title={<>{d.title}{d.year ? <span className="muted"> ({d.year})</span> : null}</>}
      onClose={onClose}
      labelledBy="catalogue-detail-title"
      footer={
        <>
          {d.sourceUrl && (
            <a className="btn" href={d.sourceUrl} target="_blank" rel="noreferrer noopener">
              <Icon name="external" size={15} /> View on {d.kind === "game" ? "RAWG" : "TMDB"}
            </a>
          )}
          {handoff && (
            // Wait for the detail on TV: only it carries the TVDB id that lets Get
            // pre-select the exact show.
            d.kind === "tv" && !detailQ.data && !detailQ.error
              ? <Button variant="primary" icon={handoff.icon} disabled>{handoff.label}</Button>
              : <LinkButton to={handoff.to} variant="primary" icon={handoff.icon}>{handoff.label}</LinkButton>
          )}
        </>
      }
    >
      {d.backdrop && <img className="cat-backdrop" src={d.backdrop} alt="" />}
      <div className="row mb-2">
        {d.inLibrary && <Badge tone="ok">In your library</Badge>}
        {d.rating ? <Badge tone="accent">★ {d.rating.toFixed(1)}{d.votes ? ` · ${d.votes.toLocaleString()} votes` : ""}</Badge> : null}
        {d.genres.map((g) => <Badge key={g}>{g}</Badge>)}
      </div>
      {facts.length > 0 && <div className="small muted mb-2">{facts.join(" · ")}</div>}
      {d.platforms && d.platforms.length > 0 && <div className="small mb-2"><strong>Platforms:</strong> {d.platforms.join(", ")}</div>}
      {d.developers && d.developers.length > 0 && <div className="small mb-2"><strong>Developer:</strong> {d.developers.join(", ")}</div>}
      {detailQ.error && <Alert tone="warn" title="Couldn't load full details">{detailQ.error.message}</Alert>}
      {d.overview
        ? <p style={{ whiteSpace: "pre-line" }}>{d.overview}</p>
        : !detailQ.data && !detailQ.error ? <Skeleton rows={3} /> : <p className="muted">No description available.</p>}

      {d.kind === "game" && role === "admin" && (
        <Alert tone="info" title="Games aren't imported automatically">
          No *arr manages games. <strong>Find releases</strong> searches Prowlarr&rsquo;s game categories, and a grab lands in
          qBittorrent under <code>torhq-games</code>. Where it goes from there is up to you.
        </Alert>
      )}
      {d.kind === "game" && role !== "admin" && (
        <Alert tone="info" title="Games can't be requested">
          Only movies and shows can be requested here. Ask the admin if you want this one.
        </Alert>
      )}
      {d.kind !== "game" && role === "admin" && !d.inLibrary && (
        <div className="small muted">
          <Icon name="info" size={12} /> <strong>Get</strong> opens with this title chosen. You confirm the folder and profile, then pick a release.
        </div>
      )}
    </Modal>
  );
}
