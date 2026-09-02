import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { initDb, getDb } from "../server/src/db/index.js";
import { runMigrations } from "../server/src/db/migrate.js";
import { loadEnv } from "../server/src/config/env.js";
import { authPlugin } from "../server/src/auth/plugin.js";
import { hashPassword } from "../server/src/auth/password.js";
import { createSession, destroySessionsForUser, SESSION_COOKIE } from "../server/src/auth/session.js";
import { users, type User } from "../server/src/db/schema.js";

let app: FastifyInstance;
let dataDir: string;

async function makeUser(username: string, role: "admin" | "member"): Promise<User> {
  const db = getDb();
  const passwordHash = await hashPassword("testpassword1");
  db.insert(users).values({ username, passwordHash, role }).run();
  return db.select().from(users).where(eq(users.username, username)).get()!;
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "torhq-roles-"));
  const env = loadEnv({
    NODE_ENV: "test",
    TORHQ_MASTER_KEY: "test-master-key-0123456789",
    TORHQ_DATA_DIR: dataDir,
    TORHQ_APPROVED_ROOTS: dataDir,
  } as any);
  initDb(env.TORHQ_DATA_DIR);
  runMigrations();

  app = Fastify();
  await app.register(cookie);
  await authPlugin(app);
  app.get("/admin-only", { preHandler: app.requireAdmin }, async () => ({ ok: true }));
  await app.ready();
});
afterAll(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("requireAdmin guard", () => {
  it("401s with no session at all", async () => {
    const r = await app.inject({ method: "GET", url: "/admin-only" });
    expect(r.statusCode).toBe(401);
  });

  it("403s a member session", async () => {
    const member = await makeUser("friend", "member");
    const session = createSession(member);
    const r = await app.inject({
      method: "GET", url: "/admin-only",
      headers: { cookie: `${SESSION_COOKIE}=${session.sessionId}` },
    });
    expect(r.statusCode).toBe(403);
  });

  it("passes an admin session", async () => {
    const admin = await makeUser("root", "admin");
    const session = createSession(admin);
    const r = await app.inject({
      method: "GET", url: "/admin-only",
      headers: { cookie: `${SESSION_COOKIE}=${session.sessionId}` },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true });
  });
});

describe("destroySessionsForUser", () => {
  it("invalidates every session belonging to that user, not other users'", async () => {
    const a = await makeUser("revokeme", "member");
    const b = await makeUser("keepme", "member");
    const sa = createSession(a);
    const sb = createSession(b);

    destroySessionsForUser(a.id);

    const ra = await app.inject({ method: "GET", url: "/admin-only", headers: { cookie: `${SESSION_COOKIE}=${sa.sessionId}` } });
    expect(ra.statusCode).toBe(401); // session gone entirely, not just under-privileged

    const rb = await app.inject({ method: "GET", url: "/admin-only", headers: { cookie: `${SESSION_COOKIE}=${sb.sessionId}` } });
    expect(rb.statusCode).toBe(403); // b's session still exists, just not admin
  });
});
