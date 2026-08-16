import type { MediaPurposePolicy, SiteConfig, SiteDefaults } from "@aotter/mantle-spec";

/**
 * `SiteConfigRepository` — the `site_config` row read/write surface
 * optional modules and Core locale policy consume semantically.
 *
 * `seed` runs during selected storage preparation with the config-supplied
 * `siteDefaults`, but treats keys differently depending on ownership:
 * UI-editable keys (brand/title/description/…) seed once (INSERT …
 * ON CONFLICT DO NOTHING) so operator edits are preserved; keys with
 * no admin-UI edit path (`origin`, `locales`, `mediaPurposes`) are synced from
 * config on every changed revision (upsert when the value differs) since code is
 * their only source of truth. See `DatabaseSiteConfigRepository`'s
 * header comment for the full rationale (#441).
 *
 * `load` returns the merged view template authors and adapters see.
 * `readLocales` exists separately because preparation validation needs
 * the locales list before the rest of the row is meaningful.
 *
 * The DB-backed implementation is in
 * `infrastructure/persistence/DatabaseSiteConfigRepository`.
 */
export interface LocalePolicyReader {
  readLocales(): Promise<readonly string[]>;
}

export interface SiteConfigRepository extends LocalePolicyReader {
  seed(defaults: SiteDefaults | undefined): Promise<void>;
  load(): Promise<SiteConfig>;
  /** Persist the operator-owned subset exposed by the Admin settings UI.
   *  Omitted fields are unchanged; an empty string intentionally clears a
   *  value. Code-canonical origin, locales, and media purposes are never writable
   *  through this path. Optional when the selected storage adapter does not
   *  expose operator settings. */
  updateEditable?(args: UpdateEditableSiteConfigArgs): Promise<void>;
  /** Declared media purpose taxonomy (`SiteConfig.media.purposes`).
   *  Empty array when the deployment didn't declare any — symmetric
   *  with "no `MediaStorage` configured" and used by the MCP tool
   *  catalog to gate `create_media_upload` / `commit_media_upload`. */
  readMediaPurposes(): Promise<readonly MediaPurposePolicy[]>;
}

export interface UpdateEditableSiteConfigArgs {
  readonly brand?: string;
  readonly title?: string;
  readonly description?: string;
  readonly ga4MeasurementId?: string;
  readonly facebookPixelId?: string;
}
