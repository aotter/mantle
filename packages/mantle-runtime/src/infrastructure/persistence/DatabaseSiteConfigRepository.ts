import {
  assertSiteDefaultsCanonical,
  type MediaPurposePolicy,
  type SiteConfig,
  type SiteDefaults,
} from "@aotter/mantle-spec";
import type { DatabaseDriver } from "../../domain/port/DatabaseDriver.js";
import type { SiteConfigRepository } from "../../domain/port/SiteConfigRepository.js";

/**
 * `site_config` row read/write. `seed` runs once per boot (called from
 * `bootInit`) and treats keys differently depending on who owns them:
 *
 * - **UI-editable, seed-once** (`brand`, `title`, `description`,
 *   `origin`, `faviconUrl`, `ga4MeasurementId`, `facebookPixelId`):
 *   written via INSERT … ON CONFLICT DO NOTHING. The admin settings
 *   UI (`/admin/api/site-settings`) can edit a subset of these
 *   directly, and the rest are conceptually the same "operator can
 *   override" bucket — either way, DB wins once the row exists, so a
 *   later `mantleConfig.ts` edit never clobbers an operator's change.
 *
 * - **code-canonical, boot-synced** (`mediaPurposes`, `locales`):
 *   these have no admin-UI edit path — `mantleConfig.ts` is the only
 *   source of truth — so `seed` upserts them on every boot, writing
 *   only when the serialized value actually differs from what's
 *   stored (read-compare-write; avoids a write on every boot when
 *   nothing changed). Fixes #441: pre-fix, both classes were
 *   DO-NOTHING, so a `mediaPurposes` edit in code (new mime, new
 *   purpose, adjusted `maxBytes`) silently never reached a
 *   already-deployed site's D1 row.
 *
 * The runtime calls `seed` once during bootInit; the result of `load`
 * is what every render path and template sees.
 *
 * `mediaPurposes` is JSON-encoded (an array of `MediaPurposePolicy`
 * objects) because the v0.1.x → v0.1.x #272 shape carries
 * per-purpose required mime set + per-mime byte caps. Older CSV-form
 * rows from pre-#272 deployments would round-trip as a single string;
 * pre-v0.1 means we accept the breaking change rather than maintain
 * a parser fork — operators rerun seed (or wipe the row) after
 * upgrading.
 *
 * Lives in `infrastructure/persistence/` because it talks to the DB
 * directly. Pure-domain validation (`assertSiteDefaultsCanonical`)
 * comes from spec.
 */
const KEYS = {
  brand: "brand",
  title: "title",
  description: "description",
  origin: "origin",
  locales: "locales",
  faviconUrl: "faviconUrl",
  ga4MeasurementId: "ga4MeasurementId",
  facebookPixelId: "facebookPixelId",
  mediaPurposes: "mediaPurposes",
} as const;

function splitCsv(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
}

function parseMediaPurposes(raw: string | undefined): readonly MediaPurposePolicy[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as readonly MediaPurposePolicy[];
  } catch {
    return [];
  }
}

export class DatabaseSiteConfigRepository implements SiteConfigRepository {
  constructor(private readonly db: DatabaseDriver) {}

  async seed(defaults: SiteDefaults | undefined): Promise<void> {
    if (!defaults) return;
    assertSiteDefaultsCanonical(defaults);
    const stmts = [];
    const insertOnce = (key: string, value: string) =>
      this.db
        .prepare(`INSERT INTO site_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING`)
        .bind(key, value);
    // UI-editable, seed-once — DB wins once the row exists.
    if (defaults.brand && defaults.brand.length > 0) {
      stmts.push(insertOnce(KEYS.brand, defaults.brand));
    }
    if (defaults.title && defaults.title.length > 0) {
      stmts.push(insertOnce(KEYS.title, defaults.title));
    }
    if (defaults.description && defaults.description.length > 0) {
      stmts.push(insertOnce(KEYS.description, defaults.description));
    }
    if (defaults.origin && defaults.origin.length > 0) {
      stmts.push(insertOnce(KEYS.origin, defaults.origin));
    }
    if (defaults.faviconUrl && defaults.faviconUrl.length > 0) {
      stmts.push(insertOnce(KEYS.faviconUrl, defaults.faviconUrl));
    }
    if (defaults.ga4MeasurementId && defaults.ga4MeasurementId.length > 0) {
      stmts.push(insertOnce(KEYS.ga4MeasurementId, defaults.ga4MeasurementId));
    }
    if (defaults.facebookPixelId && defaults.facebookPixelId.length > 0) {
      stmts.push(insertOnce(KEYS.facebookPixelId, defaults.facebookPixelId));
    }
    if (stmts.length > 0) {
      await this.db.batch(stmts);
    }

    // Code-canonical, boot-synced — no admin-UI edit path for these
    // keys, so `mantleConfig.ts` is the only source of truth. Upsert
    // whenever the serialized value differs from what's stored;
    // read-compare-write avoids issuing a write on every boot when
    // nothing actually changed (#441).
    const syncedValues: Array<[string, string | undefined]> = [
      [KEYS.locales, defaults.locales && defaults.locales.length > 0 ? defaults.locales.join(",") : undefined],
      [
        KEYS.mediaPurposes,
        defaults.media?.purposes && defaults.media.purposes.length > 0
          ? JSON.stringify(defaults.media.purposes)
          : undefined,
      ],
    ];
    for (const [key, value] of syncedValues) {
      if (value === undefined) continue;
      await this.upsertIfChanged(key, value);
    }
  }

  private async upsertIfChanged(key: string, value: string): Promise<void> {
    const current = await this.db
      .prepare(`SELECT value FROM site_config WHERE key = ?`)
      .bind(key)
      .first<{ value: string }>();
    if (current?.value === value) return;
    await this.db
      .prepare(
        `INSERT INTO site_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .bind(key, value)
      .run();
  }

  async load(): Promise<SiteConfig> {
    const rows = await this.db
      .prepare(`SELECT key, value FROM site_config`)
      .all<{ key: string; value: string }>();
    const m = new Map(rows.map((r) => [r.key, r.value]));
    const locales = splitCsv(m.get(KEYS.locales));
    const purposes = parseMediaPurposes(m.get(KEYS.mediaPurposes));
    return {
      title: m.get(KEYS.title) ?? "CMS",
      description: m.get(KEYS.description) ?? "",
      origin: m.get(KEYS.origin) ?? "",
      locales,
      canonicalLocale: locales[0] ?? null,
      brand: m.get(KEYS.brand) ?? "AotterMantle",
      faviconUrl: m.get(KEYS.faviconUrl) || undefined,
      ga4MeasurementId: m.get(KEYS.ga4MeasurementId) || undefined,
      facebookPixelId: m.get(KEYS.facebookPixelId) || undefined,
      media: { purposes },
    };
  }

  async readLocales(): Promise<readonly string[]> {
    const row = await this.db
      .prepare(`SELECT value FROM site_config WHERE key = ?`)
      .bind(KEYS.locales)
      .first<{ value: string }>();
    return splitCsv(row?.value);
  }

  async readMediaPurposes(): Promise<readonly MediaPurposePolicy[]> {
    const row = await this.db
      .prepare(`SELECT value FROM site_config WHERE key = ?`)
      .bind(KEYS.mediaPurposes)
      .first<{ value: string }>();
    return parseMediaPurposes(row?.value);
  }
}
