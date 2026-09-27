/**
 * Locale shape constants + the typed parse error.
 *
 * Two forms in play:
 *
 *   - **Canonical** (Mantle v0.1 BCP 47 subset): language lowercase,
 *     region uppercase — e.g. `zh-TW`, `en-US`, `pt-BR`. Used in
 *     storage (entries.locale, KV keys) and HTML metadata
 *     (`<html lang>`, `<link hreflang>`, OG locale).
 *
 *   - **URL**: always lowercase — e.g. `zh-tw`. Used in public URL
 *     paths. Lowercase URLs are more forgiving when users hand-type,
 *     get auto-lowercased by chat clients / CDNs, etc.
 *
 * The conversion functions live in `domain/service/LocaleCanonicalizer`;
 * this file holds the pure shape (regex constants + error class) so
 * model-layer types can reference them without depending on services.
 */

/**
 * URL-form regex: lowercase Mantle locale (`xx` or `xx-yy`). Matches
 * what a public-content router should accept verbatim — strict
 * canonical URL form, no mixed case. Consumer routers can plug this
 * into framework route patterns directly (e.g.
 * Hono's `/:locale{${URL_LOCALE.source}}/`).
 */
export const URL_LOCALE = /^[a-z]{2}(?:-[a-z]{2})?$/;

export class InvalidLocaleError extends Error {
  constructor(value: string) {
    super(`invalid locale: ${value}`);
    this.name = "InvalidLocaleError";
  }
}
