import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { initDb } from "../server/src/db/index.js";
import { runMigrations } from "../server/src/db/migrate.js";
import { deriveKey } from "../server/src/lib/crypto.js";
import { upsertService } from "../server/src/config/store.js";
import { checkAllHealth } from "../server/src/adapters/registry.js";

const masterKey = deriveKey("health-shape-test-key");
let dir: string;
let slskd: Server;

/**
 * slskd 0.25 reports its version as an object. The dashboard renders
 * `health.version` straight into JSX, so an object there throws "Objects are
 * not valid as a React child" and — with no error boundary at the time — blanked
 * the entire app. The API must never hand the browser that shape.
 */
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "torhq-health-"));
  initDb(dir);
  runMigrations();

  slskd = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      version: { full: "0.25.1.0 (0.25.1.0+7961741f)", current: "0.25.1.0", latest: "0.26.0", isUpdateAvailable: true },
      server: { state: "Connected" },
    }));
  });
  await new Promise<void>((r) => slskd.listen(0, "127.0.0.1", r));
  const { port } = slskd.address() as AddressInfo;

  upsertService({
    kind: "slskd", label: "slskd", baseUrl: `http://127.0.0.1:${port}`, secret: "k", enabled: true, extra: {},
  }, masterKey);
});

afterAll(() => { slskd.close(); rmSync(dir, { recursive: true, force: true }); });

describe("health results the browser has to render", () => {
  it("reports slskd's object version as a string", async () => {
    const health = await checkAllHealth(["slskd"], masterKey);
    expect(health.slskd!.healthy).toBe(true);
    expect(typeof health.slskd!.version).toBe("string");
    expect(health.slskd!.version).toBe("0.25.1.0");
  });

  it("never emits a version that is not a string, whatever an upstream sends", async () => {
    const health = await checkAllHealth(["slskd", "radarr", "qbittorrent"], masterKey);
    for (const [kind, h] of Object.entries(health)) {
      expect(["string", "undefined"], kind).toContain(typeof h.version);
      // Anything React cannot render as a child is the bug this guards.
      expect(typeof h.version === "object", kind).toBe(false);
    }
  });
});
