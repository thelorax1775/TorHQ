import { sql } from "drizzle-orm";
import {
  sqliteTable,
  text,
  integer,
  index,
} from "drizzle-orm/sqlite-core";

/**
 * SQLite schema (Drizzle). Chosen to be portable to PostgreSQL: no SQLite-only
 * column tricks; timestamps stored as unix epoch ms integers; JSON as text.
 */

export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  role: text("role").notNull().default("admin"),
  createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
});

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(), // random token
    userId: integer("user_id").notNull().references(() => users.id),
    csrfToken: text("csrf_token").notNull(),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    expiresAt: integer("expires_at").notNull(),
  },
  (t) => ({ byUser: index("sessions_user_idx").on(t.userId) }),
);

/** One row per configured external service. Secrets are encrypted at rest. */
export const services = sqliteTable("services", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  // stable kind: qbittorrent|radarr|sonarr|lidarr|prowlarr|slskd|jellyfin|navidrome|kavita
  kind: text("kind").notNull().unique(),
  label: text("label").notNull(),
  baseUrl: text("base_url").notNull(),
  // encrypted blob (apiKey / username+password), decrypted only server-side
  secretEnc: text("secret_enc"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  extraJson: text("extra_json"), // adapter-specific config (JSON)
  lastHealthy: integer("last_healthy"),
  lastStatus: text("last_status"),
  updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
});

/** Named destination libraries for manual intake (books/manga/music). */
export const libraries = sqliteTable("libraries", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  key: text("key").notNull().unique(), // e.g. kavita-books, kavita-manga, navidrome-music
  label: text("label").notNull(),
  kind: text("kind").notNull(), // books|manga|comics|music
  targetService: text("target_service").notNull(), // kavita|navidrome
  destPath: text("dest_path").notNull(), // must be inside approved roots
  stagingPath: text("staging_path").notNull(),
  rescan: integer("rescan", { mode: "boolean" }).notNull().default(true),
});

/** Durable job queue for manual intake pipelines. */
export const jobs = sqliteTable(
  "jobs",
  {
    id: text("id").primaryKey(), // uuid
    type: text("type").notNull(), // manual_intake
    status: text("status").notNull().default("queued"), // queued|running|completed|failed|dead
    idempotencyKey: text("idempotency_key").unique(),
    libraryKey: text("library_key"),
    sourcePath: text("source_path").notNull(),
    payloadJson: text("payload_json"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    nextRunAt: integer("next_run_at").notNull().default(sql`(unixepoch() * 1000)`),
    lastError: text("last_error"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    byStatus: index("jobs_status_idx").on(t.status),
    byNext: index("jobs_next_idx").on(t.nextRunAt),
  }),
);

/** Append-only audit/activity timeline for jobs and requests. */
export const activity = sqliteTable(
  "activity",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    jobId: text("job_id"),
    kind: text("kind").notNull(), // requested|queued|downloading|completed|importing|imported|failed|info
    service: text("service"),
    message: text("message").notNull(),
    dataJson: text("data_json"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    byJob: index("activity_job_idx").on(t.jobId),
    byCreated: index("activity_created_idx").on(t.createdAt),
  }),
);

export type User = typeof users.$inferSelect;
export type Service = typeof services.$inferSelect;
export type Library = typeof libraries.$inferSelect;
export type Job = typeof jobs.$inferSelect;
export type ActivityRow = typeof activity.$inferSelect;
