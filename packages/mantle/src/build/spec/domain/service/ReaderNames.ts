/**
 * Schema reader names (ADR-0043 decision 2): `store.db.<name>` is the lower-camel projection of a Schema's declared
 * name. A name whose projection is not a usable property name (non-ASCII, empty, a leading digit) keeps its plan key
 * verbatim as the property (bracket access), so a currently valid app is never refused for its spelling. Only a true
 * collision or a reserved name is refused.
 */

/** Property names a reader may not take: they would shadow or confuse the `Object.prototype` surface and `await`. */
export const RESERVED_READER_NAMES: readonly string[] = [
  "constructor", "then", "__proto__", "prototype", "toString", "toLocaleString", "valueOf", "hasOwnProperty",
  "isPrototypeOf", "propertyIsEnumerable", "toJSON", "__defineGetter__", "__defineSetter__", "__lookupGetter__", "__lookupSetter__",
];

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * The lower-camel projection of the ASCII words of a name, or the lower-cased name itself (the plan key) when that is not a valid
 * identifier. A name with any non-ASCII character is never projected: dropping its non-ASCII parts would make two different names one.
 */
export function readerName(schemaName: string): string {
  if (/[^\x00-\x7f]/.test(schemaName)) return schemaName.toLowerCase();
  const parts = schemaName.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const projected = parts.length ? parts[0]![0]!.toLowerCase() + parts[0]!.slice(1) + parts.slice(1).map((p) => p[0]!.toUpperCase() + p.slice(1)).join("") : "";
  return IDENTIFIER.test(projected) ? projected : schemaName.toLowerCase();
}

/** Every reserved name and every name two Schemas share; each message names the Schemas involved. */
export function readerNameProblems(names: readonly string[]): { name: string; message: string }[] {
  const out: { name: string; message: string }[] = [];
  const first = new Map<string, string>();
  for (const name of names) {
    const reader = readerName(name);
    if (RESERVED_READER_NAMES.includes(reader)) {
      out.push({ name, message: `Schema '${name}' would be the reader '${reader}', a reserved property name. Rename the Schema.` });
      continue;
    }
    const other = first.get(reader);
    if (other === undefined) first.set(reader, name);
    // names that differ only by case are SCHEMA_NAME_CASE_COLLISION already: one problem, one diagnostic
    else if (other.toLowerCase() !== name.toLowerCase()) out.push({ name, message: `Schema '${name}' and Schema '${other}' both become the reader '${reader}' (store.db.${reader}). Rename one.` });
  }
  return out;
}
