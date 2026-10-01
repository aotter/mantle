import { fieldLabel } from "./field-label";
import { resolveLocalizedText } from "./localized-text";
import type { JsonSchema, LocalizedText } from "./types";

/** A property's string options: its `enum`, or a `oneOf` of string `const`s, each with its `title` (the server's `enumOptions`). */
export function enumOptions(schema: JsonSchema | undefined): { value: string; title?: LocalizedText }[] | undefined {
  if (schema?.enum?.length && schema.enum.every((v) => typeof v === "string")) return (schema.enum as string[]).map((value) => ({ value }));
  const branches = schema?.oneOf as JsonSchema[] | undefined;
  if (!branches?.length || !branches.every((b) => typeof b.const === "string")) return undefined;
  return branches.map((b) => ({ value: b.const as string, ...(b.title !== undefined ? { title: b.title } : {}) }));
}

/** How an option reads: its `title` in the language, else the value humanized. */
export function optionLabel(schema: JsonSchema | undefined, value: string, language: string, canonical?: string | null): string {
  const title = enumOptions(schema)?.find((o) => o.value === value)?.title;
  return resolveLocalizedText(title, language, canonical) ?? fieldLabel(value);
}
