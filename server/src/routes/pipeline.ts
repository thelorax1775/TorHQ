import type { FastifyInstance } from "fastify";
import type { AppContext } from "../lib/context.js";

/**
 * Pipeline health: does a grab actually reach the right *arr and land in the
 * right directory? Placeholder wiring — real handlers land with the pipeline
 * workstream.
 */
export function pipelineRoutes(_app: FastifyInstance, _ctx: AppContext): void {
  // routes registered by the pipeline workstream
}
