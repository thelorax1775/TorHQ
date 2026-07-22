import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getAdapter } from "../adapters/registry.js";
import { ArrAdapter } from "../adapters/arr.js";
import { logActivity } from "../lib/activity.js";
import type { AppContext } from "../lib/context.js";

const AddRequest = z.object({
  term: z.string().min(1).max(256),
  qualityProfileId: z.number().int().positive(),
  rootFolderPath: z.string().min(1),
  monitored: z.boolean().optional(),
  searchNow: z.boolean().optional(),
});

const ARR_KIND = { movie: "radarr", tv: "sonarr", music: "lidarr" } as const;

export function requestRoutes(app: FastifyInstance, ctx: AppContext): void {
  const guard = { preHandler: [app.requireAuth, app.requireCsrf] };

  for (const [route, kind] of Object.entries(ARR_KIND)) {
    // Profile/root-folder helpers for the request form.
    app.get(`/api/requests/${route}/options`, { preHandler: app.requireAuth }, async (_req, reply) => {
      const a = getAdapter(kind, ctx.masterKey) as ArrAdapter | null;
      if (!a) return reply.code(409).send({ error: `${kind} not configured` });
      const [profiles, roots] = await Promise.all([a.qualityProfiles(), a.rootFolders()]);
      return { profiles, roots };
    });

    // Submit a request. TorHQ only asks the *arr to add+search; it owns the rest.
    app.post(`/api/requests/${route}`, guard, async (req, reply) => {
      const a = getAdapter(kind, ctx.masterKey) as ArrAdapter | null;
      if (!a) return reply.code(409).send({ error: `${kind} not configured` });
      const body = AddRequest.parse(req.body);
      try {
        const created = await a.addRequest(body);
        logActivity({ kind: "requested", service: kind, message: `Requested ${created.title}`, data: { id: created.id } });
        return { ok: true, id: created.id, title: created.title };
      } catch (e) {
        return reply.code(502).send({ error: (e as Error).message });
      }
    });
  }
}
