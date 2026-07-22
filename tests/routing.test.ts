import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { initDb } from "../server/src/db/index.js";
import { runMigrations } from "../server/src/db/migrate.js";
import { loadEnv } from "../server/src/config/env.js";
import { makeContext } from "../server/src/lib/context.js";
import { buildApp } from "../server/src/app.js";

let app: FastifyInstance;
let dataDir: string;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "torhq-db-"));
  const env = loadEnv({
    NODE_ENV: "test",
    TORHQ_MASTER_KEY: "test-master-key-0123456789",
    TORHQ_DATA_DIR: dataDir,
    TORHQ_APPROVED_ROOTS: dataDir,
  } as any);
  initDb(env.TORHQ_DATA_DIR);
  runMigrations();
  app = await buildApp(makeContext(env));
  await app.ready();
});
afterAll(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("authorization", () => {
  it("health is public", async () => {
    const r = await app.inject({ method: "GET", url: "/health" });
    expect(r.statusCode).toBe(200);
  });
  it("blocks unauthenticated access to protected routes", async () => {
    const r = await app.inject({ method: "GET", url: "/api/services" });
    expect(r.statusCode).toBe(401);
  });
  it("reports needsSetup before any admin exists", async () => {
    const r = await app.inject({ method: "GET", url: "/api/auth/me" });
    expect(r.json().needsSetup).toBe(true);
  });
});

describe("auth flow + CSRF", () => {
  let cookie = "";
  let csrf = "";
  it("registers the first admin", async () => {
    const r = await app.inject({
      method: "POST", url: "/api/auth/register",
      payload: { username: "admin", password: "supersecret1" },
    });
    expect(r.statusCode).toBe(200);
    csrf = r.json().csrfToken;
    cookie = r.cookies[0].name + "=" + r.cookies[0].value;
    expect(csrf).toBeTruthy();
  });
  it("refuses a second registration", async () => {
    const r = await app.inject({
      method: "POST", url: "/api/auth/register",
      payload: { username: "x", password: "supersecret1" },
    });
    expect(r.statusCode).toBe(409);
  });
  it("allows authed read with the session cookie", async () => {
    const r = await app.inject({ method: "GET", url: "/api/services", headers: { cookie } });
    expect(r.statusCode).toBe(200);
  });
  it("rejects a mutating request without the CSRF header", async () => {
    const r = await app.inject({
      method: "POST", url: "/api/services", headers: { cookie },
      payload: { kind: "radarr", label: "Radarr", baseUrl: "http://localhost:7878", secret: "k" },
    });
    expect(r.statusCode).toBe(403);
  });
  it("accepts a mutating request with a valid CSRF header", async () => {
    const r = await app.inject({
      method: "POST", url: "/api/services",
      headers: { cookie, "x-csrf-token": csrf },
      payload: { kind: "radarr", label: "Radarr", baseUrl: "http://localhost:7878", secret: "k" },
    });
    expect(r.statusCode).toBe(200);
  });
  it("never returns full secrets to the client", async () => {
    const r = await app.inject({ method: "GET", url: "/api/services", headers: { cookie } });
    const svc = r.json().services.find((s: any) => s.kind === "radarr");
    expect(svc.secretMask).not.toContain("k");
    expect(svc.secretMask).toMatch(/•/);
  });
  it("rejects logout without the CSRF header", async () => {
    const r = await app.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie } });
    expect(r.statusCode).toBe(403);
  });
  it("accepts logout with a valid CSRF header", async () => {
    const r = await app.inject({
      method: "POST", url: "/api/auth/logout",
      headers: { cookie, "x-csrf-token": csrf },
    });
    expect(r.statusCode).toBe(200);
  });
});

describe("intake path validation via API", () => {
  let cookie = "", csrf = "";
  beforeAll(async () => {
    const r = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "supersecret1" } });
    csrf = r.json().csrfToken;
    cookie = r.cookies[0].name + "=" + r.cookies[0].value;
    await app.inject({
      method: "POST", url: "/api/libraries", headers: { cookie, "x-csrf-token": csrf },
      payload: { key: "kavita-books", label: "Books", kind: "books", targetService: "kavita",
        destPath: join(dataDir, "libraries", "books"), stagingPath: join(dataDir, "staging", "books") },
    });
  });
  it("rejects an intake source that escapes approved roots", async () => {
    const r = await app.inject({
      method: "POST", url: "/api/intake/preview", headers: { cookie, "x-csrf-token": csrf },
      payload: { libraryKey: "kavita-books", sourcePath: "/etc/passwd" },
    });
    expect(r.statusCode).toBe(400);
  });
  it("rejects a library destPath outside approved roots", async () => {
    const r = await app.inject({
      method: "POST", url: "/api/libraries", headers: { cookie, "x-csrf-token": csrf },
      payload: { key: "bad", label: "Bad", kind: "books", targetService: "kavita",
        destPath: "/etc/evil", stagingPath: "/etc/evil" },
    });
    expect(r.statusCode).toBe(400);
  });
});
