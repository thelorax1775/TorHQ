import type { FastifyInstance } from "fastify";
import { getRaw } from "../db/index.js";
import { listJobs } from "../queue/queue.js";
import type { AppContext } from "../lib/context.js";

/** Liveness/readiness + optional Prometheus metrics. No auth (LAN-local). */
export function systemRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get("/health", async () => ({ status: "ok", uptime: process.uptime() }));

  app.get("/ready", async (_req, reply) => {
    try {
      getRaw().prepare("SELECT 1").get();
      return { status: "ready" };
    } catch (e) {
      return reply.code(503).send({ status: "not-ready", error: (e as Error).message });
    }
  });

  if (ctx.env.TORHQ_METRICS_ENABLED) {
    app.get("/metrics", async (_req, reply) => {
      const jobs = listJobs(undefined, 500);
      const by = (s: string) => jobs.filter((j) => j.status === s).length;
      const mem = process.memoryUsage();
      const lines = [
        "# HELP torhq_up 1 if the service is up",
        "# TYPE torhq_up gauge",
        "torhq_up 1",
        "# HELP torhq_jobs Job counts by status",
        "# TYPE torhq_jobs gauge",
        `torhq_jobs{status="queued"} ${by("queued")}`,
        `torhq_jobs{status="running"} ${by("running")}`,
        `torhq_jobs{status="completed"} ${by("completed")}`,
        `torhq_jobs{status="dead"} ${by("dead")}`,
        "# HELP torhq_rss_bytes Resident memory",
        "# TYPE torhq_rss_bytes gauge",
        `torhq_rss_bytes ${mem.rss}`,
      ];
      reply.header("content-type", "text/plain; version=0.0.4");
      return lines.join("\n") + "\n";
    });
  }
}
