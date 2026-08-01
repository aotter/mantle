import type { MediaPurposePolicy, SiteConfig, SiteDefaults } from "@aotter/mantle-spec";

/**
 * `SiteConfigRepository` — the `site_config` row read/write surface
 * the runtime exposes to render paths and `bootInit`.
 *
 * `seed` runs on every `bootInit` with the config-supplied
 * `siteDefaults`, but treats keys differently depending on ownership:
 * UI-editable keys (brand/title/description/…) seed once (INSERT …
 * ON CONFLICT DO NOTHING) so operator edits are preserved; keys with
 * no admin-UI edit path (`locales`, `mediaPurposes`) are synced from
 * config on every boot (upsert when the value differs) since code is
 * their only source of truth. See `DatabaseSiteConfigRepository`'s
 * header comment for the full rationale (#441).
 *
 * `load` returns the merged view template authors and adapters see.
 * `readLocales` exists separately because boot-time validation needs
 * the locales list before the rest of the row is meaningful.
 *
 * The DB-backed implementation is in
 * `infrastructure/persistence/DatabaseSiteConfigRepository`.
 */
export interface SiteConfigRepository {
  seed(defaults: SiteDefaults | undefined): Promise<void>;
  load(): Promise<SiteConfig>;
  /** Persist the operator-owned subset exposed by the Admin settings UI.
   *  Omitted fields are unchanged; an empty string intentionally clears a
   *  value. Code-canonical locales and media purposes are never writable
   *  through this path. Optional during the `CmsRuntime.db` compatibility
   *  window; canonical Mantle runtimes always provide it. */
  updateEditable?(args: UpdateEditableSiteConfigArgs): Promise<void>;
  readLocales(): Promise<readonly string[]>;
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
