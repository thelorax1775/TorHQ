import pino from "pino";

/**
 * Pino options for Fastify's built-in logger. We pass OPTIONS (not an instance)
 * so Fastify keeps its default FastifyBaseLogger typing. Output is single-line
 * JSON to stdout — ideal for journald.
 */
export function loggerOptions(level: string): pino.LoggerOptions {
  return {
    level,
    base: { app: "torhq" },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: ["req.headers.cookie", "req.headers.authorization", "*.apiKey", "*.password", "*.secret"],
      censor: "[redacted]",
    },
  };
}
