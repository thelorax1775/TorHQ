import { eq } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { services, libraries, type Service, type Library } from "../db/schema.js";
import { encryptSecret, decryptSecret, maskSecret } from "../lib/crypto.js";

export const SERVICE_KINDS = [
  "qbittorrent", "radarr", "sonarr", "lidarr", "prowlarr",
  "slskd", "jellyfin", "navidrome", "kavita",
] as const;
export type ServiceKind = (typeof SERVICE_KINDS)[number];

export interface DecryptedService {
  kind: string;
  label: string;
  baseUrl: string;
  secret: string; // apiKey or "user:pass" depending on adapter
  enabled: boolean;
  extra: Record<string, unknown>;
}

/** Persist a service config, encrypting its secret. Never stores plaintext. */
export function upsertService(
  input: { kind: string; label: string; baseUrl: string; secret?: string; enabled?: boolean; extra?: Record<string, unknown> },
  masterKey: Buffer,
): void {
  const db = getDb();
  const existing = db.select().from(services).where(eq(services.kind, input.kind)).get();
  const secretEnc = input.secret
    ? encryptSecret(input.secret, masterKey)
    : existing?.secretEnc ?? null; // keep prior secret if not re-sent
  const row = {
    kind: input.kind,
    label: input.label,
    baseUrl: input.baseUrl.replace(/\/+$/, ""),
    secretEnc,
    enabled: input.enabled ?? true,
    extraJson: input.extra ? JSON.stringify(input.extra) : existing?.extraJson ?? null,
    updatedAt: Date.now(),
  };
  if (existing) {
    db.update(services).set(row).where(eq(services.kind, input.kind)).run();
  } else {
    db.insert(services).values(row).run();
  }
}

export function getServiceDecrypted(kind: string, masterKey: Buffer): DecryptedService | null {
  const db = getDb();
  const row = db.select().from(services).where(eq(services.kind, kind)).get();
  if (!row) return null;
  return {
    kind: row.kind,
    label: row.label,
    baseUrl: row.baseUrl,
    secret: row.secretEnc ? decryptSecret(row.secretEnc, masterKey) : "",
    enabled: row.enabled,
    extra: row.extraJson ? JSON.parse(row.extraJson) : {},
  };
}

/** Public/browser-safe view: secrets are masked, never returned in full. */
export function listServicesSafe(): Array<
  Pick<Service, "kind" | "label" | "baseUrl" | "enabled" | "lastHealthy" | "lastStatus"> & { secretMask: string | null }
> {
  const db = getDb();
  return db.select().from(services).all().map((r) => ({
    kind: r.kind,
    label: r.label,
    baseUrl: r.baseUrl,
    enabled: r.enabled,
    lastHealthy: r.lastHealthy,
    lastStatus: r.lastStatus,
    secretMask: r.secretEnc ? maskSecret(r.secretEnc) : null,
  }));
}

export function setServiceHealth(kind: string, healthy: boolean, status: string): void {
  const db = getDb();
  db.update(services)
    .set({ lastHealthy: healthy ? Date.now() : null, lastStatus: status, updatedAt: Date.now() })
    .where(eq(services.kind, kind))
    .run();
}

export function upsertLibrary(lib: Omit<Library, "id">): void {
  const db = getDb();
  const existing = db.select().from(libraries).where(eq(libraries.key, lib.key)).get();
  if (existing) db.update(libraries).set(lib).where(eq(libraries.key, lib.key)).run();
  else db.insert(libraries).values(lib).run();
}

export function listLibraries(): Library[] {
  return getDb().select().from(libraries).all();
}

export function getLibrary(key: string): Library | undefined {
  return getDb().select().from(libraries).where(eq(libraries.key, key)).get();
}
