/** Locale-map labels as an external client reads them: one string in the server locale. */
type LocalizedText = string | Readonly<Record<string, string>>;
/** A label in `locale`: that locale's text, else `en`, else the first one given. */
export function localizedText(value: LocalizedText | undefined, locale: string): string | undefined {
  if (typeof value === "string" || !value) return value;
  return Object.hasOwn(value, locale) ? value[locale] : Object.hasOwn(value, "en") ? value.en : Object.values(value)[0];
}
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
/** Keywords whose value names subschemas, and keywords whose value is one subschema or a list of them. */
const SCHEMA_MAPS = ["properties", "patternProperties", "dependentSchemas", "$defs", "definitions"];
const SUBSCHEMAS = [
  ...["items", "prefixItems", "additionalProperties", "unevaluatedProperties", "unevaluatedItems", "propertyNames"],
  ...["contains", "allOf", "anyOf", "oneOf", "not", "if", "then", "else", "contentSchema"],
];
/**
 * A JSON Schema as an external client reads it: every localized `title` and `description` keyword, at any depth, is
 * the string `localizedText` picks, so the schema stays valid JSON Schema. Only schema keywords are rewritten: a
 * property named `title`, and `enum`, `const`, `default` or `examples` values, are left as they are. Returns a copy.
 */
export function localizedSchema(schema: unknown, locale: string): unknown {
  if (!isRecord(schema)) return schema;
  const out = { ...schema };
  for (const key of ["title", "description"]) {
    if (!isRecord(schema[key])) continue;
    const text = localizedText(schema[key] as LocalizedText, locale);
    if (text === undefined) delete out[key];
    else out[key] = text;
  }
  for (const key of SCHEMA_MAPS) {
    const children = schema[key];
    if (isRecord(children))
      out[key] = Object.fromEntries(
        Object.entries(children).map(([name, child]) => [name, localizedSchema(child, locale)]),
      );
  }
  for (const key of SUBSCHEMAS) {
    const child = schema[key];
    if (child !== undefined)
      out[key] = Array.isArray(child)
        ? child.map(item => localizedSchema(item, locale))
        : localizedSchema(child, locale);
  }
  return out;
}
