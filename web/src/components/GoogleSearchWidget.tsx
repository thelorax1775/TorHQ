/**
 * Google's Programmable Search Engine, embedded.
 *
 * This is the one place in TorHQ that loads third-party code and talks to a
 * service the server does not proxy: `cse.js` runs in the browser and the
 * queries typed here go straight from the viewer to Google, along with the
 * viewer's IP. That is inherent to the widget, and it is the trade that buys
 * the things the JSON API cannot give — no API key to store, no 100-queries-a-
 * day cap, and Google's own result rendering.
 *
 * The widget is mounted in "explicit" parse mode with the *searchresults-only*
 * layout, so TorHQ keeps its own search box and simply feeds the term in via
 * `execute()`. Letting Google render its own box would put a second, differently
 * behaved search field on a page that already has one.
 */
import { useEffect, useRef, useState } from "react";
import { Alert } from "./ui.js";

interface CseElement {
  execute(query: string): void;
}
interface CseApi {
  render(opts: { div: HTMLElement; tag: string; gname: string; attributes?: Record<string, unknown> }): void;
  getElement(gname: string): CseElement | undefined;
}
declare global {
  interface Window {
    __gcse?: { parsetags?: string; callback?: () => void };
    google?: { search?: { cse?: { element?: CseApi } } };
  }
}

/**
 * `cse.js` is a page-global singleton: it can be loaded once, for one engine
 * id, and there is no supported way to swap the id afterwards. Both facts are
 * tracked here rather than in component state, which resets on every mount.
 */
let loadPromise: Promise<void> | null = null;
let loadedCx: string | null = null;

function loadCse(cx: string): Promise<void> {
  if (loadPromise) return loadPromise;
  loadedCx = cx;
  loadPromise = new Promise<void>((resolve, reject) => {
    // Explicit parse mode: nothing renders until we ask, so the widget cannot
    // appear before the card that is supposed to contain it.
    window.__gcse = { parsetags: "explicit", callback: resolve };
    const script = document.createElement("script");
    script.async = true;
    script.src = `https://cse.google.com/cse.js?cx=${encodeURIComponent(cx)}`;
    script.onerror = () => reject(new Error(
      "Could not load Google's search widget from cse.google.com — check the network, " +
      "and whether an ad blocker or DNS filter is blocking it.",
    ));
    document.head.appendChild(script);
  });
  return loadPromise;
}

export function GoogleSearchWidget({ cx, query }: { cx: string; query: string }) {
  const host = useRef<HTMLDivElement>(null);
  // A fresh name per mount. Re-rendering into a new div under an old name leaves
  // the widget writing into the detached node React threw away on unmount.
  const gname = useRef(`torhq-web-${Math.random().toString(36).slice(2, 10)}`).current;
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const wrongCx = loadedCx !== null && loadedCx !== cx;

  useEffect(() => {
    if (wrongCx) return;
    let cancelled = false;
    loadCse(cx)
      .then(() => {
        if (cancelled || !host.current) return;
        const cse = window.google?.search?.cse?.element;
        if (!cse) throw new Error("Google's search widget loaded but did not initialise.");
        cse.render({
          div: host.current,
          tag: "searchresults-only",
          gname,
          // TorHQ owns the URL: letting the widget push its own history entries
          // would make Back step through Google's state instead of the app's.
          attributes: { enableHistory: "false" },
        });
        setReady(true);
      })
      .catch((e: unknown) => { if (!cancelled) setError((e as Error).message); });
    return () => { cancelled = true; };
  }, [cx, gname, wrongCx]);

  useEffect(() => {
    if (!ready || !query.trim()) return;
    window.google?.search?.cse?.element?.getElement(gname)?.execute(query);
  }, [ready, query, gname]);

  if (wrongCx) {
    return (
      <Alert tone="warn" title="Reload to switch search engines">
        The search-engine id changed since this page loaded. Google's widget can only be loaded once per page,
        so reload TorHQ to use the new one.
      </Alert>
    );
  }
  if (error) return <Alert tone="err" title="Google widget unavailable">{error}</Alert>;

  return (
    <>
      {!ready && <p className="small muted">Loading Google's search widget…</p>}
      {/* Google styles the results itself and only ships a light theme, so the
          host keeps a light surface rather than letting dark mode half-apply. */}
      <div className="gcse-host" ref={host} />
    </>
  );
}
