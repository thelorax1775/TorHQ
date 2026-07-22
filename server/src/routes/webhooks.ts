import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { enqueue } from "../queue/queue.js";
import { logActivity } from "../lib/activity.js";
import { getLibrary } from "../config/store.js";
import type { AppContext } from "../lib/context.js";

/**
 * slskd completed-download webhook. Authenticated by a shared token compared in
 * constant time (configured as service `slskd` extra.webhookToken). On a
 * completed download it enqueues a manual-intake job into the music library.
 */
const SlskdComplete = z.object({
  localPath: z.string().min(1),
  username: z.string().optional(),
  filename: z.string().optional(),
  // library to route into; defaults to the first navidrome-music library.
  libraryKey: z.string().optional(),
});

function tokenOk(provided: string | undefined, expected: string): boolean {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function webhookRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post("/webhooks/slskd", async (req, reply) => {
    const { getServiceDecrypted } = await import("../config/store.js");
    const svc = getServiceDecrypted("slskd", ctx.masterKey);
    const expected = (svc?.extra?.webhookToken as string) ?? "";
    const provided = (req.headers["x-torhq-token"] as string) ?? "";
    if (!tokenOk(provided, expected)) return reply.code(401).send({ error: "invalid webhook token" });

    const body = SlskdComplete.parse(req.body);
    const libraryKey = body.libraryKey ?? "navidrome-music";
    if (!getLibrary(libraryKey)) {
      return reply.code(409).send({ error: `library ${libraryKey} not configured` });
    }
    const job = enqueue({
      type: "manual_intake",
      payload: { libraryKey, sourcePath: body.localPath },
      idempotencyKey: `slskd:${body.localPath}`,
    });
    logActivity({ kind: "completed", jobId: job.id, service: "slskd", message: `slskd completed: ${body.filename ?? body.localPath}` });
    return { ok: true, jobId: job.id };
  });
}
