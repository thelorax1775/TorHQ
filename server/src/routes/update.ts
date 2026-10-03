import type { FastifyInstance, FastifyReply } from "fastify";
import { logActivity } from "../lib/activity.js";
import { readUpdateView, requestUpdate, type UpdateAction } from "../lib/updater.js";
import type { AppContext } from "../lib/context.js";

/** Admin-only: inspect and trigger the GitHub self-update (see lib/updater.ts). */
export function updateRoutes(app: FastifyInstance, ctx: AppContext): void {
  const dataDir = ctx.env.TORHQ_DATA_DIR;
  const unit = ctx.env.TORHQ_UPDATE_UNIT;
  const guard = { preHandler: [app.requireAuth, app.requireAdmin, app.requireCsrf] };

  app.get("/api/system/update", { preHandler: [app.requireAuth, app.requireAdmin] }, async () =>
    readUpdateView(dataDir, unit));

  const queue = (action: UpdateAction) => async (_req: unknown, reply: FastifyReply) => {
    const refused = requestUpdate(dataDir, unit, action);
    if (refused) return reply.code(409).send({ error: refused });
    logActivity({
      kind: "info",
      message: action === "apply" ? "Update from GitHub requested" : "Checked GitHub for updates",
    });
    return reply.code(202).send(readUpdateView(dataDir, unit));
  };

  app.post("/api/system/update/check", guard, queue("check"));
  app.post("/api/system/update/apply", guard, queue("apply"));
}
