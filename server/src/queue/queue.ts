import { randomUUID } from "node:crypto";
import { and, asc, eq, lte, or } from "drizzle-orm";
import type { Buffer } from "node:buffer";
import { getDb } from "../db/index.js";
import { jobs, type Job } from "../db/schema.js";
import { logActivity } from "../lib/activity.js";
import { runIntake, type IntakePayload } from "./intake.js";

/**
 * Durable, SQLite-backed job queue with retries + exponential backoff and
 * idempotency keys. A single in-process worker leases due jobs. Survives
 * restarts because state lives in the DB, not memory.
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
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref?.();
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private claimNext(): Job | null {
    const db = getDb();
    const now = Date.now();
    const due = db.select().from(jobs)
      .where(and(or(eq(jobs.status, "queued"), eq(jobs.status, "running")), lte(jobs.nextRunAt, now)))
      .orderBy(asc(jobs.nextRunAt)).limit(1).get();
    if (!due) return null;
    // Atomic-ish lease: mark running only if still due.
    const res = db.update(jobs)
      .set({ status: "running", attempts: due.attempts + 1, updatedAt: now })
      .where(and(eq(jobs.id, due.id), lte(jobs.nextRunAt, now)))
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

export function listJobs(status?: string, limit = 100): Job[] {
  const db = getDb();
  const q = db.select().from(jobs);
  const rows = status
    ? q.where(eq(jobs.status, status)).limit(limit).all()
    : q.limit(limit).all();
  return rows.sort((a, b) => b.createdAt - a.createdAt);
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
