import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ArrAdapter, ArrFlavor, ArrParseResult } from "../server/src/adapters/arr.js";
import type { GeminiAdapter, ReleaseGuess } from "../server/src/adapters/gemini.js";
import {
  identifyRelease, cachedIdentify, resetIdentifyCache, plausibleMatch,
} from "../server/src/lib/identify.js";

/**
 * A stand-in *arr. Only the two methods the ladder uses are real; anything else
 * being reached is a bug the test should surface as a crash.
 */
function fakeArr(service: ArrFlavor, opts: {
  parse?: ArrParseResult | null | Error;
  candidates?: Array<{ selectionId: string; title: string; year?: number; alreadyAdded?: boolean }>;
  lookupError?: boolean;
} = {}) {
  const parse = vi.fn(async () => {
    if (opts.parse instanceof Error) throw opts.parse;
    return opts.parse ?? null;
  });
  const searchCandidates = vi.fn(async () => {
    if (opts.lookupError) throw new Error("lookup down");
    return (opts.candidates ?? []).map((c) => ({
      selectionId: c.selectionId, title: c.title, year: c.year, alreadyAdded: !!c.alreadyAdded,
    }));
  });
  return { kind: service, parse, searchCandidates } as unknown as ArrAdapter & {
    parse: typeof parse; searchCandidates: typeof searchCandidates;
  };
}

function fakeGemini(guess: ReleaseGuess | null | Error) {
  const identify = vi.fn(async () => {
    if (guess instanceof Error) throw guess;
    return guess;
  });
  return { identify, model: "gemini-test" } as unknown as GeminiAdapter & { identify: typeof identify };
}

const parsed = (over: Partial<ArrParseResult> & { service: ArrFlavor }): ArrParseResult => ({
  title: "Some Title", matchedId: null, ...over,
});

beforeEach(() => resetIdentifyCache());

describe("the identification ladder", () => {
  it("stops at a library match and never reaches Gemini", async () => {
    // The whole point of the ladder's ordering: the *arr that will perform the
    // import has already tied this string to movie 244. Nothing further is
    // needed, and paying a model to second-guess it would be worse, not better.
    const radarr = fakeArr("radarr", {
      parse: parsed({ service: "radarr", title: "Avengers Endgame", year: 2019, matchedId: 244, matchedTitle: "Avengers: Endgame" }),
    });
    const gemini = fakeGemini({ kind: "movie", title: "wrong", confidence: 0.9 });

    const id = await identifyRelease("Avengers.Endgame.2019.1080p.BluRay", { arrs: { radarr }, gemini });

    expect(id.source).toBe("arr-parse");
    expect(id.service).toBe("radarr");
    expect(id.libraryId).toBe(244);
    expect(id.confidence).toBe(1);
    expect(gemini.identify).not.toHaveBeenCalled();
    // No lookup either — there is nothing to look up when it is already there.
    expect(radarr.searchCandidates).not.toHaveBeenCalled();
  });

  it("uses a parsed-but-unmatched title as the lookup term, still without Gemini", async () => {
    const radarr = fakeArr("radarr", {
      parse: parsed({ service: "radarr", title: "Dune Part Two", year: 2024 }),
      candidates: [{ selectionId: "tmdb:693134", title: "Dune: Part Two", year: 2024 }],
    });
    const gemini = fakeGemini({ kind: "movie", title: "nope", confidence: 1 });

    const id = await identifyRelease("Dune.Part.Two.2024.2160p", { arrs: { radarr }, gemini });

    expect(id.source).toBe("arr-parse");
    expect(id.libraryId).toBeNull();
    expect(radarr.searchCandidates).toHaveBeenCalledWith("Dune Part Two 2024");
    expect(id.candidates).toHaveLength(1);
    expect(gemini.identify).not.toHaveBeenCalled();
  });

  it("falls through to Gemini only when no *arr could read the name", async () => {
    const radarr = fakeArr("radarr", { parse: null, candidates: [{ selectionId: "tmdb:1", title: "Arrival", year: 2016 }] });
    const gemini = fakeGemini({ kind: "movie", title: "Arrival", year: 2016, confidence: 0.82, reasoning: "obfuscated name" });

    const id = await identifyRelease("xX_ARRVL_2O16_Xx", { arrs: { radarr }, gemini });

    expect(gemini.identify).toHaveBeenCalledOnce();
    expect(id.source).toBe("gemini");
    expect(id.service).toBe("radarr");
    expect(id.confidence).toBe(0.82);
    // Gemini produced a *search term*; the *arr's lookup produced the answer.
    expect(radarr.searchCandidates).toHaveBeenCalledWith("Arrival 2016");
    expect(id.candidates[0].title).toBe("Arrival");
  });

  it("routes each Gemini kind to the *arr that owns it", async () => {
    const sonarr = fakeArr("sonarr", { parse: null, candidates: [{ selectionId: "tvdb:1", title: "Severance" }] });
    const id = await identifyRelease("svrnc.s02", {
      arrs: { sonarr },
      gemini: fakeGemini({ kind: "tv", title: "Severance", season: 2, confidence: 0.7 }),
    });
    expect(id.service).toBe("sonarr");
    expect(id.seasonNumber).toBe(2);
  });

  it("reports honestly when Gemini is not configured", async () => {
    const radarr = fakeArr("radarr", { parse: null });
    const id = await identifyRelease("unreadable", { arrs: { radarr }, gemini: null });
    expect(id.source).toBe("none");
    expect(id.service).toBeNull();
    expect(id.detail).toMatch(/not configured/i);
  });

  it("treats a Gemini 'unknown' as no answer rather than inventing one", async () => {
    // parseGuess turns kind:'unknown' into null; the ladder must not then
    // manufacture a service for it.
    const radarr = fakeArr("radarr", { parse: null });
    const id = await identifyRelease("Some.Linux.ISO", { arrs: { radarr }, gemini: fakeGemini(null) });
    expect(id.source).toBe("none");
    expect(id.candidates).toEqual([]);
  });

  it("survives one *arr being down without losing another's answer", async () => {
    const radarr = fakeArr("radarr", { parse: new Error("radarr is down") });
    const sonarr = fakeArr("sonarr", {
      parse: parsed({ service: "sonarr", title: "Severance", seasonNumber: 2, matchedId: 12, matchedTitle: "Severance" }),
    });
    const id = await identifyRelease("Severance.S02E01", { arrs: { radarr, sonarr }, gemini: null });
    expect(id.service).toBe("sonarr");
    expect(id.libraryId).toBe(12);
  });

  it("still reports the parse when the lookup itself fails", async () => {
    const radarr = fakeArr("radarr", {
      parse: parsed({ service: "radarr", title: "Dune", year: 2021 }),
      lookupError: true,
    });
    const id = await identifyRelease("Dune.2021", { arrs: { radarr }, gemini: null });
    expect(id.source).toBe("arr-parse");
    expect(id.candidates).toEqual([]);
    expect(id.confidence).toBeLessThan(0.7); // read, but unconfirmed
    expect(id.detail).toMatch(/lookup returned nothing/i);
  });

  it("prefers a library match over a bare parse from another *arr", async () => {
    const radarr = fakeArr("radarr", { parse: parsed({ service: "radarr", title: "Ambiguous" }) });
    const sonarr = fakeArr("sonarr", {
      parse: parsed({ service: "sonarr", title: "Ambiguous", matchedId: 9, matchedTitle: "Ambiguous (2020)" }),
    });
    const id = await identifyRelease("Ambiguous.S01", { arrs: { radarr, sonarr }, gemini: null });
    expect(id.service).toBe("sonarr");
    expect(id.libraryId).toBe(9);
  });
});

describe("the identification cache", () => {
  it("does not re-run the ladder for a name it already answered", async () => {
    const radarr = fakeArr("radarr", {
      parse: parsed({ service: "radarr", title: "Dune", matchedId: 5, matchedTitle: "Dune" }),
    });
    const deps = { arrs: { radarr }, gemini: null };
    await cachedIdentify("Dune.2021.1080p", deps);
    await cachedIdentify("Dune.2021.1080p", deps);
    // The point is cost: a second look at the same page must not re-bill.
    expect(radarr.parse).toHaveBeenCalledOnce();
  });

  it("does not cache a failure, so an outage does not outlive itself", async () => {
    const down = fakeArr("radarr", { parse: new Error("down") });
    const deps = { arrs: { radarr: down }, gemini: null };
    const first = await cachedIdentify("Thing.2020", deps);
    expect(first.source).toBe("none");

    const up = fakeArr("radarr", {
      parse: parsed({ service: "radarr", title: "Thing", matchedId: 7, matchedTitle: "The Thing" }),
    });
    const second = await cachedIdentify("Thing.2020", { arrs: { radarr: up }, gemini: null });
    expect(second.libraryId).toBe(7);
  });
});

describe("plausibleMatch — a lookup's best effort is not automatically an answer", () => {
  it("accepts an exact or subtitle-extended match", () => {
    expect(plausibleMatch("Dune Part Two", "Dune: Part Two")).toBe(true);
    expect(plausibleMatch("Dune", "Dune: Part Two")).toBe(true);
    expect(plausibleMatch("Avengers Endgame", "Avengers: Endgame")).toBe(true);
  });

  it("rejects the real over-eager parses found against the live stack", () => {
    // Sonarr parses ANY string as a series title, so these all arrived looking
    // like clean answers with a one-click "add to library" button.
    expect(plausibleMatch("Ubuntu", "Rebellion!")).toBe(false);
    expect(plausibleMatch("brba complete", "You Complete Me")).toBe(false);
    expect(plausibleMatch("OK Computer Radiohead", "OK")).toBe(false);
  });

  it("is not fooled by one incidental word in common", () => {
    expect(plausibleMatch("The Matrix", "The Notebook")).toBe(false);
  });

  it("has no opinion when either side has no usable tokens", () => {
    expect(plausibleMatch("", "Dune")).toBe(false);
    expect(plausibleMatch("Dune", "")).toBe(false);
    expect(plausibleMatch("!!! ???", "Dune")).toBe(false);
  });
});

describe("the ladder does not stop on a parse that matched nothing", () => {
  it("falls through to Gemini when the parse produced no plausible candidate", async () => {
    // The Ubuntu case: Sonarr parses it, its lookup returns something unrelated,
    // and the gate rejects it. Stopping there would present junk as an answer.
    const sonarr = fakeArr("sonarr", {
      parse: parsed({ service: "sonarr", title: "Ubuntu" }),
      candidates: [{ selectionId: "tvdb:1", title: "Rebellion!" }],
    });
    const gemini = fakeGemini(null); // honestly declines: it is a Linux ISO

    const id = await identifyRelease("Ubuntu.24.04.LTS.desktop.amd64.iso", { arrs: { sonarr }, gemini });

    expect(gemini.identify).toHaveBeenCalledOnce();
    expect(id.source).toBe("none");
    expect(id.candidates).toEqual([]);
    // The rejected parse survives as context, so the explanation is not a shrug.
    expect(id.detail).toMatch(/Ubuntu/);
    expect(id.detail).toMatch(/matched nothing/);
  });

  it("lets Gemini rescue a name the parser read wrongly", async () => {
    const lidarr = fakeArr("lidarr", {
      parse: parsed({ service: "lidarr", title: "OK Computer Radiohead" }),
      candidates: [{ selectionId: "mbid:x", title: "Radiohead" }],
    });
    const id = await identifyRelease("OK.Computer.Radiohead.discography.FLAC", {
      arrs: { lidarr },
      gemini: fakeGemini({ kind: "music", title: "Radiohead", confidence: 0.9 }),
    });
    // The parse's own term found nothing plausible; Gemini's term did.
    expect(id.source).toBe("gemini");
    expect(id.candidates[0].title).toBe("Radiohead");
  });

  it("still prefers the parse when its lookup DID corroborate it", async () => {
    const radarr = fakeArr("radarr", {
      parse: parsed({ service: "radarr", title: "Dune Part Two", year: 2024 }),
      candidates: [{ selectionId: "tmdb:693134", title: "Dune: Part Two", year: 2024 }],
    });
    const gemini = fakeGemini({ kind: "movie", title: "nope", confidence: 1 });
    const id = await identifyRelease("Dune.Part.Two.2024", { arrs: { radarr }, gemini });
    expect(id.source).toBe("arr-parse");
    expect(gemini.identify).not.toHaveBeenCalled();
  });
});
