import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import type { ArrRelease } from "../server/src/adapters/arr.js";
import { startSearch, getSearch, viewOf, resetSearches } from "../server/src/lib/releaseSearch.js";

function release(over: Partial<ArrRelease> = {}): ArrRelease {
  return {
    guid: "g", indexerId: 1, indexer: "ix", title: "t", size: 1,
    seeders: 10, leechers: 0, protocol: "torrent",
    rejected: false, rejections: [],
    ...over,
  };
}

/** Let the detached promise inside startSearch settle. */
const settle = () => new Promise((r) => setImmediate(r));

beforeEach(() => resetSearches());
afterEach(() => vi.useRealTimers());

describe("release search jobs", () => {
  it("returns a running job immediately, without waiting for the search", async () => {
    let finish: (r: ArrRelease[]) => void = () => {};
    const job = startSearch("radarr", "Endgame", () => new Promise((res) => { finish = res; }));

    // The whole point: the caller gets a token while the *arr is still working.
    expect(job.status).toBe("running");
    expect(viewOf(job).releases).toBeNull();

    finish([release()]);
    await settle();
    expect(getSearch(job.id)!.status).toBe("done");
  });

  it("captures the release list when the search finishes", async () => {
    const job = startSearch("radarr", "Endgame", async () => [release({ title: "one" })]);
    await settle();
    const view = viewOf(getSearch(job.id)!);
    expect(view.status).toBe("done");
    expect(view.releases).toHaveLength(1);
    expect(view.error).toBeNull();
  });

  it("captures a failure onto the job instead of letting it become an unhandled rejection", async () => {
    const job = startSearch("sonarr", "Severance", async () => { throw new Error("indexer exploded"); });
    await settle();
    const view = viewOf(getSearch(job.id)!);
    expect(view.status).toBe("error");
    expect(view.error).toBe("indexer exploded");
    expect(view.releases).toBeNull();
  });

  it("puts grabbable releases above rejected ones, then sorts by seeders", async () => {
    const job = startSearch("radarr", "x", async () => [
      release({ guid: "rejected-high", rejected: true, rejections: ["nope"], seeders: 900 }),
      release({ guid: "ok-low", seeders: 5 }),
      release({ guid: "ok-high", seeders: 100 }),
    ]);
    await settle();
    // A release the profile refused must never outrank one it would have taken,
    // however well seeded it is.
    expect(viewOf(getSearch(job.id)!).releases!.map((r) => r.guid))
      .toEqual(["ok-high", "ok-low", "rejected-high"]);
  });

  it("sorts an unknown seeder count below a known one", async () => {
    const job = startSearch("radarr", "x", async () => [
      release({ guid: "usenet", seeders: null }),
      release({ guid: "torrent", seeders: 1 }),
    ]);
    await settle();
    expect(viewOf(getSearch(job.id)!).releases!.map((r) => r.guid)).toEqual(["torrent", "usenet"]);
  });

  it("is unknown for a token that was never issued", () => {
    expect(getSearch("00000000-0000-0000-0000-000000000000")).toBeNull();
  });

  it("fails a search that never came back rather than leaving it running forever", async () => {
    vi.useFakeTimers();
    const job = startSearch("radarr", "hung", () => new Promise(() => {})); // never settles
    vi.setSystemTime(Date.now() + 6 * 60 * 1000);
    const found = getSearch(job.id)!;
    expect(found.status).toBe("error");
    expect(found.error).toMatch(/did not finish/i);
  });

  it("forgets a finished job once its TTL is up", async () => {
    vi.useFakeTimers();
    const job = startSearch("radarr", "x", async () => [release()]);
    await vi.advanceTimersByTimeAsync(0);
    expect(getSearch(job.id)).not.toBeNull();
    vi.setSystemTime(Date.now() + 16 * 60 * 1000);
    expect(getSearch(job.id)).toBeNull();
  });
});
