import { z } from "zod";

/**
 * Parse a boolean from an env string. NOTE: `z.coerce.boolean()` is wrong for
 * env vars — it does `Boolean(value)`, so the string "false" (non-empty) becomes
 * `true`. Here only explicit truthy tokens are true; anything else (including
 * "false", "0", "", or unset) is false.
 */
const envBool = z.preprocess(
  (v) => (typeof v === "string" ? ["1", "true", "yes", "on"].includes(v.trim().toLowerCase()) : v ?? false),
  z.boolean(),
);

/**
 * Runtime environment. Only *infrastructure* config lives here (bind address,
 * data dir, master key, approved media roots). Per-service credentials are
 * stored encrypted in the database via the setup wizard, never in env.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("production"),
  // Bind to loopback by default; use reverse proxy for LAN/HTTPS exposure.
  TORHQ_HOST: z.string().default("127.0.0.1"),
  TORHQ_PORT: z.coerce.number().int().positive().default(8787),
  // Base data dir (SQLite db + logs). Must be writable by the torhq user.
  TORHQ_DATA_DIR: z.string().default("/srv/torhq/data"),
  // 32-byte key (base64 or hex) used to encrypt stored service secrets.
  TORHQ_MASTER_KEY: z.string().min(16),
  // Colon-separated list of approved base directories. ALL filesystem
  // operations are validated to stay within one of these roots.
  TORHQ_APPROVED_ROOTS: z.string().default("/srv/torhq"),
  // Trust X-Forwarded-* headers (only enable behind a trusted reverse proxy).
  TORHQ_TRUST_PROXY: envBool,
  // Enable Prometheus /metrics endpoint (disabled by default).
  TORHQ_METRICS_ENABLED: envBool,
  // Secure cookie flag; enable when served over HTTPS.
  TORHQ_COOKIE_SECURE: envBool,
  TORHQ_LOG_LEVEL: z.enum(["fatal","error","warn","info","debug","trace"]).default("info"),
});

export type Env = z.infer<typeof EnvSchema> & {
  approvedRoots: string[];
};

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.parse(source);
  const approvedRoots = parsed.TORHQ_APPROVED_ROOTS.split(":")
    .map((s) => s.trim())
    .filter(Boolean);
  if (approvedRoots.length === 0) {
    throw new Error("TORHQ_APPROVED_ROOTS must contain at least one path");
  }
  return { ...parsed, approvedRoots };
}
