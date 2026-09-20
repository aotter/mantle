import { resolveLocalizedText } from "./localized-text";
import type { AdminLanguage } from "../app/preferences";
import type { JsonSchema } from "./types";

/** Kebab/snake/camelCase identifier to a human-readable label. */
export function fieldLabel(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

/** Prefer a localized schema title, then humanize the property name. */
export function propertyLabel(
  name: string,
  schema: JsonSchema | undefined,
  language: AdminLanguage,
  canonical: string | null,
): string {
  return resolveLocalizedText(schema?.title, language, canonical) ?? fieldLabel(name);
}

/** Resolve optional localized schema help text. */
export function propertyDescription(
  schema: JsonSchema | undefined,
  language: AdminLanguage,
  canonical: string | null,
): string | undefined {
  return resolveLocalizedText(schema?.description, language, canonical) ?? undefined;
}
