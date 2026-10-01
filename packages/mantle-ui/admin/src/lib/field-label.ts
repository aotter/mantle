import { t } from "../app/i18n";
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
  return resolveLocalizedText(schema?.title, language, canonical) ?? (Object.prototype.hasOwnProperty.call(NATIVE_LABEL, name) ? NATIVE_LABEL[name]!(language) : undefined) ?? fieldLabel(name);
}

/** The entry's own timestamps, which no JSON Schema titles, as a list or a View names them. */
const NATIVE_LABEL: Readonly<Record<string, (language: AdminLanguage) => string>> = {
  createdAt: (l) => t(l, "collection.table.created"), created_at: (l) => t(l, "collection.table.created"),
  updatedAt: (l) => t(l, "collection.table.updated"), updated_at: (l) => t(l, "collection.table.updated"),
};

/** Resolve optional localized schema help text. */
export function propertyDescription(
  schema: JsonSchema | undefined,
  language: AdminLanguage,
  canonical: string | null,
): string | undefined {
  return resolveLocalizedText(schema?.description, language, canonical) ?? undefined;
}
