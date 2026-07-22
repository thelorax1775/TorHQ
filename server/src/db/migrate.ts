import { getRaw, initDb } from "./index.js";
import { loadEnv } from "../config/env.js";

/**
 * Idempotent schema bootstrap. For v1 we ship plain SQL DDL (IF NOT EXISTS) so
 * install works without drizzle-kit at runtime. The Drizzle schema in schema.ts
 * is the source of truth; this DDL mirrors it and is safe to run repeatedly.
 */
const DDL = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin',
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  csrf_token TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);
CREATE TABLE IF NOT EXISTS services (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  base_url TEXT NOT NULL,
  secret_enc TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  extra_json TEXT,
  last_healthy INTEGER,
  last_status TEXT,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE TABLE IF NOT EXISTS libraries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  kind TEXT NOT NULL,
  target_service TEXT NOT NULL,
  dest_path TEXT NOT NULL,
  staging_path TEXT NOT NULL,
  rescan INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  idempotency_key TEXT UNIQUE,
  library_key TEXT,
  source_path TEXT NOT NULL,
  payload_json TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  next_run_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  last_error TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX IF NOT EXISTS jobs_status_idx ON jobs(status);
CREATE INDEX IF NOT EXISTS jobs_next_idx ON jobs(next_run_at);
CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT,
  kind TEXT NOT NULL,
  service TEXT,
  message TEXT NOT NULL,
  data_json TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX IF NOT EXISTS activity_job_idx ON activity(job_id);
CREATE INDEX IF NOT EXISTS activity_created_idx ON activity(created_at);
`;

export function runMigrations(): void {
  const raw = getRaw();
  raw.exec(DDL);
}

// Allow `npm run migrate` standalone.
if (import.meta.url === `file://${process.argv[1]}`) {
  const env = loadEnv();
  initDb(env.TORHQ_DATA_DIR);
  runMigrations();
  // eslint-disable-next-line no-console
  console.log("TorHQ migrations applied at", env.TORHQ_DATA_DIR);
}
