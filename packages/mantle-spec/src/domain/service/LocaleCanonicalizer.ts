import { InvalidLocaleError } from "../model/Locale.js";

/**
 * Mantle v0.1 locale canonicalization. This is a deliberately narrow
 * subset of BCP 47, shared across the SDK: manifest parsing,
 * `site_config.locales` writes, content-ops `data.locale` validation,
 * public router URL segments, boot-time site-config check.
 *
 * 2- or 3-letter ISO 639 language (covers `en`, `ja`, plus 3-letter
 * codes like `fil`, `haw`) + optional 2-letter ISO 3166 region. No
 * script subtag (`zh-Hant`), no variants (`de-1996`). Extend the
 * regexes below — they are the only place the restriction lives.
 *
 * Note: `URL_LOCALE` is stricter than `LANG` (2-letter only) because
 * 3-letter languages don't appear in published URL paths today. If
 * you accept a 3-letter site locale, audit URL_LOCALE consumers
 * before flipping it.
 */

const LANG = /^[a-z]{2,3}$/;
const REGION = /^[a-z]{2}$/;
const SCRIPT_SUBTAG_SHAPE = /^[a-z]{2,3}[-_][a-z]{4}(?:[-_][a-z]{2})?$/i;

/**
 * Accepts `zh-TW`, `zh-tw`, `zh_TW`, `zhTW`, `ZH-tw`, `en` etc. Returns
 * canonical BCP 47 form (`zh-TW`, `en`). Throws `InvalidLocaleError` for
 * anything that doesn't shape up.
 */
export function toCanonicalLocale(input: string): string {
  if (typeof input !== "string" || input.length === 0) {
    throw new InvalidLocaleError(String(input));
  }
  // Split on `-` or `_`; if neither, allow `zhTW` style by inserting
  // the boundary at position 2 (most common 2+2 form).
  let parts = input.replace(/_/g, "-").split("-");
  const head = parts[0];
  if (head === undefined) throw new InvalidLocaleError(input);
  if (parts.length === 1 && head.length === 4) {
    parts = [head.slice(0, 2), head.slice(2)];
  }
  const lang = parts[0]!.toLowerCase();
  if (!LANG.test(lang)) throw new InvalidLocaleError(input);
  if (parts.length === 1) return lang;
  const region = parts[1]!.toLowerCase();
  if (!REGION.test(region)) throw new InvalidLocaleError(input);
  return `${lang}-${region.toUpperCase()}`;
}

/** Canonical → URL form (always lowercase). */
export function toUrlLocale(canonical: string): string {
  return canonical.toLowerCase();
}

/**
 * Best-effort canonicalization. Unlike `toCanonicalLocale`, never
 * throws — returns the original input unchanged when it's malformed.
 * Used for query-side comparisons where a malformed filter value
 * should simply match nothing rather than error.
 */
export function safeCanonicalLocale(input: string): string {
  try {
    return toCanonicalLocale(input);
  } catch {
    return input;
  }
}

/**
 * Canonicalize an array of locale strings, separating valid from
 * invalid in one pass. The caller decides whether to reject (write
 * paths) or warn (read paths) on `invalid.length > 0`.
 *
 * Preserves input order in `valid`; canonicalizes each entry; dedupes
 * the result so `["zh-tw", "zh-TW"]` collapses to `["zh-TW"]`.
 */
export function canonicalizeLocaleList(
  inputs: ReadonlyArray<string>,
): { readonly valid: string[]; readonly invalid: string[] } {
  const valid: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  for (const raw of inputs) {
    try {
      const canonical = toCanonicalLocale(raw);
      if (!seen.has(canonical)) {
        seen.add(canonical);
        valid.push(canonical);
      }
    } catch {
      invalid.push(raw);
    }
  }
  return { valid, invalid };
}

export function containsScriptSubtagLocale(
  inputs: ReadonlyArray<string>,
): boolean {
  return inputs.some((raw) => SCRIPT_SUBTAG_SHAPE.test(raw));
}
