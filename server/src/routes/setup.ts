import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  SERVICE_KINDS, listServicesSafe, upsertService,
  listLibraries, upsertLibrary,
} from "../config/store.js";
import { testConfig } from "../adapters/registry.js";
import { safeResolve } from "../security/paths.js";
import type { AppContext } from "../lib/context.js";

const ServiceInput = z.object({
  kind: z.enum(SERVICE_KINDS),
  label: z.string().min(1).max(64),
  baseUrl: z.string().url(),
  secret: z.string().max(1024).optional(),
  enabled: z.boolean().optional(),
  extra: z.record(z.unknown()).optional(),
});

const LibraryInput = z.object({
  key: z.string().min(1).max(64).regex(/^[a-z0-9-]+$/),
  label: z.string().min(1).max(64),
  kind: z.enum(["books", "manga", "comics", "music"]),
  targetService: z.enum(["kavita", "navidrome"]),
  destPath: z.string().min(1),
  stagingPath: z.string().min(1),
  rescan: z.boolean().optional(),
});

export function setupRoutes(app: FastifyInstance, ctx: AppContext): void {
  const guard = { preHandler: [app.requireAuth, app.requireCsrf] };

  // List configured services (secrets masked — never full keys to browser).
  app.get("/api/services", { preHandler: app.requireAuth }, async () => ({
    services: listServicesSafe(),
    kinds: SERVICE_KINDS,
  }));

  // Save/update a service. If secret omitted, prior secret is retained.
  app.post("/api/services", guard, async (req) => {
    const body = ServiceInput.parse(req.body);
    upsertService(body, ctx.masterKey);
    return { ok: true };
  });

  // Test a connection using either the submitted secret or the stored one.
  app.post("/api/services/test", guard, async (req, reply) => {
    const body = ServiceInput.parse(req.body);
    let secret = body.secret;
    if (!secret) {
      const { getServiceDecrypted } = await import("../config/store.js");
      secret = getServiceDecrypted(body.kind, ctx.masterKey)?.secret ?? "";
    }
    const result = await testConfig(body.kind, { baseUrl: body.baseUrl, secret, extra: body.extra });
    if (!result.healthy) reply.code(502);
    return result;
  });

  // Destination libraries for manual intake. Paths validated against roots.
  app.get("/api/libraries", { preHandler: app.requireAuth }, async () => ({
    libraries: listLibraries(),
  }));

  app.post("/api/libraries", guard, async (req, reply) => {
    const body = LibraryInput.parse(req.body);
    // Both dest and staging must resolve within approved roots (may not exist yet).
    try {
      safeResolve(body.destPath, ctx.env.approvedRoots, { mustExist: false });
      safeResolve(body.stagingPath, ctx.env.approvedRoots, { mustExist: false });
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
    upsertLibrary({ ...body, rescan: body.rescan ?? true });
    return { ok: true };
  });

  // Expose approved roots so the UI can guide path entry (read-only).
  app.get("/api/config/roots", { preHandler: app.requireAuth }, async () => ({
    approvedRoots: ctx.env.approvedRoots,
  }));
}
