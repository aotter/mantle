import {
  assertSiteDefaultsCanonical,
  DEFAULT_SITE_ICONS,
  type MediaPurposePolicy,
  type SiteConfig,
  type SiteDefaults,
  type SiteIcon,
} from "@aotter/mantle-spec";
import type { DatabaseDriver } from "../../domain/port/DatabaseDriver.js";
import type {
  SiteConfigRepository,
  UpdateEditableSiteConfigArgs,
} from "../../domain/port/SiteConfigRepository.js";

/**
 * `site_config` row read/write. SQLite preparation calls `seed` once per
 * changed revision and treats keys differently depending on who owns them:
 *
 * - **UI-editable, seed-once** (`brand`, `title`, `description`,
 *   `ga4MeasurementId`, `facebookPixelId`):
 *   written via INSERT … ON CONFLICT DO NOTHING. The admin settings
 *   UI (`/admin/api/site-settings`) can edit a subset of these
 *   directly, and the rest are conceptually the same "operator can
 *   override" bucket — either way, DB wins once the row exists, so a
 *   later `src/mantle/config.ts` edit never clobbers an operator's change.
 *
 * - **code-canonical, boot-synced** (`origin`, `icons`, `mediaPurposes`, `locales`):
 *   these have no admin-UI edit path — `src/mantle/config.ts` is the only
 *   source of truth — so `seed` upserts them on every boot, writing
 *   only when the serialized value actually differs from what's
 *   stored (read-compare-write; avoids a write on every boot when
 *   nothing changed). Fixes #441: pre-fix, both classes were
 *   DO-NOTHING, so a `mediaPurposes` edit in code (new mime, new
 *   purpose, adjusted `maxBytes`) silently never reached a
 *   already-deployed site's D1 row.
 *
 * SQLite preparation calls `seed`; the result of `load`
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

const EDITABLE_KEYS = [
  KEYS.brand,
  KEYS.title,
  KEYS.description,
  KEYS.ga4MeasurementId,
  KEYS.facebookPixelId,
] as const;

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

function parseIcons(raw: string | undefined): readonly SiteIcon[] {
  if (!raw) return DEFAULT_SITE_ICONS;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length > 0
      ? parsed as readonly SiteIcon[]
      : DEFAULT_SITE_ICONS;
  } catch {
    // Alpha compatibility: older releases stored one plain favicon URL.
    return [{ src: raw }];
  }
}

export class DatabaseSiteConfigRepository implements SiteConfigRepository {
  private cacheLocales = false;
  private cachedLocales: readonly string[] | undefined;

  constructor(private readonly db: DatabaseDriver) {}

  async seed(defaults: SiteDefaults | undefined): Promise<void> {
    this.cacheLocales = false;
    this.cachedLocales = undefined;
    if (!defaults) {
      this.cacheLocales = true;
      return;
    }
    assertSiteDefaultsCanonical(defaults);
    const seedOnceValues: Array<[string, string | undefined]> = [
      [KEYS.brand, defaults.brand],
      [KEYS.title, defaults.title],
      [KEYS.description, defaults.description],
      [KEYS.ga4MeasurementId, defaults.ga4MeasurementId],
      [KEYS.facebookPixelId, defaults.facebookPixelId],
    ];
    const insertOnce = (key: string, value: string) =>
      this.db
        .prepare(`INSERT INTO site_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING`)
        .bind(key, value);
    // UI-editable, seed-once — DB wins once the row exists.
    const wanted = seedOnceValues.filter(
      (entry): entry is [string, string] => Boolean(entry[1] && entry[1].length > 0),
    );
    if (wanted.length > 0) {
      const existing = new Set(
        (await this.db.prepare(`SELECT key, value FROM site_config`).all<{ key: string }>())
          .map(({ key }) => key),
      );
      const missing = wanted
        .filter(([key]) => !existing.has(key))
        .map(([key, value]) => insertOnce(key, value));
      if (missing.length > 0) await this.db.batch(missing);
    }

    // Code-canonical, boot-synced — no admin-UI edit path for these
    // keys, so `src/mantle/config.ts` is the only source of truth. Upsert
    // whenever the serialized value differs from what's stored;
    // read-compare-write avoids issuing a write on every boot when
    // nothing actually changed (#441).
    const syncedValues: Array<[string, string | undefined]> = [
      [KEYS.origin, defaults.origin && defaults.origin.length > 0 ? defaults.origin : undefined],
      [KEYS.faviconUrl, defaults.icons ? JSON.stringify(defaults.icons) : undefined],
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
    this.cacheLocales = true;
  }

  private async upsertIfChanged(key: string, value: string): Promise<void> {
    const current = await this.db
      .prepare(`SELECT value FROM site_config WHERE key = ?`)
      .bind(key)
      .first<{ value: string }>();
    if (current?.value === value) return;
    await this.upsert(key, value).run();
  }

  private upsert(key: string, value: string) {
    return this.db
      .prepare(
        `INSERT INTO site_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .bind(key, value);
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
      icons: parseIcons(m.get(KEYS.faviconUrl)),
      ga4MeasurementId: m.get(KEYS.ga4MeasurementId) || undefined,
      facebookPixelId: m.get(KEYS.facebookPixelId) || undefined,
      media: { purposes },
    };
  }

  async updateEditable(values: UpdateEditableSiteConfigArgs): Promise<void> {
    const stmts = [];
    for (const key of EDITABLE_KEYS) {
      const value = values[key];
      if (typeof value !== "string") continue;
      stmts.push(this.upsert(key, value));
    }
    if (stmts.length > 0) await this.db.batch(stmts);
  }

  async readLocales(): Promise<readonly string[]> {
    if (this.cacheLocales && this.cachedLocales) return this.cachedLocales;
    const row = await this.db
      .prepare(`SELECT value FROM site_config WHERE key = ?`)
      .bind(KEYS.locales)
      .first<{ value: string }>();
    const locales = splitCsv(row?.value);
    if (this.cacheLocales) this.cachedLocales = locales;
    return locales;
  }

  async readMediaPurposes(): Promise<readonly MediaPurposePolicy[]> {
    const row = await this.db
      .prepare(`SELECT value FROM site_config WHERE key = ?`)
      .bind(KEYS.mediaPurposes)
      .first<{ value: string }>();
    return parseMediaPurposes(row?.value);
  }
}
