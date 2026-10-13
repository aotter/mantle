import type { Collection } from "./types";
import { t } from "../app/i18n";
import type { AdminLanguage } from "../app/preferences";

export function renderTitleText(title: unknown, language: AdminLanguage): string {
  if (typeof title === "string" && title) return title;
  if (title == null || title === "") return t(language, "collection.untitled");
  return JSON.stringify(title);
}

export function entryTitle(
  data: Record<string, unknown>,
  fallback: string,
  collection?: Pick<Collection, "lifecycle" | "list" | "schema">,
  entryId?: string,
): string {
  if (collection && collection.lifecycle !== "publishing") {
    const primaryField = collection.list?.primaryField;
    const value = primaryField ? data[primaryField] : undefined;
    if (typeof value === "string" && value.trim()) return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    return entryId || fallback;
  }
  for (const key of ["title", "name", "slug", "id"]) {
    const value = data[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  // Manifest-driven fallback: walk the schema's required properties in
  // declaration order and use the first string-typed one with a
  // non-empty value — this is how a collection with no `title`/`name`/
  // `slug` (e.g. one keyed by a domain-specific field) still gets a
  // readable label.
  if (collection?.schema) {
    const properties = collection.schema.properties ?? {};
    for (const key of collection.schema.required ?? []) {
      const fieldSchema = properties[key];
      if (!fieldSchema || ([fieldSchema.type].flat().find(type => type !== "null") ?? (fieldSchema.properties ? "object" : fieldSchema.items ? "array" : "string")) !== "string") continue;
      const value = data[key];
      if (typeof value === "string" && value.trim()) return value;
    }
  }
  return fallback;
}
