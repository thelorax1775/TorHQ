import { loadEnv } from "./config/env.js";
import { initDb } from "./db/index.js";
import { runMigrations } from "./db/migrate.js";
import { makeContext } from "./lib/context.js";
import { buildApp } from "./app.js";
import { Worker } from "./queue/queue.js";
import { purgeExpiredSessions } from "./auth/session.js";

async function main(): Promise<void> {
  const env = loadEnv();
  initDb(env.TORHQ_DATA_DIR);
  runMigrations();

  const ctx = makeContext(env);
  const app = await buildApp(ctx);

  // Background intake worker.
  const worker = new Worker(env.approvedRoots, ctx.masterKey);
  worker.start();

  // Periodic session cleanup.
  const cleanup = setInterval(() => purgeExpiredSessions(), 60 * 60 * 1000);
  cleanup.unref?.();

  await app.listen({ host: env.TORHQ_HOST, port: env.TORHQ_PORT });

  const shutdown = async (sig: string) => {
    app.log.info({ sig }, "shutting down");
    worker.stop();
    clearInterval(cleanup);
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Fatal:", err);
  process.exit(1);
});
