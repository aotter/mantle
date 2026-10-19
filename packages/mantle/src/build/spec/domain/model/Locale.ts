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

export class InvalidLocaleError extends Error {
  constructor(value: string) {
    super(`invalid locale: ${value}`);
    this.name = "InvalidLocaleError";
  }
}
