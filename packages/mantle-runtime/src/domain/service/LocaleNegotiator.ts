import {
  DEFAULT_SITE_ICONS,
  URL_LOCALE,
  toUrlLocale,
  type SiteConfig,
  type SiteDefaults,
} from "@aotter/mantle-spec";

/**
 * Locale + SiteConfig helpers used at request entry by every public
 * router. Pure functions on existing spec types — no I/O, no env.
 *
 *   - `siteConfigFromDefaults` materializes a runtime `SiteConfig`
 *     from a consumer's `SiteDefaults` (the author-time declaration).
 *     Fills `canonicalLocale` from `locales[0]`, defaults missing
 *     fields to empty string. Adapters that don't go through the
 *     DB-backed `SiteConfigRepository` use this.
 *
 *   - `inferLocaleFromPath` reads the first URL path segment, matches
 *     it case-insensitively against `site.locales`, and returns the
 *     canonical locale (preserving the casing in `site.locales`) on
 *     hit. On miss, returns `site.canonicalLocale` (or `"en"` if the
 *     site has no locales configured — should never happen for a
 *     localized site).
 *
 *   - `isKnownLocale` answers "is this URL segment a valid locale for
 *     this site?" for adapters that need to 404 vs render-locale-home.
 */
export function siteConfigFromDefaults(defaults: SiteDefaults): SiteConfig {
  const locales = [...(defaults.locales ?? [])];
  return {
    brand: defaults.brand ?? "",
    title: defaults.title ?? defaults.brand ?? "",
    description: defaults.description ?? "",
    origin: defaults.origin ?? "",
    locales,
    canonicalLocale: locales[0] ?? null,
    icons: defaults.icons ?? DEFAULT_SITE_ICONS,
    media: { purposes: [...(defaults.media?.purposes ?? [])] },
  };
}

export function inferLocaleFromPath(path: string, site: SiteConfig): string {
  const seg = path.split("/")[1] ?? "";
  // URL_LOCALE rejects anything that doesn't fit `xx` / `xx-yy` (lowercase
  // only), matching what the public router actually serves — so a
  // request for `/llms.txt` doesn't accidentally tag itself with locale
  // "llms.txt" even before the `site.locales` membership check.
  if (seg && URL_LOCALE.test(seg.toLowerCase())) {
    const segLower = seg.toLowerCase();
    for (const l of site.locales) {
      if (toUrlLocale(l) === segLower) return l;
    }
  }
  return site.canonicalLocale ?? site.locales[0] ?? "en";
}

export function isKnownLocale(locale: string, site: SiteConfig): boolean {
  if (!locale) return false;
  const target = locale.toLowerCase();
  if (!URL_LOCALE.test(target)) return false;
  return site.locales.some((l) => toUrlLocale(l) === target);
}

/** Canonical → URL form mirror of spec's `toUrlLocale`, re-exported
 *  here so adapters can import locale helpers from one runtime path
 *  without reaching into spec's domain. */
export { toUrlLocale };
