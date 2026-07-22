import type { FastifyInstance } from "fastify";

/**
 * Hand-authored OpenAPI 3.1 document. It describes the auth/CSRF model, request
 * and response shapes, and error envelopes for the endpoints the SPA and the
 * documented curl flows use. Auth: a session cookie (`torhq_sid`); every
 * mutating request additionally requires the `X-CSRF-Token` header.
 */
const errorResponse = (description: string) => ({
  description,
  content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
});

const jsonBody = (ref: string) => ({
  required: true,
  content: { "application/json": { schema: { $ref: `#/components/schemas/${ref}` } } },
});

const jsonOk = (ref: string, description = "OK") => ({
  description,
  content: { "application/json": { schema: { $ref: `#/components/schemas/${ref}` } } },
});

const csrfHeader = {
  name: "X-CSRF-Token",
  in: "header",
  required: true,
  description: "Per-session CSRF token returned by login/register.",
  schema: { type: "string" },
};

export const openApiDoc = {
  openapi: "3.1.0",
  info: {
    title: "TorHQ API",
    version: "1.0.0",
    description:
      "Control plane for a Proxmox media homelab. All /api routes except the auth " +
      "endpoints require a session cookie; all mutating routes also require the " +
      "X-CSRF-Token header. TorHQ never returns decrypted service secrets.",
  },
  servers: [{ url: "/" }],
  components: {
    securitySchemes: {
      cookieAuth: { type: "apiKey", in: "cookie", name: "torhq_sid" },
      csrfToken: { type: "apiKey", in: "header", name: "X-CSRF-Token" },
    },
    schemas: {
      Error: {
        type: "object",
        required: ["error"],
        properties: {
          error: { type: "string" },
          issues: { type: "array", items: { type: "object" }, description: "Zod issues on validation failure." },
        },
      },
      Ok: { type: "object", properties: { ok: { type: "boolean" } } },
      Credentials: {
        type: "object",
        required: ["username", "password"],
        properties: {
          username: { type: "string", minLength: 1, maxLength: 64 },
          password: { type: "string", minLength: 8, maxLength: 256 },
        },
      },
      Session: {
        type: "object",
        properties: { username: { type: "string" }, csrfToken: { type: "string" } },
      },
      Me: {
        type: "object",
        properties: {
          authenticated: { type: "boolean" },
          needsSetup: { type: "boolean" },
          csrfToken: { type: ["string", "null"] },
        },
      },
      ServiceInput: {
        type: "object",
        required: ["kind", "label", "baseUrl"],
        properties: {
          kind: {
            type: "string",
            enum: ["qbittorrent", "radarr", "sonarr", "lidarr", "prowlarr", "slskd", "jellyfin", "navidrome", "kavita", "torrentsearch"],
          },
          label: { type: "string", minLength: 1, maxLength: 64 },
          baseUrl: { type: "string", format: "uri" },
          secret: { type: "string", maxLength: 1024, description: "API key or 'user:pass'. Omit to keep the stored secret." },
          enabled: { type: "boolean" },
          extra: {
            type: "object",
            description:
              "Typed per-kind config. kavita: { libraryId }. slskd: { webhookToken } (write-only). " +
              "torrentsearch: { searchPath, rowSelector, titleSelector, magnetSelector, seedersSelector, " +
              "leechersSelector, sizeSelector, detailLinkSelector, magnetOnDetailPage, flaresolverrUrl }.",
          },
        },
      },
      ServiceSafe: {
        type: "object",
        description: "Browser-safe service view — secrets are masked and write-only extra fields become <key>Set booleans.",
        properties: {
          kind: { type: "string" },
          label: { type: "string" },
          baseUrl: { type: "string" },
          enabled: { type: "boolean" },
          lastHealthy: { type: ["integer", "null"] },
          lastStatus: { type: ["string", "null"] },
          secretMask: { type: ["string", "null"] },
          extra: { type: "object" },
        },
      },
      HealthResult: {
        type: "object",
        properties: {
          healthy: { type: "boolean" },
          version: { type: "string" },
          detail: { type: "string" },
          latencyMs: { type: "integer" },
        },
      },
      LibraryInput: {
        type: "object",
        required: ["key", "label", "kind", "targetService", "destPath", "stagingPath"],
        properties: {
          key: { type: "string", pattern: "^[a-z0-9-]+$", maxLength: 64 },
          label: { type: "string", minLength: 1, maxLength: 64 },
          kind: { type: "string", enum: ["books", "manga", "comics", "music"] },
          targetService: { type: "string", enum: ["kavita", "navidrome"] },
          destPath: { type: "string", description: "Must resolve inside an approved root." },
          stagingPath: { type: "string", description: "Must be inside an approved root, on the same filesystem as destPath." },
          rescan: { type: "boolean" },
        },
      },
      Candidate: {
        type: "object",
        description: "A search result the user chooses before anything is added.",
        properties: {
          selectionId: { type: "string", description: "Stable flavor-specific id: tmdb:/tvdb:/mbid:." },
          title: { type: "string" },
          subtitle: { type: "string" },
          year: { type: "integer" },
          poster: { type: "string" },
          overview: { type: "string" },
          alreadyAdded: { type: "boolean" },
        },
      },
      AddRequest: {
        type: "object",
        required: ["term", "selectionId", "qualityProfileId", "rootFolderPath"],
        properties: {
          term: { type: "string", maxLength: 256 },
          selectionId: { type: "string", description: "The chosen candidate's selectionId — never 'the first result'." },
          qualityProfileId: { type: "integer", minimum: 1 },
          rootFolderPath: { type: "string" },
          monitored: { type: "boolean" },
          searchNow: { type: "boolean" },
          metadataProfileId: { type: "integer", minimum: 1, description: "Required for music (Lidarr)." },
        },
      },
      IntakeInput: {
        type: "object",
        required: ["libraryKey", "sourcePath"],
        properties: {
          libraryKey: { type: "string" },
          sourcePath: { type: "string", description: "Absolute path inside an approved root." },
          targetName: { type: "string", maxLength: 255 },
          idempotencyKey: { type: "string", maxLength: 128 },
        },
      },
      IntakePreview: {
        type: "object",
        properties: {
          libraryKey: { type: "string" },
          sourcePath: { type: "string" },
          destPath: { type: "string" },
          totalBytes: { type: "integer" },
          warnings: { type: "array", items: { type: "string" } },
          entries: {
            type: "array",
            items: {
              type: "object",
              properties: { name: { type: "string" }, size: { type: "integer" }, isDir: { type: "boolean" } },
            },
          },
        },
      },
      Job: {
        type: "object",
        properties: {
          id: { type: "string" },
          type: { type: "string" },
          status: { type: "string", enum: ["queued", "running", "completed", "failed", "dead"] },
          libraryKey: { type: ["string", "null"] },
          sourcePath: { type: "string" },
          attempts: { type: "integer" },
          maxAttempts: { type: "integer" },
          nextRunAt: { type: "integer" },
          lastError: { type: ["string", "null"] },
          createdAt: { type: "integer" },
          updatedAt: { type: "integer" },
        },
      },
      TorrentResult: {
        type: "object",
        description: "A normalized magnet result scraped from the configured torrent site.",
        properties: {
          title: { type: "string" },
          magnet: { type: "string", description: "magnet: URI." },
          seeders: { type: ["integer", "null"] },
          leechers: { type: ["integer", "null"] },
          sizeBytes: { type: ["integer", "null"] },
          detailUrl: { type: ["string", "null"], description: "Same-origin detail page link, if any." },
        },
      },
      GrabInput: {
        type: "object",
        required: ["magnet"],
        properties: {
          magnet: { type: "string", description: "A well-formed magnet:?xt=urn:btih:<hash> link. Non-magnet URLs are rejected." },
          title: { type: "string", maxLength: 512 },
          category: {
            type: "string",
            enum: ["torhq-manual", "radarr", "sonarr", "lidarr"],
            description: "qBittorrent category. Defaults to torhq-manual; an *arr category lets that *arr adopt the download.",
          },
        },
      },
      SlskdWebhook: {
        type: "object",
        required: ["localPath"],
        properties: {
          localPath: { type: "string", description: "Completed-download path inside an approved root." },
          username: { type: "string" },
          filename: { type: "string" },
          libraryKey: { type: "string", description: "Defaults to navidrome-music." },
        },
      },
    },
  },
  // Everything under /api (except auth) needs the cookie; mutations also CSRF.
  security: [{ cookieAuth: [] }],
  paths: {
    "/health": { get: { summary: "Liveness", security: [], responses: { "200": { description: "ok" } } } },
    "/ready": {
      get: {
        summary: "Readiness (DB check)", security: [],
        responses: { "200": { description: "ready" }, "503": errorResponse("not ready") },
      },
    },
    "/api/auth/register": {
      post: {
        summary: "First-run admin creation", security: [],
        requestBody: jsonBody("Credentials"),
        responses: { "200": jsonOk("Session"), "409": errorResponse("admin already exists"), "400": errorResponse("validation failed") },
      },
    },
    "/api/auth/login": {
      post: {
        summary: "Login (sets session cookie)", security: [],
        requestBody: jsonBody("Credentials"),
        responses: { "200": jsonOk("Session"), "401": errorResponse("invalid credentials") },
      },
    },
    "/api/auth/logout": {
      post: {
        summary: "Logout (requires CSRF)",
        security: [{ cookieAuth: [], csrfToken: [] }],
        parameters: [csrfHeader],
        responses: { "200": jsonOk("Ok"), "401": errorResponse("auth required"), "403": errorResponse("invalid CSRF token") },
      },
    },
    "/api/auth/me": {
      get: { summary: "Session probe + needsSetup flag", security: [], responses: { "200": jsonOk("Me") } },
    },
    "/api/services": {
      get: {
        summary: "List services (secrets masked)",
        responses: {
          "200": { description: "OK", content: { "application/json": { schema: { type: "object", properties: {
            services: { type: "array", items: { $ref: "#/components/schemas/ServiceSafe" } },
            kinds: { type: "array", items: { type: "string" } },
          } } } } },
          "401": errorResponse("auth required"),
        },
      },
      post: {
        summary: "Create/update a service",
        security: [{ cookieAuth: [], csrfToken: [] }],
        parameters: [csrfHeader],
        requestBody: jsonBody("ServiceInput"),
        responses: { "200": jsonOk("Ok"), "400": errorResponse("validation failed"), "403": errorResponse("invalid CSRF token") },
      },
    },
    "/api/services/test": {
      post: {
        summary: "Test a service connection (uses submitted or stored secret)",
        security: [{ cookieAuth: [], csrfToken: [] }],
        parameters: [csrfHeader],
        requestBody: jsonBody("ServiceInput"),
        responses: { "200": jsonOk("HealthResult"), "502": jsonOk("HealthResult", "unhealthy") },
      },
    },
    "/api/libraries": {
      get: { summary: "List intake libraries", responses: { "200": { description: "OK" } } },
      post: {
        summary: "Create/update an intake library",
        security: [{ cookieAuth: [], csrfToken: [] }],
        parameters: [csrfHeader],
        requestBody: jsonBody("LibraryInput"),
        responses: { "200": jsonOk("Ok"), "400": errorResponse("path escapes approved roots / validation") },
      },
    },
    "/api/config/roots": { get: { summary: "Approved roots (read-only)", responses: { "200": { description: "OK" } } } },
    "/api/requests/{route}/options": {
      get: {
        summary: "Quality profiles, root folders (+ Lidarr metadata profiles)",
        parameters: [{ name: "route", in: "path", required: true, schema: { type: "string", enum: ["movie", "tv", "music"] } }],
        responses: { "200": { description: "OK" }, "409": errorResponse("service not configured"), "502": errorResponse("upstream error") },
      },
    },
    "/api/requests/{route}/search": {
      get: {
        summary: "Search candidates for the user to choose from",
        parameters: [
          { name: "route", in: "path", required: true, schema: { type: "string", enum: ["movie", "tv", "music"] } },
          { name: "term", in: "query", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "OK", content: { "application/json": { schema: { type: "object", properties: {
            candidates: { type: "array", items: { $ref: "#/components/schemas/Candidate" } },
          } } } } },
          "409": errorResponse("service not configured"),
        },
      },
    },
    "/api/requests/{route}": {
      post: {
        summary: "Add the chosen candidate (never the first result)",
        security: [{ cookieAuth: [], csrfToken: [] }],
        parameters: [
          csrfHeader,
          { name: "route", in: "path", required: true, schema: { type: "string", enum: ["movie", "tv", "music"] } },
        ],
        requestBody: jsonBody("AddRequest"),
        responses: {
          "200": { description: "Requested", content: { "application/json": { schema: { type: "object", properties: {
            ok: { type: "boolean" }, id: { type: "integer" }, title: { type: "string" },
          } } } } },
          "400": errorResponse("validation / missing metadataProfileId for music"),
          "409": errorResponse("service not configured"),
          "502": errorResponse("upstream error / selection unavailable"),
        },
      },
    },
    "/api/search": {
      get: {
        summary: "Search the configured torrent site for magnets (read-only)",
        parameters: [
          { name: "q", in: "query", required: true, schema: { type: "string", minLength: 1, maxLength: 256 } },
          { name: "page", in: "query", schema: { type: "integer", minimum: 1, maximum: 20 } },
        ],
        responses: {
          "200": { description: "OK", content: { "application/json": { schema: { type: "object", properties: {
            results: { type: "array", items: { $ref: "#/components/schemas/TorrentResult" } },
          } } } } },
          "409": errorResponse("torrent search not configured"),
          "502": errorResponse("site unreachable / blocked (e.g. Cloudflare)"),
        },
      },
    },
    "/api/search/grab": {
      post: {
        summary: "Send a chosen magnet straight to qBittorrent",
        security: [{ cookieAuth: [], csrfToken: [] }],
        parameters: [csrfHeader],
        requestBody: jsonBody("GrabInput"),
        responses: {
          "200": { description: "Grabbed", content: { "application/json": { schema: { type: "object", properties: {
            ok: { type: "boolean" }, category: { type: "string" },
          } } } } },
          "400": errorResponse("invalid magnet / category"),
          "409": errorResponse("qBittorrent not configured"),
          "502": errorResponse("qBittorrent rejected/unreachable"),
        },
      },
    },
    "/api/intake/preview": {
      post: {
        summary: "Dry-run preview of a manual intake",
        security: [{ cookieAuth: [], csrfToken: [] }],
        parameters: [csrfHeader],
        requestBody: jsonBody("IntakeInput"),
        responses: { "200": jsonOk("IntakePreview"), "400": errorResponse("path validation failed"), "422": errorResponse("unprocessable") },
      },
    },
    "/api/intake": {
      post: {
        summary: "Enqueue a manual intake job",
        security: [{ cookieAuth: [], csrfToken: [] }],
        parameters: [csrfHeader],
        requestBody: jsonBody("IntakeInput"),
        responses: {
          "200": { description: "Queued", content: { "application/json": { schema: { type: "object", properties: {
            ok: { type: "boolean" }, jobId: { type: "string" }, status: { type: "string" },
          } } } } },
          "400": errorResponse("path validation failed"),
        },
      },
    },
    "/api/jobs": {
      get: {
        summary: "List jobs",
        parameters: [{ name: "status", in: "query", schema: { type: "string" } }],
        responses: { "200": { description: "OK", content: { "application/json": { schema: { type: "object", properties: {
          jobs: { type: "array", items: { $ref: "#/components/schemas/Job" } },
        } } } } } },
      },
    },
    "/api/jobs/{id}": {
      get: {
        summary: "Job detail + activity",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "OK" }, "404": errorResponse("not found") },
      },
    },
    "/api/jobs/{id}/retry": {
      post: {
        summary: "Retry a job",
        security: [{ cookieAuth: [], csrfToken: [] }],
        parameters: [csrfHeader, { name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": jsonOk("Ok"), "404": errorResponse("not found") },
      },
    },
    "/api/activity": { get: { summary: "Global activity timeline", responses: { "200": { description: "OK" } } } },
    "/api/status/health": { get: { summary: "Aggregate service health", responses: { "200": { description: "OK" } } } },
    "/api/status/downloads": { get: { summary: "qBittorrent downloads by category", responses: { "200": { description: "OK" }, "409": errorResponse("qbittorrent not configured") } } },
    "/api/status/arr-activity": { get: { summary: "Recent Radarr/Sonarr/Lidarr activity", responses: { "200": { description: "OK" } } } },
    "/api/status/slskd": { get: { summary: "Recent slskd downloads", responses: { "200": { description: "OK" }, "409": errorResponse("slskd not configured") } } },
    "/api/status/failures": { get: { summary: "Failed imports + retry queue", responses: { "200": { description: "OK" } } } },
    "/api/status/storage": { get: { summary: "Storage usage for approved roots", responses: { "200": { description: "OK" } } } },
    "/webhooks/slskd": {
      post: {
        summary: "slskd completed-download webhook (shared-token auth)",
        security: [],
        parameters: [{ name: "X-TorHQ-Token", in: "header", required: true, schema: { type: "string" } }],
        requestBody: jsonBody("SlskdWebhook"),
        responses: { "200": { description: "queued" }, "401": errorResponse("invalid webhook token"), "409": errorResponse("library not configured") },
      },
    },
    "/metrics": { get: { summary: "Prometheus metrics (if enabled)", security: [], responses: { "200": { description: "OK" } } } },
  },
} as const;

export function openApiRoutes(app: FastifyInstance): void {
  app.get("/api/openapi.json", async () => openApiDoc);
}
