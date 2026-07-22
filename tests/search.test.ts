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
let cookie = "";
let csrf = "";

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "torhq-search-"));
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

  const reg = await app.inject({
    method: "POST", url: "/api/auth/register",
    payload: { username: "admin", password: "supersecret1" },
  });
  csrf = reg.json().csrfToken;
  cookie = reg.cookies[0]!.name + "=" + reg.cookies[0]!.value;
});
afterAll(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const auth = () => ({ cookie, "x-csrf-token": csrf });

describe("search + grab routes", () => {
  it("requires authentication", async () => {
    const r = await app.inject({ method: "GET", url: "/api/search?q=x" });
    expect(r.statusCode).toBe(401);
  });

  it("returns 409 when the torrent-search service is not configured", async () => {
    const r = await app.inject({ method: "GET", url: "/api/search?q=blade", headers: { cookie } });
    expect(r.statusCode).toBe(409);
  });

  it("returns 409 grabbing when qBittorrent is not configured", async () => {
    const r = await app.inject({
      method: "POST", url: "/api/search/grab", headers: auth(),
      payload: { magnet: "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567" },
    });
    expect(r.statusCode).toBe(409);
  });

  describe("with qBittorrent configured", () => {
    beforeAll(async () => {
      await app.inject({
        method: "POST", url: "/api/services", headers: auth(),
        // Unroutable port so a real add attempt fails fast rather than hanging.
        payload: { kind: "qbittorrent", label: "qb", baseUrl: "http://127.0.0.1:9", secret: "u:p" },
      });
    });

    it("rejects a grab without the CSRF header", async () => {
      const r = await app.inject({
        method: "POST", url: "/api/search/grab", headers: { cookie },
        payload: { magnet: "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567" },
      });
      expect(r.statusCode).toBe(403);
    });

    it("rejects a non-magnet URL (no SSRF via arbitrary URL)", async () => {
      const r = await app.inject({
        method: "POST", url: "/api/search/grab", headers: auth(),
        payload: { magnet: "http://169.254.169.254/latest/meta-data" },
      });
      expect(r.statusCode).toBe(400);
    });

    it("rejects a malformed magnet (no btih hash)", async () => {
      const r = await app.inject({
        method: "POST", url: "/api/search/grab", headers: auth(),
        payload: { magnet: "magnet:?dn=whatever" },
      });
      expect(r.statusCode).toBe(400);
    });

    it("rejects a category outside the allowlist", async () => {
      const r = await app.inject({
        method: "POST", url: "/api/search/grab", headers: auth(),
        payload: { magnet: "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567", category: "arbitrary" },
      });
      expect(r.statusCode).toBe(400);
    });

    it("accepts a valid magnet + category but surfaces the unreachable client as 502", async () => {
      const r = await app.inject({
        method: "POST", url: "/api/search/grab", headers: auth(),
        payload: { magnet: "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567", title: "X", category: "radarr" },
      });
      expect(r.statusCode).toBe(502); // validation passed; the add call failed to connect
    });
  });

  describe("with torrent-search configured", () => {
    beforeAll(async () => {
      await app.inject({
        method: "POST", url: "/api/services", headers: auth(),
        payload: { kind: "torrentsearch", label: "kat", baseUrl: "http://127.0.0.1:9" },
      });
    });

    it("validates the query (empty q rejected once the service exists)", async () => {
      const r = await app.inject({ method: "GET", url: "/api/search?q=", headers: { cookie } });
      expect(r.statusCode).toBe(400);
    });
  });
});
