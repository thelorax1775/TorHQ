import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ZodError } from "zod";
import type { AppContext } from "./lib/context.js";
import { loggerOptions } from "./lib/logger.js";
import { authPlugin } from "./auth/plugin.js";
import { authRoutes } from "./routes/auth.js";
import { setupRoutes } from "./routes/setup.js";
import { requestRoutes } from "./routes/requests.js";
import { searchRoutes } from "./routes/search.js";
import { jobRoutes } from "./routes/jobs.js";
import { statusRoutes } from "./routes/status.js";
import { webhookRoutes } from "./routes/webhooks.js";
import { systemRoutes } from "./routes/system.js";
import { openApiRoutes } from "./routes/openapi.js";

export async function buildApp(ctx: AppContext): Promise<FastifyInstance> {
  const app = Fastify({
    logger: loggerOptions(ctx.env.TORHQ_LOG_LEVEL),
    trustProxy: ctx.env.TORHQ_TRUST_PROXY,
    bodyLimit: 5 * 1024 * 1024,
  });

  // Uniform error shape; hide internals, surface validation messages.
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: "validation failed", issues: err.issues });
    }
    const status = (err as any).statusCode ?? 500;
    if (status >= 500) app.log.error(err);
    reply.code(status).send({ error: status >= 500 ? "internal error" : err.message });
  });

  await app.register(cookie);
  // Global rate limit. The strict brute-force budget is applied per-route (see
  // authRoutes) rather than to a whole scope, so that read-only endpoints the
  // SPA polls -- notably GET /api/auth/me -- cannot exhaust the login budget
  // and lock a legitimate user out of signing in.
  await app.register(rateLimit, { max: 300, timeWindow: "1 minute" });
  await authPlugin(app); // call directly so decorators apply to the root instance

  // Routes. Credential endpoints carry their own tight per-route limit.
  authRoutes(app, ctx);
  webhookRoutes(app, ctx);
  setupRoutes(app, ctx);
  requestRoutes(app, ctx);
  searchRoutes(app, ctx);
  jobRoutes(app, ctx);
  statusRoutes(app, ctx);
  systemRoutes(app, ctx);
  openApiRoutes(app);

  // Serve built SPA if present (single-origin deployment).
  const here = dirname(fileURLToPath(import.meta.url));
  const webDir = join(here, "..", "..", "web", "dist");
  if (existsSync(webDir)) {
    await app.register(fastifyStatic, { root: webDir, prefix: "/" });
    app.setNotFoundHandler((req, reply) => {
      if (req.raw.url?.startsWith("/api") || req.raw.url?.startsWith("/webhooks")) {
        return reply.code(404).send({ error: "not found" });
      }
      return reply.sendFile("index.html"); // SPA fallback
    });
  }

  return app;
}
