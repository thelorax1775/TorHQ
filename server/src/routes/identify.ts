import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getAdapter } from "../adapters/registry.js";
import type { ArrAdapter, ArrFlavor } from "../adapters/arr.js";
import type { GeminiAdapter } from "../adapters/gemini.js";
import { cachedIdentify, type IdentifyDeps } from "../lib/identify.js";
import type { AppContext } from "../lib/context.js";
import { ARR_SERVICES } from "./downloads.js";

/**
 * Identify raw torrent release names, so a grab from the Raw search page can be
 * routed into the *arr that will import and file it.
 *
 * The ladder itself lives in `lib/identify.ts`; these routes only assemble the
 * adapters and cap the work. Identification is read-only — it decides nothing
 * and grabs nothing. Acting on the answer is a separate, explicit call to
 * /api/acquire/prepare followed by /api/search/grab.
 */

/**
 * One page of search results at a time. The cap is what stops a crafted or
 * careless request turning into a hundred Gemini calls.
 */
const MAX_BATCH = 30;

const IdentifyBody = z.object({ release: z.string().min(1).max(512) });
const BatchBody = z.object({
  releases: z.array(z.string().min(1).max(512)).min(1).max(MAX_BATCH),
});

export function identifyRoutes(app: FastifyInstance, ctx: AppContext): void {
  // Identification is read-only, but it can spend money at the Gemini rung, so
  // it is a POST behind CSRF rather than a freely-linkable GET.
  const guard = { preHandler: [app.requireAuth, app.requireCsrf] };

  function deps(): IdentifyDeps {
    const arrs: Partial<Record<ArrFlavor, ArrAdapter>> = {};
    for (const s of ARR_SERVICES) {
      const a = getAdapter(s, ctx.masterKey) as ArrAdapter | null;
      if (a) arrs[s] = a;
    }
    return { arrs, gemini: getAdapter("gemini", ctx.masterKey) as GeminiAdapter | null };
  }

  /** What identification can do right now, and what it would fall back to. */
  app.get("/api/identify/status", { preHandler: app.requireAuth }, async () => {
    const d = deps();
    const parsers = Object.keys(d.arrs) as ArrFlavor[];
    return {
      parsers,
      geminiConfigured: !!d.gemini,
      model: d.gemini?.model ?? null,
      // Said plainly, because the honest answer to "will this work" is mostly
      // "yes, and it never needed an LLM for it".
      detail: parsers.length === 0
        ? "No *arr is configured, so nothing can be identified."
        : d.gemini
          ? `${parsers.join(", ")} parse first; Gemini only handles what they cannot read.`
          : `${parsers.join(", ")} parse first. Gemini is not configured, so names they cannot read stay unidentified.`,
    };
  });

  app.post("/api/identify", guard, async (req) => {
    const { release } = IdentifyBody.parse(req.body);
    return cachedIdentify(release, deps());
  });

  /**
   * A page of results in one request. Names are de-duplicated first: a search
   * page routinely lists the same title several times, and the ladder is a pure
   * function of the name, so re-running it would only cost money.
   */
  app.post("/api/identify/batch", guard, async (req) => {
    const { releases } = BatchBody.parse(req.body);
    const d = deps();
    const unique = [...new Set(releases)];
    const results = await Promise.all(unique.map((r) => cachedIdentify(r, d)));
    return { results };
  });
}
