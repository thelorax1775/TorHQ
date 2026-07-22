import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb, getRaw } from "../server/src/db/index.js";
import { runMigrations, appliedVersions } from "../server/src/db/migrate.js";

const dirs: string[] = [];
function freshDb(): void {
  const dir = mkdtempSync(join(tmpdir(), "torhq-mig-"));
  dirs.push(dir);
  initDb(dir);
}
function tableExists(name: string): boolean {
  const r = getRaw().prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
  return !!r;
}

afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("forward-only migrations", () => {
  it("applies the baseline on a fresh database", () => {
    freshDb();
    runMigrations();
    expect(appliedVersions()).toEqual([1]);
    for (const t of ["users", "sessions", "services", "libraries", "jobs", "activity", "schema_migrations"]) {
      expect(tableExists(t)).toBe(true);
    }
  });

  it("is idempotent: re-running records nothing new", () => {
    freshDb();
    runMigrations();
    runMigrations();
    runMigrations();
    expect(appliedVersions()).toEqual([1]);
    const count = getRaw().prepare("SELECT COUNT(*) c FROM schema_migrations").get() as { c: number };
    expect(count.c).toBe(1);
  });

  it("records the baseline on a legacy DB (tables already present, no schema_migrations) without data loss", () => {
    freshDb();
    // Simulate a database deployed before schema_migrations existed: the tables
    // are already there (from the old CREATE IF NOT EXISTS bootstrap) and hold data.
    const db = getRaw();
    db.exec(`CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'admin',
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000))`);
    db.prepare("INSERT INTO users (username, password_hash) VALUES (?, ?)").run("legacy-admin", "hash");

    runMigrations();

    expect(appliedVersions()).toEqual([1]);
    // Pre-existing data survives (the baseline used IF NOT EXISTS, no rewrite).
    const user = db.prepare("SELECT username FROM users").get() as { username: string };
    expect(user.username).toBe("legacy-admin");
    // And the rest of the baseline tables now exist too.
    expect(tableExists("jobs")).toBe(true);
  });
});
