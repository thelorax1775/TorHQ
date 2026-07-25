import type { FastifyInstance } from "fastify";
import type { AppContext } from "../lib/context.js";

/**
 * Download-client control and the unified queue. Placeholder wiring — the real
 * handlers land with the qBittorrent-control workstream.
 */
export function downloadRoutes(_app: FastifyInstance, _ctx: AppContext): void {
  // routes registered by the downloads workstream
}
