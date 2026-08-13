/**
 * Site-level declarative contract — sibling to the manifest grammar,
 * not part of it.
 *
 * The 4-atom manifest grammar (Schema/View/Procedure/Trigger) describes
 * content types. `SiteConfig` describes deployment metadata: locales the
 * site publishes in, brand label, the operator-visible title and
 * description, the canonical absolute origin used for canonical URLs.
 *
 * Lives in `mantle-spec` (not `-runtime`) because the spec validator
 * checks declared `siteDefaults.locales` are canonical BCP 47 at boot
 * (see `domain/service/SiteDefaultsValidator`). The runtime operations
 * that read/write `site_config` rows from the DB live in
 * `mantle-runtime` — they go through the `DatabaseDriver`.
 *
 * Future v0.1.x: optional standalone `site.yaml` parsed via a
 * `kind: SiteConfig` envelope sibling to the 4-atom manifest grammar.
 * Today the consumer declares `siteDefaults` in `src/mantle/config.ts` as a
 * TS object; either path conforms to this type.
 */
export interface SiteConfig {
  /** Site title — `<title>` suffix and og:site_name. */
  readonly title: string;
  /** Default `<meta name="description">` when an entry has none. */
  readonly description: string;
  /** Canonical absolute origin (no trailing slash), e.g. `https://my-blog.com`. */
  readonly origin: string;
  /** All locales the site publishes in. Empty = locale subsystem off
   *  site-wide (ADR-0010). Drives `<link rel="alternate" hreflang>`
   *  emission only when non-empty. */
  readonly locales: readonly string[];
  /** Canonical locale (`locales[0]`) or `null` when locales is empty.
   *  Templates emit `<html lang="">` only when this is non-null —
   *  silent omission is correct for zero-locale sites, not a fake
   *  default. */
  readonly canonicalLocale: string | null;
  /** Operator-facing brand label — admin chrome (sidebar header,
   *  sign-in card). Distinct from `title` so single-tenant operators
   *  can ship one and agencies can override the other. */
  readonly brand: string;
  /** Absolute or root-relative favicon URL. Omit to use the SDK's
   *  default AotterMantle mark at `/favicon.svg`. */
  readonly faviconUrl?: string;
  /** GA4 Measurement ID (for example `G-XXXXXXXXXX`). When present,
   *  the runtime injects the standard gtag snippet into rendered
   *  storefront HTML. */
  readonly ga4MeasurementId?: string;
  /** Facebook/Meta Pixel ID. When present, the runtime injects the
   *  standard Pixel base snippet into rendered storefront HTML. */
  readonly facebookPixelId?: string;
  /** Starter-declared media taxonomy. Empty array = no first-party
   *  media uploads permitted; the runtime disables the
   *  `create_media_upload` / `commit_media_upload` MCP tools and the
   *  admin upload lifecycle on deployments that don't declare any
   *  purpose, symmetric with "no `MediaStorage` configured". When
   *  non-empty, `create_media_upload` rejects any `purpose` not in
   *  this set with `MEDIA_PURPOSE_REJECTED`. */
  readonly media: SiteMediaConfig;
}

/** Runtime read shape for the `media` section of `SiteConfig`. Always
 *  present after seed; `purposes` may be empty when the consumer
 *  didn't declare any. Each purpose carries the required mime set the
 *  Worker enforces and the per-mime byte cap the uploader is held to. */
export interface SiteMediaConfig {
  readonly purposes: readonly MediaPurposePolicy[];
}

/**
 * Per-purpose policy. `name` is the slug consumers reference from
 * `create_media_upload`; `required` is the closed set of mime types
 * the variants manifest MUST cover; `maxBytes` caps each variant's
 * byteSize keyed by its declared mime.
 *
 * Optimization runs agent-side in the MCP client's runtime; the
 * Worker only verifies the uploaded bytes match the policy. The
 * runtime also enforces a "suspicious shape" heuristic so an uploader
 * that ships a 200KB jpeg + a 400KB "avif" (i.e. forgot to optimize)
 * fails closed rather than producing a `<picture>` that's slower than
 * a plain `<img>`.
 */
export interface MediaPurposePolicy {
  /** Lowercase-slug identifier; matches `MEDIA_PURPOSE_SLUG_PATTERN`. */
  readonly name: string;
  /**
   * Ordered list of acceptable mime slots. Each entry uses the HTML
   * `<input accept="...">` grammar:
   *
   *   - full mime:           `"image/jpeg"`, `"image/avif"`
   *   - comma-list of mimes: `"image/jpg,image/png"` (either is OK)
   *   - shorthand subtype:   `"webp"` → `"image/webp"`,
   *                          `"jpg"` → `"image/jpeg"`
   *
   * Slot position does NOT determine variant role. Per-asset, the
   * agent picks ONE mime per slot from that slot's acceptable set
   * and independently declares exactly one supplied variant as
   * `role: "primary"` (the format `<img>` falls back to); the rest
   * are `role: "alternate"` (preferred via `<picture><source>`).
   * This decoupling preserves back-compat with alpha.14 fixtures
   * such as `["image/avif", "image/webp", "image/jpeg"]` that ship
   * jpeg as primary despite avif occupying slot 0. The multi-mime
   * slot form (e.g. `"image/jpg,image/png"`) lets a single purpose
   * accept either jpeg-primary (photos) or png-primary (logos /
   * transparent assets) without splitting into two purposes.
   *
   * Parse + expand via `parseMimeAccept` / `expandPolicyRequired`.
   * Mime sets across slots MUST NOT overlap; `maxBytes` keys MUST
   * cover every mime that appears in any expanded slot.
   *
   * See aotter/mantle#282 for the editor-uploads-transparent-PNG
   * motivating case.
   */
  readonly required: readonly string[];
  /** Per-mime byte cap, keyed by FULLY-EXPANDED mime type (e.g.
   *  `"image/jpeg"`, not the shorthand `"jpg"`). MUST cover every
   *  mime that appears in any slot of `required` after parsing.
   *  Mimes outside the expanded set are ignored. The use case
   *  rejects with `MEDIA_VARIANT_SIZE_EXCEEDED` when a variant's
   *  declared `byteSize` exceeds its cap. */
  readonly maxBytes: Readonly<Record<string, number>>;
}

/**
 * Defaults declared by the consumer in `src/mantle/config.ts`. Operator-owned
 * fields seed once, while deployment-owned fields (`origin`, `locales`, and
 * media purposes) sync on every boot. Empty / blank fields skip, preventing a
 * partial declaration from clobbering stored values.
 *
 * Validated during `bootInit()` by `assertSiteDefaultsCanonical`; a
 * non-canonical locale tag rejects boot rather than corrupting the seed.
 *
 * `SiteDefaults` is the **author-time** declaration (what the consumer
 * writes); `SiteConfig` (above) is the **runtime read shape**
 * (what the dispatcher and templates see after the seed has been
 * applied and the operator has had a chance to edit). The runtime's
 * `DatabaseSiteConfigRepository` owns that seed/load conversion; spec defines
 * both types and the validator.
 */
export interface SiteDefaults {
  readonly locales?: ReadonlyArray<string>;
  readonly brand?: string;
  readonly title?: string;
  /** Default `<meta name="description">` and og:description for entries
   *  that don't carry their own. */
  readonly description?: string;
  /** Canonical absolute origin (no trailing slash), e.g.
   *  `https://my-blog.com`. The render pipeline uses this to build
   *  absolute URLs in `/llms.txt` and the `.md` mirrors; an empty
   *  origin produces relative URLs that are useless to off-site agent
   *  consumers. The runtime syncs it from `src/mantle/config.ts` on every boot
   *  so a later custom-domain change becomes canonical without a D1 edit. */
  readonly origin?: string;
  /** Absolute or root-relative favicon URL. */
  readonly faviconUrl?: string;
  /** Optional first-deploy GA4 Measurement ID seed. */
  readonly ga4MeasurementId?: string;
  /** Optional first-deploy Facebook/Meta Pixel ID seed. */
  readonly facebookPixelId?: string;
  /** Starter-declared media taxonomy. See `SiteConfig.media` for
   *  runtime semantics. Omit the whole `media` key (or declare it
   *  with an empty `purposes` array) on archetypes that don't
   *  exercise first-party media uploads — the runtime will keep the
   *  upload tools disabled, symmetric with "no `MediaStorage`
   *  configured". Each purpose's `name` is slug-shaped
   *  (`^[a-z0-9]+(-[a-z0-9]+)*$`); validated synchronously at boot. */
  readonly media?: SiteMediaDefaults;
}

export interface SiteMediaDefaults {
  readonly purposes?: ReadonlyArray<MediaPurposePolicy>;
}

/** Slug regex for `media.purposes[].name`. Matches a lowercase
 *  alphanumeric word, optionally followed by dash-separated
 *  alphanumeric segments — no leading/trailing dashes, no double
 *  dashes. The R2 adapter already uses a looser variant of this for
 *  storage-key prefixes (`/^[a-z0-9-]+$/`); spec-level validation is
 *  stricter so admin / docs / object-store dashboards see clean
 *  slugs. */
export const MEDIA_PURPOSE_SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
