import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import * as schema from "./schema.js";

export type DB = BetterSQLite3Database<typeof schema>;

let _db: DB | null = null;
let _raw: Database.Database | null = null;

export function initDb(dataDir: string): DB {
  const dbPath = join(dataDir, "torhq.db");
  mkdirSync(dirname(dbPath), { recursive: true });
  const raw = new Database(dbPath);
  raw.pragma("journal_mode = WAL");
  raw.pragma("foreign_keys = ON");
  raw.pragma("busy_timeout = 5000");
  _raw = raw;
  _db = drizzle(raw, { schema });
  return _db;
}

export function getDb(): DB {
  if (!_db) throw new Error("DB not initialized; call initDb() first");
  return _db;
}

export function getRaw(): Database.Database {
  if (!_raw) throw new Error("DB not initialized");
  return _raw;
}

export { schema };
