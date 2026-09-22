import type { SiteDefaults } from "@aotter/mantle-spec";
import type { DatabaseDriver } from "../../domain/port/DatabaseDriver.js";
import type { Migration } from "../../domain/port/DatabaseDriver.js";
import { CANONICAL_MIGRATIONS } from "./canonicalMigrations.js";

const BOOT_STATE_ID = "runtime";

export async function bootFingerprint(input: {
  readonly semanticFingerprint: string;
  readonly siteDefaults?: SiteDefaults;
  readonly schemaMigrations?: readonly Migration[];
}): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify({
    version: 2,
    migrations: CANONICAL_MIGRATIONS.map(({ id, sql }) => [id, sql]),
    schemaMigrations: input.schemaMigrations?.map(({ id, sql }) => [id, sql]),
    semanticFingerprint: input.semanticFingerprint,
    siteDefaults: input.siteDefaults,
  }));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function isBootCurrent(db: DatabaseDriver, fingerprint: string): Promise<boolean> {
  try {
    const row = await db
      .prepare("SELECT fingerprint, store_instance_id FROM _mantle_boot_state WHERE id = ? LIMIT 1")
      .bind(BOOT_STATE_ID)
      .first<{ fingerprint: string; store_instance_id: string | null }>();
    return row?.fingerprint === fingerprint && Boolean(row.store_instance_id);
  } catch {
    // First boot and pre-alpha.5 databases do not have the marker table yet.
    return false;
  }
}

export async function markBootCurrent(db: DatabaseDriver, fingerprint: string): Promise<void> {
  await db
    .prepare(
      "INSERT INTO _mantle_boot_state (id, fingerprint, store_instance_id) VALUES (?, ?, ?) " +
        "ON CONFLICT(id) DO UPDATE SET fingerprint = excluded.fingerprint, " +
        "store_instance_id = COALESCE(_mantle_boot_state.store_instance_id, excluded.store_instance_id)",
    )
    .bind(BOOT_STATE_ID, fingerprint, crypto.randomUUID())
    .run();
}

/** Identity minted by the store itself; derivative caches use it as a namespace. */
export async function readStoreInstanceId(db: DatabaseDriver): Promise<string> {
  const row = await db
    .prepare("SELECT store_instance_id FROM _mantle_boot_state WHERE id = ? LIMIT 1")
    .bind(BOOT_STATE_ID)
    .first<{ store_instance_id: string | null }>();
  if (!row?.store_instance_id) throw new Error("Mantle storage must be prepared before using derivative storage.");
  return row.store_instance_id;
}
