import { z } from "zod";

/**
 * Typed, per-kind "extra" service configuration. Only the adapter settings TorHQ
 * actually needs are configurable — no arbitrary raw JSON as the primary UX.
 *
 * Secret extra fields (e.g. the slskd webhook token) are **write-only**: they are
 * stored server-side, retained when a save omits them, and never returned to the
 * browser (see `safeExtra`), only surfaced as a boolean `<key>Set` flag.
 */
const KavitaExtra = z.object({
  // Numeric Kavita libraryId; when set, intake triggers an explicit scan of it.
  libraryId: z.coerce.number().int().positive().optional(),
});

const SlskdExtra = z.object({
  // Shared token that authenticates the /webhooks/slskd completed-download hook.
  webhookToken: z.string().min(8).max(256).optional(),
});

const EXTRA_SCHEMAS: Partial<Record<string, z.ZodTypeAny>> = {
  kavita: KavitaExtra,
  slskd: SlskdExtra,
};

/** Fields that are secret/write-only per kind (never sent to the browser). */
const SECRET_EXTRA_KEYS: Record<string, string[]> = {
  slskd: ["webhookToken"],
};

/** Whether a service kind exposes any configurable extra settings. */
export function hasExtraConfig(kind: string): boolean {
  return kind in EXTRA_SCHEMAS;
}

/**
 * Validate submitted extra against the kind's schema and merge with existing:
 *  - non-secret fields are authoritative from the submission (omitting one clears it);
 *  - secret fields are retained from the existing config when the submission
 *    omits or blanks them, so the token survives an unrelated save.
 * Kinds without an extra schema ignore any submitted extra entirely.
 */
export function mergeExtra(
  kind: string,
  submitted: Record<string, unknown> | undefined,
  existing: Record<string, unknown>,
): Record<string, unknown> {
  const schema = EXTRA_SCHEMAS[kind];
  if (!schema) return {};
  if (submitted === undefined) return existing;
  const secretKeys = SECRET_EXTRA_KEYS[kind] ?? [];
  // A blank secret field means "keep the existing value", so strip it before
  // validation (an empty string would otherwise fail the field's constraints).
  const toParse: Record<string, unknown> = { ...submitted };
  for (const k of secretKeys) if (toParse[k] === "") delete toParse[k];
  const parsed = schema.parse(toParse) as Record<string, unknown>;
  const merged: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (secretKeys.includes(k)) continue;
    if (v !== undefined) merged[k] = v;
  }
  for (const k of secretKeys) {
    const pv = parsed[k];
    if (pv !== undefined && pv !== "") merged[k] = pv;
    else if (existing[k] !== undefined) merged[k] = existing[k];
  }
  return merged;
}

/** Browser-safe projection: secret fields become a boolean `<key>Set` flag. */
export function safeExtra(kind: string, extra: Record<string, unknown>): Record<string, unknown> {
  const secretKeys = SECRET_EXTRA_KEYS[kind] ?? [];
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(extra)) {
    if (!secretKeys.includes(k)) out[k] = v;
  }
  for (const k of secretKeys) out[`${k}Set`] = !!extra[k];
  return out;
}
