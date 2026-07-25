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
          importMode: {
            type: "string",
            enum: ["move", "link"],
            default: "move",
            description:
              "How intake gets bytes from source to destination. 'move' copies into staging, reveals atomically, " +
              "then deletes the source. 'link' hardlinks instead: instant, no extra disk space, and the source is " +
              "left in place — the only safe choice when importing from a torrent that is still seeding. 'link' " +
              "requires the source and destination to be on one filesystem and fails with a clear error otherwise.",
          },
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
          importMode: { type: "string", enum: ["move", "link"] },
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
      ProwlarrRelease: {
        type: "object",
        description: "A normalized release from Prowlarr's aggregated search, seeders-desc.",
        properties: {
          guid: { type: "string", description: "Identifies the release to Prowlarr; required to grab it." },
          indexerId: { type: "integer" },
          indexer: { type: "string" },
          title: { type: "string" },
          size: { type: ["integer", "null"] },
          seeders: { type: ["integer", "null"], description: "null means the indexer did not report a count — not zero." },
          leechers: { type: ["integer", "null"] },
          protocol: { type: "string", enum: ["torrent", "usenet"] },
          publishDate: { type: ["string", "null"], format: "date-time" },
          infoUrl: { type: "string", description: "The indexer's own detail page." },
          downloadUrl: { type: "string", description: "Prowlarr proxy link with the API key stripped; re-signed server-side before use." },
          magnetUrl: { type: "string" },
          categories: { type: "array", items: { type: "object" } },
        },
      },
      WebSearchResult: {
        type: "object",
        description: "A general web result. Not grabbable — the web source links out, it never yields releases.",
        properties: {
          title: { type: "string" },
          url: { type: "string" },
          snippet: { type: "string" },
        },
      },
      GrabInput: {
        type: "object",
        description:
          "A grab from either source. `site` grabs carry a magnet; `prowlarr` grabs carry guid + indexerId " +
          "and let Prowlarr hand the release to its own download client.",
        properties: {
          source: { type: "string", enum: ["prowlarr", "site"], default: "site" },
          magnet: { type: "string", description: "Required for site grabs. A well-formed magnet:?xt=urn:btih:<hash> link; non-magnet URLs are rejected." },
          guid: { type: "string", maxLength: 2048, description: "Required for prowlarr grabs." },
          indexerId: { type: "integer", minimum: 0, description: "Required for prowlarr grabs." },
          downloadUrl: { type: "string", format: "uri", description: "The key-stripped proxy link from the search result; re-signed and origin-checked server-side." },
          title: { type: "string", maxLength: 512 },
          target: {
            type: "string",
            enum: ["radarr", "sonarr", "lidarr", "manual"],
            description: "Which *arr should adopt and import the download. `manual` means TorHQ owns it and no *arr will import it.",
          },
          category: {
            type: "string",
            enum: ["torhq-manual", "radarr", "sonarr", "lidarr"],
            description: "Legacy alias for `target`, expressed as the qBittorrent category.",
          },
        },
      },
      DownloadAction: {
        type: "object",
        required: ["hashes", "action"],
        properties: {
          hashes: { type: "array", items: { type: "string" }, minItems: 1, description: "Torrent info hashes." },
          action: {
            type: "string",
            enum: ["pause", "resume", "recheck", "delete", "deleteWithFiles", "topPriority", "bottomPriority", "setCategory"],
          },
          category: { type: "string", description: "Required for setCategory." },
        },
      },
      QueueRemoveInput: {
        type: "object",
        properties: {
          removeFromClient: { type: "boolean", description: "Also remove the torrent from qBittorrent. Files are kept on disk." },
          blocklist: { type: "boolean", description: "Blocklist the release so the *arr does not grab it again." },
        },
      },
      ManualImportInput: {
        type: "object",
        required: ["service", "downloadId"],
        properties: {
          service: { type: "string", enum: ["radarr", "sonarr", "lidarr"] },
          downloadId: { type: "string", description: "The download client's id for the grab — a torrent hash for qBittorrent." },
        },
      },
      PipelineCheck: {
        type: "object",
        description: "One verifiable claim about the grab → download → import path.",
        required: ["id", "label", "ok", "severity", "detail"],
        properties: {
          id: { type: "string" },
          label: { type: "string" },
          ok: { type: "boolean" },
          severity: { type: "string", enum: ["error", "warn", "info"] },
          detail: { type: "string" },
          fix: { type: "string", description: "What to change. Present whenever ok is false. TorHQ never applies it silently." },
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
    "/api/libraries/{key}": {
      delete: {
        summary: "Forget a destination library",
        description:
          "Removes the definition only — nothing on disk is touched. Refused while intake jobs are " +
          "still queued or running against it, so the failure surfaces here rather than at import time.",
        security: [{ cookieAuth: [], csrfToken: [] }],
        parameters: [csrfHeader, { name: "key", in: "path", required: true, schema: { type: "string", pattern: "^[a-z0-9-]+$" } }],
        responses: {
          "200": jsonOk("Ok", "Removed"),
          "404": errorResponse("no library with that key"),
          "409": errorResponse("intake jobs are still queued against it"),
        },
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
    "/api/search/sources": {
      get: {
        summary: "Which search sources can be used right now, and why not when they can't",
        description:
          "An unavailable source is still listed, with `detail` as the reason, so the UI can " +
          "disable it and say why rather than silently hiding a capability.",
        responses: {
          "200": { description: "OK", content: { "application/json": { schema: { type: "object", properties: {
            sources: { type: "array", items: { type: "object", properties: {
              id: { type: "string", enum: ["prowlarr", "site", "web"] },
              label: { type: "string" },
              available: { type: "boolean" },
              detail: { type: "string" },
            } } },
          } } } } },
        },
      },
    },
    "/api/search/indexers": {
      get: {
        summary: "Prowlarr's indexers and their categories, for the search filters",
        responses: {
          "200": { description: "OK" },
          "409": errorResponse("prowlarr not configured"),
          "502": errorResponse("prowlarr unreachable"),
        },
      },
    },
    "/api/search": {
      get: {
        summary: "Search one source (read-only)",
        description:
          "`prowlarr` aggregates every selected indexer; `site` scrapes the configured torrent " +
          "site; `web` is a general web widget that returns links, not grabbable releases. " +
          "The response shape depends on the source.",
        parameters: [
          { name: "source", in: "query", schema: { type: "string", enum: ["prowlarr", "site", "web"], default: "prowlarr" } },
          { name: "q", in: "query", required: true, schema: { type: "string", minLength: 1, maxLength: 256 } },
          { name: "page", in: "query", description: "site only.", schema: { type: "integer", minimum: 1, maximum: 20 } },
          { name: "indexerIds", in: "query", description: "prowlarr only; comma-separated. Omit to search every indexer.", schema: { type: "string" } },
          { name: "categories", in: "query", description: "prowlarr only; comma-separated newznab category ids.", schema: { type: "string" } },
          { name: "limit", in: "query", description: "prowlarr only.", schema: { type: "integer", minimum: 10, maximum: 500 } },
        ],
        responses: {
          "200": { description: "OK", content: { "application/json": { schema: { oneOf: [
            { type: "object", properties: {
              source: { type: "string", enum: ["prowlarr"] },
              results: { type: "array", items: { $ref: "#/components/schemas/ProwlarrRelease" } },
            } },
            { type: "object", properties: {
              source: { type: "string", enum: ["site"] },
              results: { type: "array", items: { $ref: "#/components/schemas/TorrentResult" } },
            } },
            { type: "object", properties: {
              source: { type: "string", enum: ["web"] },
              provider: {
            type: "string",
            enum: ["link", "widget", "google", "searxng"],
            description:
              "'widget' means the response carries no results: the page mounts Google's own Programmable " +
              "Search embed and queries it from the browser. Any provider that is misconfigured or failing " +
              "degrades to 'link' with a reason in `degraded`, so this is never the provider that was asked for.",
          },
          cx: { type: "string", description: "Google engine id; present only when provider is 'widget'." },
              results: { type: "array", items: { $ref: "#/components/schemas/WebSearchResult" } },
              links: { type: "array", items: { type: "object" }, description: "Ready-made link-outs, always present so the widget works with no credentials." },
              degraded: { type: "string", description: "Set when the configured provider failed and only links are being returned." },
            } },
          ] } } } },
          "400": errorResponse("invalid query"),
          "409": errorResponse("the requested source is not configured"),
          "502": errorResponse("source unreachable / blocked (e.g. Cloudflare)"),
        },
      },
    },
    "/api/search/grab": {
      post: {
        summary: "Grab a chosen release and route it to the *arr that should import it",
        description:
          "prowlarr + an *arr target → Prowlarr hands the release to its download client and that *arr " +
          "is nudged to adopt it; prowlarr + qBittorrent → the release's own link is added under " +
          "`torhq-manual`; site → the magnet goes to qBittorrent under the target's category. The *arr " +
          "always owns the import, rename and placement — TorHQ moves no files.",
        security: [{ cookieAuth: [], csrfToken: [] }],
        parameters: [csrfHeader],
        requestBody: jsonBody("GrabInput"),
        responses: {
          "200": { description: "Grabbed", content: { "application/json": { schema: { type: "object", properties: {
            ok: { type: "boolean" }, category: { type: "string" }, via: { type: "string" },
            importTriggered: { type: "boolean", description: "Whether the matching *arr was nudged to import the download." },
          } } } } },
          "400": errorResponse("invalid magnet / missing guid+indexerId / unknown target"),
          "409": errorResponse("the source or qBittorrent is not configured"),
          "502": errorResponse("prowlarr or qBittorrent rejected/unreachable"),
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
    "/api/downloads": {
      get: {
        summary: "Every torrent in qBittorrent, with the global transfer rates and category map",
        responses: { "200": { description: "OK" }, "409": errorResponse("qbittorrent not configured"), "502": errorResponse("qBittorrent unreachable") },
      },
    },
    "/api/downloads/action": {
      post: {
        summary: "Act on one or more torrents",
        description:
          "`deleteWithFiles` is the only action that destroys data on disk; every action is recorded " +
          "in the activity log with the affected torrent names.",
        security: [{ cookieAuth: [], csrfToken: [] }],
        parameters: [csrfHeader],
        requestBody: jsonBody("DownloadAction"),
        responses: {
          "200": { description: "Applied", content: { "application/json": { schema: { type: "object", properties: {
            ok: { type: "boolean" }, action: { type: "string" }, count: { type: "integer" },
          } } } } },
          "400": errorResponse("invalid action / hashes"),
          "409": errorResponse("qbittorrent not configured"),
          "502": errorResponse("qBittorrent rejected the action"),
        },
      },
    },
    "/api/queue": {
      get: {
        summary: "The merged Radarr/Sonarr/Lidarr queue",
        description:
          "A service that is missing or down is reported in `unavailable` and never fails the whole " +
          "response — a broken Lidarr must not hide what Radarr is doing.",
        responses: { "200": { description: "OK" } },
      },
    },
    "/api/queue/refresh": {
      post: {
        summary: "Ask every configured *arr to poll its download client now",
        security: [{ cookieAuth: [], csrfToken: [] }],
        parameters: [csrfHeader],
        responses: { "200": { description: "OK" } },
      },
    },
    "/api/queue/{service}/{id}/remove": {
      post: {
        summary: "Drop one record from an *arr's queue",
        description: "Downloaded files are left on disk either way; both switches are the caller's explicit choice and both are logged.",
        security: [{ cookieAuth: [], csrfToken: [] }],
        parameters: [
          csrfHeader,
          { name: "service", in: "path", required: true, schema: { type: "string", enum: ["radarr", "sonarr", "lidarr"] } },
          { name: "id", in: "path", required: true, schema: { type: "integer" } },
        ],
        requestBody: jsonBody("QueueRemoveInput"),
        responses: {
          "200": jsonOk("Ok", "Removed"),
          "409": errorResponse("that *arr is not configured"),
          "502": errorResponse("the *arr rejected the removal"),
        },
      },
    },
    "/api/pipeline/check": {
      get: {
        summary: "Read-only verification of the grab → download → import path",
        description:
          "Reports concrete mismatches with a fix. TorHQ never repairs one silently — a check that " +
          "fails tells you what to change, it does not change it.",
        responses: {
          "200": { description: "OK", content: { "application/json": { schema: { type: "object", properties: {
            checks: { type: "array", items: { $ref: "#/components/schemas/PipelineCheck" } },
          } } } } },
        },
      },
    },
    "/api/pipeline/failed-imports": {
      get: {
        summary: "Downloads an *arr finished but could not import",
        responses: { "200": { description: "OK" } },
      },
    },
    "/api/pipeline/manual-import": {
      post: {
        summary: "Ask the owning *arr to scan a completed download again",
        description:
          "The *arr does the scanning, moving and renaming; TorHQ only points it at that *arr's own " +
          "output path for a download it already owns.",
        security: [{ cookieAuth: [], csrfToken: [] }],
        parameters: [csrfHeader],
        requestBody: jsonBody("ManualImportInput"),
        responses: {
          "200": { description: "Requested", content: { "application/json": { schema: { type: "object", properties: {
            ok: { type: "boolean" }, service: { type: "string" }, command: { type: "string" }, path: { type: ["string", "null"] },
          } } } } },
          "404": errorResponse("that *arr has no queue item for the given downloadId"),
          "409": errorResponse("that *arr is not configured"),
          "502": errorResponse("the *arr rejected the rescan"),
        },
      },
    },
    "/api/status/health": { get: { summary: "Aggregate service health", responses: { "200": { description: "OK" } } } },
    "/api/status/downloads": { get: { summary: "qBittorrent downloads by category", responses: { "200": { description: "OK" }, "409": errorResponse("qbittorrent not configured") } } },
    "/api/status/arr-activity": { get: { summary: "Recent Radarr/Sonarr/Lidarr activity", responses: { "200": { description: "OK" } } } },
    "/api/status/slskd": { get: { summary: "Recent slskd downloads", responses: { "200": { description: "OK" }, "409": errorResponse("slskd not configured") } } },
    "/api/status/failures": { get: { summary: "Failed imports + retry queue", responses: { "200": { description: "OK" } } } },
    "/api/status/storage": { get: { summary: "Storage usage for approved roots", responses: { "200": { description: "OK" } } } },
    "/api/status/mounts": {
      get: {
        summary: "NFS/SMB network mounts visible in this container (read-only)",
        responses: {
          "200": { description: "OK", content: { "application/json": { schema: { type: "object", properties: {
            mounts: { type: "array", items: { type: "object", properties: {
              target: { type: "string" }, source: { type: "string" }, fstype: { type: "string" },
              totalBytes: { type: "integer" }, freeBytes: { type: "integer" },
            } } },
          } } } } },
        },
      },
    },
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
