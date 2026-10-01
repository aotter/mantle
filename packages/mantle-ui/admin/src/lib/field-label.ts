import { propertyLabel as schemaLabel } from "@aotter/mantle-ui";
import { t } from "../app/i18n";
import type { AdminLanguage } from "../app/preferences";
import type { JsonSchema } from "./types";

export { fieldLabel, propertyDescription } from "@aotter/mantle-ui";

/** A field's title, the entry's own timestamps in the console's language, else the name humanized. */
export function propertyLabel(
  name: string,
  schema: JsonSchema | undefined,
  language: AdminLanguage,
  canonical: string | null,
): string {
  if (!schema?.title && Object.prototype.hasOwnProperty.call(NATIVE_LABEL, name)) return NATIVE_LABEL[name]!(language);
  return schemaLabel(name, schema, language, canonical);
}

/** The entry's own timestamps, which no JSON Schema titles, as a list or a View names them. */
const NATIVE_LABEL: Readonly<Record<string, (language: AdminLanguage) => string>> = {
  createdAt: (l) => t(l, "collection.table.created"), created_at: (l) => t(l, "collection.table.created"),
  updatedAt: (l) => t(l, "collection.table.updated"), updated_at: (l) => t(l, "collection.table.updated"),
};
