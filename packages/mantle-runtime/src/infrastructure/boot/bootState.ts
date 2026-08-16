import type { SiteDefaults } from "@aotter/mantle-spec";
import type { DatabaseDriver } from "../../domain/port/DatabaseDriver.js";
import { CANONICAL_MIGRATIONS } from "./canonicalMigrations.js";

const BOOT_STATE_ID = "runtime";

export async function bootFingerprint(input: {
  readonly semanticFingerprint: string;
  readonly siteDefaults?: SiteDefaults;
}): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify({
    version: 2,
    migrations: CANONICAL_MIGRATIONS.map(({ id, sql }) => [id, sql]),
    ...input,
  }));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function isBootCurrent(db: DatabaseDriver, fingerprint: string): Promise<boolean> {
  try {
    const row = await db
      .prepare("SELECT fingerprint FROM _mantle_boot_state WHERE id = ? LIMIT 1")
      .bind(BOOT_STATE_ID)
      .first<{ fingerprint: string }>();
    return row?.fingerprint === fingerprint;
  } catch {
    // First boot and pre-alpha.5 databases do not have the marker table yet.
    return false;
  }
}

export async function markBootCurrent(db: DatabaseDriver, fingerprint: string): Promise<void> {
  await db
    .prepare(
      "INSERT INTO _mantle_boot_state (id, fingerprint) VALUES (?, ?) " +
        "ON CONFLICT(id) DO UPDATE SET fingerprint = excluded.fingerprint",
    )
    .bind(BOOT_STATE_ID, fingerprint)
    .run();
}
