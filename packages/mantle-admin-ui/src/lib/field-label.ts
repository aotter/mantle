import { resolveLocalizedText } from "./localized-text";
import type { AdminLanguage } from "../app/preferences";
import type { JsonSchema } from "./types";

/** Kebab/snake/camelCase identifier → "Title Case" label. Shared copy
 *  used for Schema property names, Procedure names, and View names
 *  across `authenticated-layout.tsx`, `collection-view.tsx`,
 *  `entry-edit-view.tsx`, `view-page.tsx`, and `operations-view.tsx` —
 *  extracted (#430) once a 4th/5th call site needed the identical
 *  regex pair. */
export function fieldLabel(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

/**
 * Label for a JSON Schema property (#443): the standard `title`
 * keyword when present — either a plain string or the same
 * `LocalizedText` locale-map shape used by `Schema.spec.title` —
 * resolved via `resolveLocalizedText`, else `fieldLabel(name)` (the
 * pre-#443 humanized-name behavior, unchanged when `title` is absent).
 * Shared by SchemaFields form labels (`entry-edit-view.tsx`), list
 * column headers (`collection-view.tsx`), and operation form labels
 * (`row-operations.tsx`) so all three read a manifest-declared label
 * the same way.
 */
export function propertyLabel(
  name: string,
  schema: JsonSchema | undefined,
  language: AdminLanguage,
  canonical: string | null,
): string {
  return resolveLocalizedText(schema?.title, language, canonical) ?? fieldLabel(name);
}
