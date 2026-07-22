import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { SESSION_COOKIE, getSession, type SessionCtx } from "./session.js";

declare module "fastify" {
  interface FastifyRequest {
    session?: SessionCtx;
  }
}

/**
 * Attaches session (if any) to the request, and exposes guards:
 *  - requireAuth: 401 if no valid session
 *  - requireCsrf: double-submit CSRF check for mutating requests
 */
export async function authPlugin(app: FastifyInstance): Promise<void> {
  app.decorateRequest("session", undefined);

  app.addHook("onRequest", async (req) => {
    const sid = req.cookies?.[SESSION_COOKIE];
    const s = getSession(sid);
    if (s) req.session = s;
  });

  app.decorate("requireAuth", async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.session) {
      reply.code(401).send({ error: "authentication required" });
    }
  });

  app.decorate("requireCsrf", async (req: FastifyRequest, reply: FastifyReply) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return;
    const header = req.headers["x-csrf-token"];
    if (!req.session || !header || header !== req.session.csrfToken) {
      reply.code(403).send({ error: "invalid CSRF token" });
    }
  });
}

declare module "fastify" {
  interface FastifyInstance {
    requireAuth: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireCsrf: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}
