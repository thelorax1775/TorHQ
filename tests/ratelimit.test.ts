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
  dataDir = mkdtempSync(join(tmpdir(), "torhq-rl-"));
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

describe("rate limiting", () => {
  it("does not throttle the SPA session probe at the credential budget", async () => {
    // The SPA calls /api/auth/me on every page load. Reloading a dozen times
    // must not start returning 429.
    for (let i = 0; i < 30; i++) {
      const r = await app.inject({ method: "GET", url: "/api/auth/me" });
      expect(r.statusCode, `probe #${i + 1} was throttled`).toBe(200);
    }
  });

  it("leaves the login budget intact after many session probes", async () => {
    for (let i = 0; i < 30; i++) {
      await app.inject({ method: "GET", url: "/api/auth/me" });
    }
    // A real login attempt must still be served, not rejected with 429.
    const r = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "nobody", password: "wrong-password" },
    });
    expect(r.statusCode).not.toBe(429);
    expect(r.statusCode).toBe(401); // reached the handler: bad creds, not throttled
  });

  it("still throttles repeated credential guessing", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 16; i++) {
      const r = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: "nobody", password: "guess-guess-guess" },
      });
      codes.push(r.statusCode);
    }
    expect(codes).toContain(429); // brute-force protection is still in force
  });
});
