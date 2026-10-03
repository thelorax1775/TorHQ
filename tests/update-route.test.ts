import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { initDb } from "../server/src/db/index.js";
import { runMigrations } from "../server/src/db/migrate.js";
import { loadEnv } from "../server/src/config/env.js";
import { makeContext } from "../server/src/lib/context.js";
import { buildApp } from "../server/src/app.js";
import { isBusy } from "../server/src/lib/updater.js";

let app: FastifyInstance;
let dataDir: string;
let unitPath: string;
let cookie = "", csrf = "";
let memberCookie = "", memberCsrf = "";

const updateDir = () => join(dataDir, "update");
const post = (url: string, c = cookie, t = csrf) =>
  app.inject({ method: "POST", url, headers: { cookie: c, "x-csrf-token": t } });

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "torhq-update-"));
  unitPath = join(dataDir, "torhq-update.path");
  const env = loadEnv({
    NODE_ENV: "test",
    TORHQ_MASTER_KEY: "test-master-key-0123456789",
    TORHQ_DATA_DIR: dataDir,
    TORHQ_APPROVED_ROOTS: dataDir,
    TORHQ_UPDATE_UNIT: unitPath,
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
  cookie = reg.cookies[0].name + "=" + reg.cookies[0].value;

  await app.inject({
    method: "POST", url: "/api/users",
    headers: { cookie, "x-csrf-token": csrf },
    payload: { username: "friend", password: "friendpass1" },
  });
  const login = await app.inject({
    method: "POST", url: "/api/auth/login",
    payload: { username: "friend", password: "friendpass1" },
  });
  memberCsrf = login.json().csrfToken;
  memberCookie = login.cookies[0].name + "=" + login.cookies[0].value;
});
afterAll(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("web UI self-update", () => {
  it("reports the updater as unavailable and refuses to queue until it is installed", async () => {
    const view = await app.inject({ method: "GET", url: "/api/system/update", headers: { cookie } });
    expect(view.statusCode).toBe(200);
    expect(view.json()).toMatchObject({ available: false, pending: null, status: { state: "idle" }, log: [] });

    const res = await post("/api/system/update/apply");
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/not installed/);
    expect(existsSync(join(updateDir(), "request"))).toBe(false);
  });

  it("keeps members and CSRF-less requests out", async () => {
    writeFileSync(unitPath, "");
    expect((await app.inject({ method: "GET", url: "/api/system/update", headers: { cookie: memberCookie } })).statusCode).toBe(403);
    expect((await post("/api/system/update/apply", memberCookie, memberCsrf)).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/api/system/update/apply", headers: { cookie } })).statusCode).toBe(403);
    expect(existsSync(join(updateDir(), "request"))).toBe(false);
  });

  it("writes a request file for the helper and refuses a second one while it is queued", async () => {
    const res = await post("/api/system/update/check");
    expect(res.statusCode).toBe(202);
    expect(readFileSync(join(updateDir(), "request"), "utf8").trim()).toBe("check");
    expect(res.json().pending).toMatchObject({ action: "check", stale: false });

    const again = await post("/api/system/update/apply");
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toMatch(/already queued/);
    rmSync(join(updateDir(), "request"));
  });

  it("refuses while a run is in progress and surfaces the helper's status and log", async () => {
    mkdirSync(updateDir(), { recursive: true });
    writeFileSync(join(updateDir(), "status.json"), JSON.stringify({
      state: "running", action: "apply", step: "build", startedAt: Date.now(), updatedAt: Date.now(),
    }));
    writeFileSync(join(updateDir(), "update.log"), "line one\nline two\n");

    const res = await post("/api/system/update/apply");
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/in progress/);

    const view = (await app.inject({ method: "GET", url: "/api/system/update", headers: { cookie } })).json();
    expect(view.status).toMatchObject({ state: "running", step: "build" });
    expect(view.log).toEqual(["line one", "line two"]);
  });

  it("treats a run that stopped reporting long ago as finished", () => {
    const now = Date.now();
    expect(isBusy({ state: "running", updatedAt: now - 1000 }, now)).toBe(true);
    expect(isBusy({ state: "running", updatedAt: now - 60 * 60_000 }, now)).toBe(false);
    expect(isBusy({ state: "done", updatedAt: now }, now)).toBe(false);
  });
});
