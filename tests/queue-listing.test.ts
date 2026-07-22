import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb, getDb } from "../server/src/db/index.js";
import { runMigrations } from "../server/src/db/migrate.js";
import { jobs } from "../server/src/db/schema.js";
import { listJobs } from "../server/src/queue/queue.js";

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "torhq-listing-"));
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true });
  initDb(dataDir);
  runMigrations();
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

/**
 * Insert `n` jobs with strictly increasing createdAt so "newest" is unambiguous.
 * Inserted oldest-first, which is also SQLite's natural rowid order - the order
 * an unordered SELECT ... LIMIT hands back.
 */
function seed(n: number, status = "queued") {
  const db = getDb();
  db.delete(jobs).run();
  const base = 1_700_000_000_000;
  for (let i = 0; i < n; i++) {
    db.insert(jobs).values({
      id: `job-${String(i).padStart(4, "0")}`,
      type: "manual_intake",
      status,
      sourcePath: `/srv/torhq/downloads/item-${i}`,
      payloadJson: "{}",
      createdAt: base + i * 1000,
      updatedAt: base + i * 1000,
      nextRunAt: base + i * 1000,
    }).run();
  }
}

describe("listJobs pagination", () => {
  it("returns the NEWEST jobs when more than `limit` exist", () => {
    seed(150);
    const rows = listJobs(undefined, 100);
    expect(rows).toHaveLength(100);
    expect(rows[0]!.id).toBe("job-0149");
    expect(rows.map((r) => r.id)).not.toContain("job-0000");
  });

  it("applies the newest-first window to a status filter too", () => {
    seed(150, "dead");
    const rows = listJobs("dead", 100);
    expect(rows).toHaveLength(100);
    expect(rows[0]!.id).toBe("job-0149");
    expect(rows.map((r) => r.id)).not.toContain("job-0000");
  });

  it("still sorts newest-first when everything fits in one page", () => {
    seed(5);
    const rows = listJobs(undefined, 100);
    expect(rows.map((r) => r.id)).toEqual([
      "job-0004", "job-0003", "job-0002", "job-0001", "job-0000",
    ]);
  });
});
