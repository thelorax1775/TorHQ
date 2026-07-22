import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, lte } from "drizzle-orm";
import type { Buffer } from "node:buffer";
import { getDb } from "../db/index.js";
import { jobs, type Job } from "../db/schema.js";
import { logActivity } from "../lib/activity.js";
import { runIntake, type IntakePayload } from "./intake.js";

/**
 * Durable, SQLite-backed job queue with retries + exponential backoff and
 * idempotency keys.
 *
 * Deployment model: exactly one in-process worker (the documented single-process
 * LXC service). Correctness rests on two things:
 *  1. Ticks never overlap — `tick()` is guarded by an in-flight flag and awaits
 *     `process()`, so only one job runs at a time and a job can't be claimed
 *     twice while it is being processed.
 *  2. Crash recovery is explicit — on start we re-queue any job left in
 *     `running` by a previous crash (safe because, at startup, nothing is
 *     actually running). The claim query then only ever selects `queued` jobs.
 * State lives in the DB, so the queue survives restarts; runIntake is idempotent
 * so a recovered job that had already been committed completes as a no-op.
 */
export interface EnqueueInput {
  type: "manual_intake";
  payload: IntakePayload;
  idempotencyKey?: string;
  maxAttempts?: number;
}

export function enqueue(input: EnqueueInput): Job {
  const db = getDb();
  if (input.idempotencyKey) {
    const existing = db.select().from(jobs).where(eq(jobs.idempotencyKey, input.idempotencyKey)).get();
    if (existing) return existing; // idempotent: return the prior job
  }
  const id = randomUUID();
  db.insert(jobs).values({
    id,
    type: input.type,
    status: "queued",
    idempotencyKey: input.idempotencyKey ?? null,
    libraryKey: input.payload.libraryKey,
    sourcePath: input.payload.sourcePath,
    payloadJson: JSON.stringify(input.payload),
    maxAttempts: input.maxAttempts ?? 5,
  }).run();
  logActivity({ kind: "queued", jobId: id, message: `Queued ${input.type} for ${input.payload.libraryKey}` });
  return db.select().from(jobs).where(eq(jobs.id, id)).get()!;
}

function backoffMs(attempt: number): number {
  return Math.min(60_000 * 2 ** (attempt - 1), 60 * 60_000); // cap 1h
}

export class Worker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  constructor(
    private approvedRoots: string[],
    private masterKey: Buffer,
    private intervalMs = 3000,
  ) {}

  start(): void {
    if (this.timer) return;
    this.recoverOrphans();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref?.();
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Re-queue jobs left `running` by a previous crash. Safe to call only when no
   * job is actually in flight (i.e. at startup) — in the single-process model
   * that is guaranteed. A recovered job keeps its attempt count; runIntake's
   * idempotency makes reprocessing safe.
   */
  recoverOrphans(): number {
    const db = getDb();
    const res = db.update(jobs)
      .set({ status: "queued", nextRunAt: Date.now(), updatedAt: Date.now() })
      .where(eq(jobs.status, "running"))
      .run();
    return res.changes;
  }

  private claimNext(): Job | null {
    const db = getDb();
    const now = Date.now();
    const due = db.select().from(jobs)
      .where(and(eq(jobs.status, "queued"), lte(jobs.nextRunAt, now)))
      .orderBy(asc(jobs.nextRunAt)).limit(1).get();
    if (!due) return null;
    // Lease the job: flip queued -> running only if it is still queued and due.
    // With non-overlapping ticks this is the sole claimant; the guarded WHERE
    // keeps it correct even if this were ever called re-entrantly.
    const res = db.update(jobs)
      .set({ status: "running", attempts: due.attempts + 1, updatedAt: now })
      .where(and(eq(jobs.id, due.id), eq(jobs.status, "queued")))
      .run();
    return res.changes > 0 ? { ...due, status: "running", attempts: due.attempts + 1 } : null;
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const job = this.claimNext();
      if (!job) return;
      await this.process(job);
    } finally {
      this.running = false;
    }
  }

  private async process(job: Job): Promise<void> {
    const db = getDb();
    try {
      const payload = JSON.parse(job.payloadJson ?? "{}") as IntakePayload;
      if (job.type === "manual_intake") {
        await runIntake(job.id, payload, this.approvedRoots, this.masterKey);
      } else {
        throw new Error(`Unknown job type: ${job.type}`);
      }
      db.update(jobs).set({ status: "completed", updatedAt: Date.now(), lastError: null }).where(eq(jobs.id, job.id)).run();
    } catch (err) {
      const message = (err as Error).message;
      const dead = job.attempts >= job.maxAttempts;
      db.update(jobs).set({
        status: dead ? "dead" : "queued",
        lastError: message,
        nextRunAt: Date.now() + backoffMs(job.attempts),
        updatedAt: Date.now(),
      }).where(eq(jobs.id, job.id)).run();
      logActivity({
        kind: "failed", jobId: job.id,
        message: dead ? `Job dead after ${job.attempts} attempts: ${message}` : `Attempt ${job.attempts} failed: ${message}`,
      });
    }
  }
}

/**
 * Most recent jobs first, newest-first ordering applied *in SQL* so that LIMIT
 * selects the newest page. Previously the limit was applied to an unordered
 * SELECT and the page was sorted afterwards in JS, which meant that once the
 * table held more than `limit` rows the API returned the OLDEST jobs and newly
 * queued work never appeared in /api/jobs or /api/status/failures.
 */
export function listJobs(status?: string, limit = 100): Job[] {
  const db = getDb();
  const base = db.select().from(jobs);
  const filtered = status ? base.where(eq(jobs.status, status)) : base;
  return filtered.orderBy(desc(jobs.createdAt)).limit(limit).all();
}

export function getJob(id: string): Job | undefined {
  return getDb().select().from(jobs).where(eq(jobs.id, id)).get();
}

export function retryJob(id: string): Job | undefined {
  const db = getDb();
  db.update(jobs).set({ status: "queued", nextRunAt: Date.now(), attempts: 0, lastError: null, updatedAt: Date.now() })
    .where(eq(jobs.id, id)).run();
  return getJob(id);
}
