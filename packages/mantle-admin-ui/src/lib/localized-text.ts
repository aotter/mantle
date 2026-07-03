import type { LocalizedText } from "./types";

/**
 * Client-side copy of `resolveLocalizedText` from
 * `@aotter/mantle-spec`'s manifest grammar (#430). Kept in sync by
 * hand rather than imported — `mantle-admin-ui` has no dependency on
 * `@aotter/mantle-spec` (same reasoning as the inlined
 * `VIEW_PARAMS_RESERVED` copy in `features/ops/view-page.tsx`: this
 * package only talks JSON over HTTP to the admin API).
 *
 * Resolves a `LocalizedText` value to a single displayable string for
 * `preferred` (the viewer's chosen admin language), falling back to
 * `canonical` (the site's canonical locale, when supplied) and finally
 * to the record's first own-enumerable entry (insertion order). A
 * plain string is returned as-is — even an empty string; only
 * `null`/`undefined` map to `null`. An empty record also resolves to
 * `null` since there's nothing to fall back to.
 */
export function resolveLocalizedText(
  value: LocalizedText | null | undefined,
  preferred: string,
  canonical?: string | null,
): string | null {
  if (value == null) return null;
  if (typeof value === "string") return value;
  if (Object.prototype.hasOwnProperty.call(value, preferred)) {
    return value[preferred]!;
  }
  if (canonical && Object.prototype.hasOwnProperty.call(value, canonical)) {
    return value[canonical]!;
  }
  const firstKey = Object.keys(value)[0];
  return firstKey !== undefined ? value[firstKey]! : null;
}
