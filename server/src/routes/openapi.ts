import type { FastifyInstance } from "fastify";

/** Minimal hand-authored OpenAPI 3.1 doc for the main endpoints. */
export const openApiDoc = {
  openapi: "3.1.0",
  info: { title: "TorHQ API", version: "1.0.0", description: "Control plane for a Proxmox media homelab." },
  servers: [{ url: "/" }],
  components: {
    securitySchemes: { cookieAuth: { type: "apiKey", in: "cookie", name: "torhq_sid" } },
  },
  paths: {
    "/health": { get: { summary: "Liveness", responses: { "200": { description: "ok" } } } },
    "/ready": { get: { summary: "Readiness (DB check)", responses: { "200": { description: "ready" }, "503": { description: "not ready" } } } },
    "/api/auth/register": { post: { summary: "First-run admin creation" } },
    "/api/auth/login": { post: { summary: "Login (sets session cookie)" } },
    "/api/auth/logout": { post: { summary: "Logout" } },
    "/api/auth/me": { get: { summary: "Session probe + needsSetup flag" } },
    "/api/services": {
      get: { summary: "List services (secrets masked)" },
      post: { summary: "Create/update a service" },
    },
    "/api/services/test": { post: { summary: "Test a service connection" } },
    "/api/libraries": { get: { summary: "List intake libraries" }, post: { summary: "Create/update an intake library" } },
    "/api/requests/movie": { post: { summary: "Add a movie request to Radarr" } },
    "/api/requests/tv": { post: { summary: "Add a TV request to Sonarr" } },
    "/api/requests/music": { post: { summary: "Add an artist/album request to Lidarr" } },
    "/api/intake/preview": { post: { summary: "Dry-run preview of a manual intake" } },
    "/api/intake": { post: { summary: "Enqueue a manual intake job" } },
    "/api/jobs": { get: { summary: "List jobs" } },
    "/api/jobs/{id}": { get: { summary: "Job detail + activity" } },
    "/api/jobs/{id}/retry": { post: { summary: "Retry a job" } },
    "/api/activity": { get: { summary: "Global activity timeline" } },
    "/api/status/health": { get: { summary: "Aggregate service health" } },
    "/api/status/downloads": { get: { summary: "qBittorrent downloads by category" } },
    "/api/status/arr-activity": { get: { summary: "Recent Radarr/Sonarr/Lidarr activity" } },
    "/api/status/slskd": { get: { summary: "Recent slskd downloads" } },
    "/api/status/failures": { get: { summary: "Failed imports + retry queue" } },
    "/api/status/storage": { get: { summary: "Storage usage for approved roots" } },
    "/webhooks/slskd": { post: { summary: "slskd completed-download webhook (token auth)" } },
    "/metrics": { get: { summary: "Prometheus metrics (if enabled)" } },
  },
} as const;

export function openApiRoutes(app: FastifyInstance): void {
  app.get("/api/openapi.json", async () => openApiDoc);
}
