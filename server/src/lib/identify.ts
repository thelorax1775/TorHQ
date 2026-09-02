import type { ArrAdapter, ArrCandidateWithService, ArrFlavor, ArrParseResult } from "../adapters/arr.js";
import type { GeminiAdapter } from "../adapters/gemini.js";

/**
 * Work out what a raw torrent release name actually is, so the Raw search page
 * can offer to route it into the right *arr.
 *
 * The order of the ladder is the whole design:
 *
 *   1. **Each *arr's own `/parse`.** Free, deterministic, and authoritative —
 *      it is the same parser that will perform the import, so a library match
 *      here is a guarantee rather than an opinion. It resolves the large
 *      majority of real release names, including ones carrying a transliterated
 *      title alongside the English one.
 *   2. **A parse with no library match** still yields a good search term, so
 *      that goes straight into the *arr's lookup for candidates.
 *   3. **Gemini, only for what step 1 could not read at all.**
 *
 * Gemini never decides. It converts a mangled string into a search term; the
 * *arr's own lookup produces the candidates and a person confirms. That is what
 * keeps a hallucination to a bad suggestion instead of the wrong film imported
 * under someone else's name and renamed to match.
 */

/** Which *arr owns each kind the model can return. */
const KIND_TO_SERVICE: Record<string, ArrFlavor> = { movie: "radarr", tv: "sonarr", music: "lidarr" };

/**
 * Preference when more than one *arr claims a name. Each *arr only parses its
 * own domain, so this is rare; it exists so the outcome is defined rather than
 * dependent on which promise settled first.
 */
const SERVICE_ORDER: ArrFlavor[] = ["radarr", "sonarr", "lidarr"];

export type IdentifySource = "arr-parse" | "gemini" | "none";

export interface Identification {
  /** The release name this is about, echoed so batch answers can be matched up. */
  release: string;
  source: IdentifySource;
  /** Which *arr should own it; null when nothing could identify it. */
  service: ArrFlavor | null;
  title?: string;
  year?: number;
  /** Sonarr only. */
  seasonNumber?: number;
  /**
   * Set when the *arr already has this in its library. This is the strong case:
   * a grab under that *arr's category will import, with no add step needed.
   */
  libraryId: number | null;
  libraryTitle?: string;
  /** Lookup candidates when it is NOT already in the library — the user picks. */
  candidates: ArrCandidateWithService[];
  /** 1 for a library match; the model's own estimate for a Gemini answer. */
  confidence: number;
  /** Short human explanation, including whose answer this is. */
  detail: string;
}

export interface IdentifyDeps {
  /** The configured *arrs, in whatever subset actually exists. */
  arrs: Partial<Record<ArrFlavor, ArrAdapter>>;
  /** Absent when Gemini is not configured — the ladder simply stops earlier. */
  gemini?: GeminiAdapter | null;
  /** Test seam. */
  now?: () => number;
}

/** Nothing could read it. A first-class outcome, not an error. */
function unidentified(release: string, detail: string): Identification {
  return { release, source: "none", service: null, libraryId: null, candidates: [], confidence: 0, detail };
}

/**
 * Run every configured *arr's parser over one name. Failures are per-service:
 * a Lidarr that is down must not stop Radarr from identifying a film.
 */
async function parseAll(
  arrs: IdentifyDeps["arrs"], release: string,
): Promise<ArrParseResult[]> {
  const entries = SERVICE_ORDER.map((s) => [s, arrs[s]] as const).filter(([, a]) => !!a);
  const settled = await Promise.allSettled(entries.map(([, a]) => a!.parse(release)));
  const out: ArrParseResult[] = [];
  settled.forEach((r) => {
    if (r.status === "fulfilled" && r.value && r.value.title.trim()) out.push(r.value);
  });
  // Defined order regardless of which promise settled first.
  return out.sort((a, b) => SERVICE_ORDER.indexOf(a.service) - SERVICE_ORDER.indexOf(b.service));
}

/** Search term for an *arr lookup: the title, plus the year when we have one. */
function lookupTerm(title: string, year?: number): string {
  return year ? `${title} ${year}` : title;
}

async function candidatesFor(
  arr: ArrAdapter | undefined, service: ArrFlavor, term: string,
): Promise<ArrCandidateWithService[]> {
  if (!arr) return [];
  try {
    return (await arr.searchCandidates(term)).slice(0, 8).map((c) => ({ ...c, service }));
  } catch {
    // A failed lookup weakens the answer; it does not invalidate the parse that
    // produced the term, which is still worth showing.
    return [];
  }
}

/**
 * Identify one release name. Never throws: every outcome, including "no idea",
 * is a returned Identification, because this runs per-row over a page of search
 * results and one unreadable name must not fail the batch.
 */
export async function identifyRelease(
  release: string, deps: IdentifyDeps,
): Promise<Identification> {
  const name = release.trim();
  if (!name) return unidentified(release, "empty release name");

  // --- 1. the *arrs' own parsers ------------------------------------------
  let parsed: ArrParseResult[] = [];
  try {
    parsed = await parseAll(deps.arrs, name);
  } catch {
    parsed = [];
  }

  const matched = parsed.find((p) => p.matchedId != null);
  if (matched) {
    // The strong case. The *arr that will do the import has already tied this
    // exact string to a library entry, so no lookup and no model is needed.
    return {
      release, source: "arr-parse", service: matched.service,
      title: matched.matchedTitle ?? matched.title,
      year: matched.year,
      seasonNumber: matched.seasonNumber,
      libraryId: matched.matchedId,
      libraryTitle: matched.matchedTitle,
      candidates: [],
      confidence: 1,
      detail: `${matched.service} matched this to "${matched.matchedTitle ?? matched.title}" in its library`,
    };
  }

  const readable = parsed.find((p) => p.title.trim());
  if (readable) {
    // Parsed, but not in the library — the parsed title is a good lookup term.
    const term = lookupTerm(readable.title, readable.year);
    const candidates = await candidatesFor(deps.arrs[readable.service], readable.service, term);
    return {
      release, source: "arr-parse", service: readable.service,
      title: readable.title,
      year: readable.year,
      seasonNumber: readable.seasonNumber,
      libraryId: null,
      candidates,
      // Read cleanly, but nothing has confirmed which work it is yet.
      confidence: candidates.length ? 0.7 : 0.4,
      detail: candidates.length
        ? `${readable.service} parsed this as "${term}" — not in your library yet`
        : `${readable.service} parsed this as "${term}", but its lookup returned nothing`,
    };
  }

  // --- 3. Gemini, and only now --------------------------------------------
  if (!deps.gemini) {
    return unidentified(release, "no *arr could parse this name, and Gemini is not configured");
  }

  let guess;
  try {
    guess = await deps.gemini.identify(name);
  } catch (e) {
    return unidentified(release, `no *arr could parse this name, and Gemini failed: ${(e as Error).message}`);
  }
  if (!guess) {
    return unidentified(release, "neither the *arr parsers nor Gemini could identify this");
  }

  const service = KIND_TO_SERVICE[guess.kind];
  if (!service) return unidentified(release, "Gemini could not tell what kind of thing this is");

  const term = lookupTerm(guess.title, guess.year);
  const candidates = await candidatesFor(deps.arrs[service], service, term);
  return {
    release, source: "gemini", service,
    title: guess.title,
    year: guess.year,
    seasonNumber: guess.season,
    libraryId: null,
    candidates,
    confidence: guess.confidence,
    detail: candidates.length
      ? `Gemini read this as "${term}"${guess.reasoning ? ` — ${guess.reasoning}` : ""}`
      : `Gemini read this as "${term}", but ${service}'s lookup returned nothing`,
  };
}

/**
 * A small cache, because the Raw search page identifies every visible row and a
 * re-render, a poll or a second look at the same search must not re-run the
 * ladder — and above all must not re-bill a Gemini call. Keyed by the exact
 * release name, which is what the ladder is a pure function of.
 */
const TTL_MS = 30 * 60 * 1000;
const cache = new Map<string, { at: number; value: Identification }>();

export function cachedIdentify(
  release: string, deps: IdentifyDeps,
): Promise<Identification> {
  const now = deps.now?.() ?? Date.now();
  const hit = cache.get(release);
  if (hit && now - hit.at < TTL_MS) return Promise.resolve({ ...hit.value, release });
  return identifyRelease(release, deps).then((value) => {
    // Don't cache a failure caused by a service being momentarily down — it
    // would outlive the outage and keep reporting "unidentified" afterwards.
    if (value.source !== "none") cache.set(release, { at: now, value });
    return value;
  });
}

/** Test seam. */
export function resetIdentifyCache(): void {
  cache.clear();
}
