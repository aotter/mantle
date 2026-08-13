import type { LocalizedText } from "./types";

/** Resolve preferred locale, site canonical locale, then the first value. */
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
