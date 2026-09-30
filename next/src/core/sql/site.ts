/**
 * `site_config` over a SQLite-family driver, and the canonical migrations of Core's product tables. The DDL and the migration
 * ids are 0.1.x's; ownership is proven by next's own `_mantle_migrations` ledger. Upgrading a 0.1.x database in place is a
 * separate step, not built yet. A new id is never purely numeric (`0004-…`): 0.1.x ledgers already hold those.
 *
 * Operator fields (`brand`, `title`, `description`) are seeded once: the database wins once a row exists, so a later code
 * edit never overwrites what the owner set in Admin. Deployment fields (`origin`, icons, `locales`, media purposes) have no
 * edit path but code, so every boot syncs them, writing only what changed. A blank default is skipped (#441).
 */
import { DEFAULT_SITE_ICONS, assertSiteDefaultsCanonical, type MediaPurposePolicy, type SiteConfig, type SiteDefaults, type SiteIcon } from "../../spec/domain/index.js";
import type { DatabaseDriver, SqlStatement } from "../driver.js";
import type { MantleSite } from "../site.js";
import { mediaLibrary } from "./media.js";
import { runMigrations, type Migration } from "./migrations.js";

export const CORE_MIGRATIONS: readonly Migration[] = [
  // 0.1.x's 0001-init also created Better Auth's tables; mantle-auth now migrates those itself
  { id: "0001-init", tables: ["site_config"], sql: "CREATE TABLE IF NOT EXISTS site_config (key TEXT PRIMARY KEY, value TEXT NOT NULL)" },
  {
    id: "0002-media-assets", tables: ["media_assets"],
    sql: `CREATE TABLE IF NOT EXISTS media_assets (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, owner_id TEXT, alt TEXT, caption TEXT, variants TEXT NOT NULL, metadata TEXT);
      CREATE INDEX IF NOT EXISTS media_assets_by_owner_created ON media_assets (owner_id, created_at DESC)`,
  },
  {
    id: "0003-pending-media-uploads", tables: ["pending_media_uploads"],
    sql: `CREATE TABLE IF NOT EXISTS pending_media_uploads (id TEXT PRIMARY KEY, record TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS pending_media_uploads_expires_at ON pending_media_uploads (expires_at)`,
  },
];

const nonBlank = (v: string | undefined) => (v ? v : undefined);
const parse = <T>(raw: string | undefined, fallback: T): T => { try { return raw ? JSON.parse(raw) as T : fallback; } catch { return fallback; } };

/** The stored rows as the runtime reads them; no rows is every default. */
export function siteConfigOf(rows: readonly Record<string, unknown>[]): SiteConfig {
  const m = new Map(rows.map((r) => [String(r.key), String(r.value)]));
  const locales = (m.get("locales") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const purposes = parse<unknown>(m.get("mediaPurposes"), []);
  const icons = m.get("faviconUrl");
  // 0.1 alphas stored one plain favicon URL
  const parsedIcons = parse<unknown>(icons, icons ? [{ src: icons }] : DEFAULT_SITE_ICONS);
  return {
    title: m.get("title") ?? "CMS", description: m.get("description") ?? "", origin: m.get("origin") ?? "",
    locales, canonicalLocale: locales[0] ?? null, brand: m.get("brand") ?? "AotterMantle",
    icons: Array.isArray(parsedIcons) && parsedIcons.length ? parsedIcons as SiteIcon[] : DEFAULT_SITE_ICONS,
    media: { purposes: Array.isArray(purposes) ? purposes as MediaPurposePolicy[] : [] },
  };
}

const upsert = (key: string, value: string): SqlStatement => ({ sql: "INSERT INTO site_config (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value", binds: [key, value] });

/** Migrates the product tables, seeds and syncs the defaults, and returns the capability. Runs at every boot. */
export async function prepareSite(driver: DatabaseDriver, defaults: SiteDefaults): Promise<MantleSite> {
  assertSiteDefaultsCanonical(defaults);
  await runMigrations(driver, CORE_MIGRATIONS);
  const [stored] = await driver.batch([{ sql: "SELECT key, value FROM site_config" }]);
  const have = new Map(stored!.rows.map((r) => [String(r.key), String(r.value)]));
  const writes: SqlStatement[] = [];
  for (const [key, value] of [["brand", defaults.brand], ["title", defaults.title], ["description", defaults.description]] as const)
    if (value && !have.has(key)) writes.push({ sql: "INSERT INTO site_config (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO NOTHING", binds: [key, value] });
  const synced: [string, string | undefined][] = [
    ["origin", nonBlank(defaults.origin)],
    ["faviconUrl", JSON.stringify(defaults.icons ?? DEFAULT_SITE_ICONS)],
    ["locales", defaults.locales?.length ? defaults.locales.join(",") : undefined],
    ["mediaPurposes", defaults.media?.purposes?.length ? JSON.stringify(defaults.media.purposes) : undefined],
  ];
  for (const [key, value] of synced) if (value !== undefined && have.get(key) !== value) writes.push(upsert(key, value));
  if (writes.length) await driver.batch(writes);

  const read = async () => siteConfigOf((await driver.batch([{ sql: "SELECT key, value FROM site_config" }]))[0]!.rows);
  return {
    read,
    async updateSettings(values) {
      const writes = (["brand", "title", "description"] as const).flatMap((k) => (typeof values[k] === "string" ? [upsert(k, values[k]!)] : []));
      if (writes.length) await driver.batch(writes);
      return read();
    },
    media: (storage) => mediaLibrary(driver, storage, async () => (await read()).media.purposes),
  };
}
