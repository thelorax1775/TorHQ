import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";

// Drive the download client and the *arr from stubs: the routes are the thing
// under test, and nothing here touches the network.
const { getAdapter } = vi.hoisted(() => ({ getAdapter: vi.fn() }));
vi.mock("../server/src/adapters/registry.js", () => ({
  getAdapter,
  checkAllHealth: vi.fn(async () => ({})),
  testConfig: vi.fn(async () => ({ healthy: true })),
}));

const { initDb } = await import("../server/src/db/index.js");
const { runMigrations } = await import("../server/src/db/migrate.js");
const { loadEnv } = await import("../server/src/config/env.js");
const { makeContext } = await import("../server/src/lib/context.js");
const { buildApp } = await import("../server/src/app.js");
const { recentActivity } = await import("../server/src/lib/activity.js");

const HASH = "0123456789abcdef0123456789abcdef01234567";
const HASH2 = "89abcdef89abcdef89abcdef89abcdef89abcdef";

let app: FastifyInstance;
let dataDir: string;
let cookie = "";
let csrf = "";

/** Adapters the mocked registry hands back, per test. */
let adapters: Record<string, any> = {};

function qbStub(over: Record<string, any> = {}) {
  return {
    torrents: vi.fn(async () => [{
      hash: HASH, name: "Blade Runner 2049", category: "radarr", state: "downloading",
      progress: 0.42, dlspeed: 1048576, upspeed: 0, size: 8589934592, eta: 3600,
      savePath: "/downloads/radarr", ratio: 0.1, addedOn: 1784950000, tags: [],
    }]),
    transferInfo: vi.fn(async () => ({ dl_info_speed: 1048576, up_info_speed: 65536 })),
    categories: vi.fn(async () => ({ radarr: { name: "radarr", savePath: "/downloads/radarr" } })),
    pause: vi.fn(async () => {}),
    resume: vi.fn(async () => {}),
    recheck: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    deleteWithFiles: vi.fn(async () => {}),
    topPriority: vi.fn(async () => {}),
    bottomPriority: vi.fn(async () => {}),
    setCategory: vi.fn(async () => {}),
    ...over,
  };
}

function arrStub(service: string, items: any[]) {
  return {
    queue: vi.fn(async () => items.map((i) => ({
      service, statusMessages: [], size: 0, sizeleft: 0, status: "downloading", ...i,
    }))),
    processDownloads: vi.fn(async () => {}),
    removeFromQueue: vi.fn(async () => {}),
  };
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "torhq-downloads-"));
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

beforeEach(() => {
  adapters = {};
  getAdapter.mockImplementation((kind: string) => adapters[kind] ?? null);
});

const auth = () => ({ cookie, "x-csrf-token": csrf });

describe("GET /api/downloads", () => {
  it("requires authentication", async () => {
    const r = await app.inject({ method: "GET", url: "/api/downloads" });
    expect(r.statusCode).toBe(401);
  });

  it("409s when qBittorrent is not configured", async () => {
    const r = await app.inject({ method: "GET", url: "/api/downloads", headers: { cookie } });
    expect(r.statusCode).toBe(409);
  });

  it("returns torrents with the richer fields, transfer totals and categories", async () => {
    adapters.qbittorrent = qbStub();
    const r = await app.inject({ method: "GET", url: "/api/downloads", headers: { cookie } });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.torrents[0]).toMatchObject({
      hash: HASH, savePath: "/downloads/radarr", ratio: 0.1, addedOn: 1784950000, tags: [],
    });
    // qBittorrent's wire names are normalized to the contract's.
    expect(body.transfer).toEqual({ dlspeed: 1048576, upspeed: 65536 });
    expect(body.categories.radarr.savePath).toBe("/downloads/radarr");
  });

  it("502s when the client is unreachable", async () => {
    adapters.qbittorrent = qbStub({ torrents: vi.fn(async () => { throw new Error("ECONNREFUSED"); }) });
    const r = await app.inject({ method: "GET", url: "/api/downloads", headers: { cookie } });
    expect(r.statusCode).toBe(502);
    expect(r.json().error).toMatch(/ECONNREFUSED/);
  });
});

describe("POST /api/downloads/action", () => {
  beforeEach(() => { adapters.qbittorrent = qbStub(); });

  it("rejects a request without the CSRF header", async () => {
    const r = await app.inject({
      method: "POST", url: "/api/downloads/action", headers: { cookie },
      payload: { hashes: [HASH], action: "pause" },
    });
    expect(r.statusCode).toBe(403);
  });

  it("rejects an action outside the allowlist", async () => {
    for (const action of ["move", "setLocation", "rename", "__proto__"]) {
      const r = await app.inject({
        method: "POST", url: "/api/downloads/action", headers: auth(),
        payload: { hashes: [HASH], action },
      });
      expect(r.statusCode, action).toBe(400);
    }
    expect(adapters.qbittorrent.pause).not.toHaveBeenCalled();
  });

  it("rejects hashes that are not hex info-hashes", async () => {
    for (const bad of ["not-a-hash", "0123", `${HASH}|${HASH2}`, "../../etc/passwd"]) {
      const r = await app.inject({
        method: "POST", url: "/api/downloads/action", headers: auth(),
        payload: { hashes: [bad], action: "pause" },
      });
      expect(r.statusCode, bad).toBe(400);
    }
  });

  it("passes a validated batch through to the adapter", async () => {
    const r = await app.inject({
      method: "POST", url: "/api/downloads/action", headers: auth(),
      payload: { hashes: [HASH, HASH2], action: "pause" },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true, action: "pause", count: 2 });
    expect(adapters.qbittorrent.pause).toHaveBeenCalledWith([HASH, HASH2]);
  });

  it("requires a known category for setCategory", async () => {
    const bad = await app.inject({
      method: "POST", url: "/api/downloads/action", headers: auth(),
      payload: { hashes: [HASH], action: "setCategory", category: "somewhere-else" },
    });
    expect(bad.statusCode).toBe(400);
    expect(adapters.qbittorrent.setCategory).not.toHaveBeenCalled();

    const missing = await app.inject({
      method: "POST", url: "/api/downloads/action", headers: auth(),
      payload: { hashes: [HASH], action: "setCategory" },
    });
    expect(missing.statusCode).toBe(400);
  });

  it("accepts allowlisted categories and categories qBittorrent already has", async () => {
    adapters.qbittorrent = qbStub({
      categories: vi.fn(async () => ({ "my-own": { name: "my-own", savePath: "/downloads/mine" } })),
    });
    for (const category of ["sonarr", "my-own"]) {
      const r = await app.inject({
        method: "POST", url: "/api/downloads/action", headers: auth(),
        payload: { hashes: [HASH], action: "setCategory", category },
      });
      expect(r.statusCode, category).toBe(200);
    }
    expect(adapters.qbittorrent.setCategory).toHaveBeenCalledWith([HASH], "my-own");
  });

  it("logs deleteWithFiles to the activity feed with the torrent names", async () => {
    const r = await app.inject({
      method: "POST", url: "/api/downloads/action", headers: auth(),
      payload: { hashes: [HASH], action: "deleteWithFiles" },
    });
    expect(r.statusCode).toBe(200);
    expect(adapters.qbittorrent.deleteWithFiles).toHaveBeenCalledWith([HASH]);
    const entry = recentActivity(5).find((a) => a.message.includes("Blade Runner 2049"));
    expect(entry).toBeTruthy();
    expect(entry!.message).toMatch(/AND their downloaded files/);
    expect(entry!.service).toBe("qbittorrent");
  });

  it("does not log the non-destructive delete", async () => {
    const before = recentActivity(50).length;
    const r = await app.inject({
      method: "POST", url: "/api/downloads/action", headers: auth(),
      payload: { hashes: [HASH], action: "delete" },
    });
    expect(r.statusCode).toBe(200);
    expect(adapters.qbittorrent.delete).toHaveBeenCalledWith([HASH]);
    expect(recentActivity(50).length).toBe(before);
  });
});

describe("GET /api/queue", () => {
  it("merges every configured *arr and degrades the rest into `unavailable`", async () => {
    adapters.radarr = arrStub("radarr", [{
      id: 12, title: "Blade Runner 2049", status: "completed",
      trackedDownloadStatus: "warning", trackedDownloadState: "importPending",
      statusMessages: ["No files found are eligible for import"],
      size: 8589934592, sizeleft: 0, downloadId: HASH.toUpperCase(),
      outputPath: "/downloads/radarr/Blade Runner 2049",
    }]);
    adapters.sonarr = arrStub("sonarr", [{ id: 3, title: "Some Show S01E01" }]);
    // lidarr: unconfigured. sonarr answers, so a missing service must not hide it.
    adapters.sonarr.queue = vi.fn(async () => { throw new Error("connect ETIMEDOUT"); });

    const r = await app.inject({ method: "GET", url: "/api/queue", headers: { cookie } });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      service: "radarr", id: 12, trackedDownloadStatus: "warning",
      trackedDownloadState: "importPending", downloadId: HASH.toUpperCase(),
    });
    expect(body.items[0].statusMessages).toEqual(["No files found are eligible for import"]);
    expect(body.unavailable).toEqual([
      { service: "lidarr", detail: "not configured" },
      { service: "sonarr", detail: "connect ETIMEDOUT" },
    ]);
  });

  it("merges two healthy services into one ordered list", async () => {
    adapters.radarr = arrStub("radarr", [{ id: 2, title: "R2" }, { id: 1, title: "R1" }]);
    adapters.lidarr = arrStub("lidarr", [{ id: 9, title: "L9" }]);
    const r = await app.inject({ method: "GET", url: "/api/queue", headers: { cookie } });
    expect(r.json().items.map((i: any) => `${i.service}:${i.id}`)).toEqual(["lidarr:9", "radarr:1", "radarr:2"]);
    expect(r.json().unavailable).toEqual([{ service: "sonarr", detail: "not configured" }]);
  });

  it("requires authentication", async () => {
    const r = await app.inject({ method: "GET", url: "/api/queue" });
    expect(r.statusCode).toBe(401);
  });
});

describe("queue mutations", () => {
  it("refreshes every configured *arr and reports the rest", async () => {
    adapters.radarr = arrStub("radarr", []);
    adapters.sonarr = arrStub("sonarr", []);
    adapters.sonarr.processDownloads = vi.fn(async () => { throw new Error("401 Unauthorized"); });
    const r = await app.inject({ method: "POST", url: "/api/queue/refresh", headers: auth() });
    expect(r.statusCode).toBe(200);
    expect(r.json().refreshed).toEqual(["radarr"]);
    expect(r.json().unavailable).toEqual([
      { service: "lidarr", detail: "not configured" },
      { service: "sonarr", detail: "401 Unauthorized" },
    ]);
    expect(adapters.radarr.processDownloads).toHaveBeenCalled();
  });

  it("removes a queue item with the caller's explicit switches", async () => {
    adapters.radarr = arrStub("radarr", []);
    const r = await app.inject({
      method: "POST", url: "/api/queue/radarr/12/remove", headers: auth(),
      payload: { removeFromClient: true, blocklist: true },
    });
    expect(r.statusCode).toBe(200);
    expect(adapters.radarr.removeFromQueue).toHaveBeenCalledWith(12, { removeFromClient: true, blocklist: true });
    expect(recentActivity(5)[0]!.message).toMatch(/blocklisted/);
  });

  it("defaults both removal switches to false", async () => {
    adapters.radarr = arrStub("radarr", []);
    await app.inject({ method: "POST", url: "/api/queue/radarr/12/remove", headers: auth(), payload: {} });
    expect(adapters.radarr.removeFromQueue).toHaveBeenCalledWith(12, { removeFromClient: false, blocklist: false });
  });

  it("rejects an unknown service and 409s an unconfigured one", async () => {
    const bad = await app.inject({ method: "POST", url: "/api/queue/plex/12/remove", headers: auth(), payload: {} });
    expect(bad.statusCode).toBe(400);
    const unconfigured = await app.inject({ method: "POST", url: "/api/queue/radarr/12/remove", headers: auth(), payload: {} });
    expect(unconfigured.statusCode).toBe(409);
  });

  it("requires CSRF on both mutations", async () => {
    const refresh = await app.inject({ method: "POST", url: "/api/queue/refresh", headers: { cookie } });
    expect(refresh.statusCode).toBe(403);
    const remove = await app.inject({ method: "POST", url: "/api/queue/radarr/1/remove", headers: { cookie }, payload: {} });
    expect(remove.statusCode).toBe(403);
  });
});
