import { z } from "zod";

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
  TORHQ_TRUST_PROXY: z.coerce.boolean().default(false),
  // Enable Prometheus /metrics endpoint (disabled by default).
  TORHQ_METRICS_ENABLED: z.coerce.boolean().default(false),
  // Secure cookie flag; enable when served over HTTPS.
  TORHQ_COOKIE_SECURE: z.coerce.boolean().default(false),
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
