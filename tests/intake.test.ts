import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { initDb, getDb } from "../server/src/db/index.js";
import { runMigrations } from "../server/src/db/migrate.js";
import { deriveKey } from "../server/src/lib/crypto.js";
import { upsertLibrary } from "../server/src/config/store.js";
import { jobs } from "../server/src/db/schema.js";
import { previewIntake, runIntake } from "../server/src/queue/intake.js";
import { enqueue, Worker, getJob } from "../server/src/queue/queue.js";
import { PathValidationError } from "../server/src/security/paths.js";

let root: string;
let dataDir: string;
const masterKey = deriveKey("intake-test-master-key");

function libDir(...p: string[]) { return join(root, ...p); }

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "torhq-intake-"));
  dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(libDir("downloads"), { recursive: true });
  mkdirSync(libDir("staging", "manga"), { recursive: true });
  mkdirSync(libDir("libraries", "manga"), { recursive: true });

  initDb(dataDir);
  runMigrations();
  upsertLibrary({
    key: "kavita-manga", label: "Manga", kind: "manga", targetService: "kavita",
    destPath: libDir("libraries", "manga"), stagingPath: libDir("staging", "manga"), rescan: true,
  });
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

beforeEach(() => {
  // Clear the jobs table so each test starts clean.
  getDb().delete(jobs).run();
});

/** Create a source folder with a couple of files under downloads/. */
function makeSource(name: string): string {
  const src = libDir("downloads", name);
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, "ch1.cbz"), "chapter one");
  writeFileSync(join(src, "ch2.cbz"), "chapter two");
  return src;
}

describe("previewIntake", () => {
  it("lists entries and computes the destination without touching disk", async () => {
    const src = makeSource("Preview Series");
    const p = await previewIntake({ libraryKey: "kavita-manga", sourcePath: src }, [root]);
    expect(p.entries.map((e) => e.name).sort()).toEqual(["ch1.cbz", "ch2.cbz"]);
    expect(p.totalBytes).toBeGreaterThan(0);
    expect(p.destPath).toBe(libDir("libraries", "manga", "Preview Series"));
    // Preview must not move anything.
    expect(existsSync(src)).toBe(true);
    expect(existsSync(p.destPath)).toBe(false);
  });

  it("rejects a source that escapes approved roots", async () => {
    await expect(previewIntake({ libraryKey: "kavita-manga", sourcePath: "/etc/passwd" }, [root]))
      .rejects.toThrow(PathValidationError);
  });

  it("honors a safe targetName for the destination", async () => {
    const src = makeSource("raw-name");
    const p = await previewIntake({ libraryKey: "kavita-manga", sourcePath: src, targetName: "Clean Name" }, [root]);
    expect(p.destPath).toBe(libDir("libraries", "manga", "Clean Name"));
  });
});

describe("runIntake state machine", () => {
  it("stages then atomically imports, consuming the source and clearing staging", async () => {
    const src = makeSource("Real Series");
    const res = await runIntake("job-import", { libraryKey: "kavita-manga", sourcePath: src }, [root], masterKey);

    expect(res.alreadyImported).toBe(false);
    const dest = libDir("libraries", "manga", "Real Series");
    expect(res.destPath).toBe(dest);
    // Imported content is present at the destination.
    expect(readdirSync(dest).sort()).toEqual(["ch1.cbz", "ch2.cbz"]);
    // Source consumed.
    expect(existsSync(src)).toBe(false);
    // Staging left clean — no hidden .intake-* remnants.
    expect(readdirSync(libDir("staging", "manga"))).toEqual([]);
  });

  it("is idempotent: a second run with the destination present does not duplicate", async () => {
    const src = makeSource("Idem Series");
    await runIntake("job-1", { libraryKey: "kavita-manga", sourcePath: src }, [root], masterKey);

    // Re-create the source and run again with the same target — dest already there.
    const src2 = makeSource("Idem Series");
    const res = await runIntake("job-2", { libraryKey: "kavita-manga", sourcePath: src2 }, [root], masterKey);
    expect(res.alreadyImported).toBe(true);
    // Destination still has exactly the original two files.
    expect(readdirSync(libDir("libraries", "manga", "Idem Series")).sort()).toEqual(["ch1.cbz", "ch2.cbz"]);
    // The redundant source was cleaned up too.
    expect(existsSync(src2)).toBe(false);
  });

  it("succeeds idempotently when the source is already gone but the destination exists", async () => {
    // Pre-place a destination directly.
    const dest = libDir("libraries", "manga", "Ghost Series");
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, "vol1.cbz"), "x");
    const res = await runIntake(
      "job-ghost",
      { libraryKey: "kavita-manga", sourcePath: libDir("downloads", "Ghost Series") },
      [root], masterKey,
    );
    expect(res.alreadyImported).toBe(true);
  });

  it("throws a path error when neither source nor destination exists", async () => {
    await expect(runIntake(
      "job-missing",
      { libraryKey: "kavita-manga", sourcePath: libDir("downloads", "Nope") },
      [root], masterKey,
    )).rejects.toThrow(PathValidationError);
  });
});

describe("durable queue + worker", () => {
  it("enqueue is idempotent on idempotencyKey", () => {
    const a = enqueue({ type: "manual_intake", payload: { libraryKey: "kavita-manga", sourcePath: libDir("downloads", "x") }, idempotencyKey: "dup" });
    const b = enqueue({ type: "manual_intake", payload: { libraryKey: "kavita-manga", sourcePath: libDir("downloads", "y") }, idempotencyKey: "dup" });
    expect(a.id).toBe(b.id);
  });

  it("processes a queued job to completion", async () => {
    const src = makeSource("Worker Series");
    const job = enqueue({ type: "manual_intake", payload: { libraryKey: "kavita-manga", sourcePath: src } });
    const worker = new Worker([root], masterKey);
    await worker.tick();
    const done = getJob(job.id)!;
    expect(done.status).toBe("completed");
    expect(existsSync(libDir("libraries", "manga", "Worker Series"))).toBe(true);
  });

  it("recovers a job orphaned in 'running' by a prior crash", async () => {
    const src = makeSource("Crashed Series");
    const job = enqueue({ type: "manual_intake", payload: { libraryKey: "kavita-manga", sourcePath: src } });
    // Simulate a crash mid-process: the job is stuck in 'running'.
    getDb().update(jobs).set({ status: "running" }).where(eq(jobs.id, job.id)).run();

    const worker = new Worker([root], masterKey);
    const recovered = worker.recoverOrphans();
    expect(recovered).toBe(1);
    expect(getJob(job.id)!.status).toBe("queued");

    await worker.tick();
    expect(getJob(job.id)!.status).toBe("completed");
    expect(existsSync(libDir("libraries", "manga", "Crashed Series"))).toBe(true);
  });

  it("re-queues a failing job with backoff, then marks it dead at maxAttempts", async () => {
    // Non-existent source and no destination → each attempt fails.
    const job = enqueue({
      type: "manual_intake",
      payload: { libraryKey: "kavita-manga", sourcePath: libDir("downloads", "does-not-exist") },
      maxAttempts: 2,
    });
    const worker = new Worker([root], masterKey);

    await worker.tick(); // attempt 1 → back to queued
    let j = getJob(job.id)!;
    expect(j.attempts).toBe(1);
    expect(j.status).toBe("queued");
    expect(j.lastError).toBeTruthy();
    expect(j.nextRunAt).toBeGreaterThan(Date.now()); // backoff scheduled

    // Force it due again and run the final attempt.
    getDb().update(jobs).set({ nextRunAt: Date.now() - 1 }).where(eq(jobs.id, job.id)).run();
    await worker.tick(); // attempt 2 → dead
    j = getJob(job.id)!;
    expect(j.attempts).toBe(2);
    expect(j.status).toBe("dead");
  });
});
