/**
 * One typed collection per Schema. Core's row rules (`rowPolicy`, `writePolicy`) are evaluated here, at build time, into a small
 * fact record passed to the shared `createStore`; no SQL is printed and the runtime knows no Schema. Types are compile-time only.
 */
import { rowPolicy, writePolicy, type RuntimePlan } from "@aotter/mantle/spec";
import { declaredType, inputType, nativeType } from "../domain/columns.js";
import { FILTER, WRITE, type Col } from "../kernel/store.js";

const q = JSON.stringify;
type Schema = RuntimePlan["schemas"][string];
// Types the typed Store compares and writes as plain bind values. Fixed numerics are scaled integers on SQLite; geo is two columns.
const SCALAR = new Set(["text", "real", "float8", "integer", "int4", "int8", "bool", "timestamptz", "date"]);

/** The columns Core's wrapper exposes, in output order: the scope column is never among them. */
function columns(s: Schema): Col[] {
  const system: [string, string][] = [["id", "id"], ["version", "version"], ["created_at", "createdAt"], ["updated_at", "updatedAt"], ["author_id", "authorId"], ...(s.publishing ? [["status", "status"] as [string, string]] : [])];
  const declared = Object.keys(s.fields).filter(f => f !== s.scope && s.fields[f] !== "geo").map((f): [string, string] => [f, s.names?.[f] ?? f]);
  return [...system, ...declared].map(([column, name]): Col => {
    const type = declaredType(s.fields, column) ?? (column === "version" ? "integer" : "text");
    const scalar = SCALAR.has(type);
    return [name, column, type, (scalar ? FILTER : 0) | (column in s.fields && !s.publishing && (scalar || type === "json") ? WRITE : 0)];
  });
}

/** @internal */
export function emitStores(schemas: RuntimePlan["schemas"], isSqlite: boolean): { tables: string; descriptors: string } | undefined {
  const all = Object.values(schemas).sort((a, b) => a.name < b.name ? -1 : 1);
  if (!all.length) return undefined;
  const tables: string[] = [], descriptors: string[] = [];
  for (const s of all) {
    const cols = columns(s);
    // ORDER BY is allowed where the caller's scoped read can walk an index: its first column, or the one after the scope column.
    const ordered = new Set(["id", ...[...(s.indexes ?? []), ...(s.unique ?? [])].map(i => i[0] === s.scope ? i[1] : i[0]).filter((c): c is string => !!c)]);
    const type = (c: Col) => c[0] === "id" ? "string" : `${nativeType(c[2], isSqlite)} | null`;
    const required = new Set(s.schema.required ?? []);
    const of = (keep: (c: Col) => boolean, value: (c: Col) => string, optional = (_: Col) => false) => `{ ${cols.filter(keep).map(c => `readonly ${q(c[0])}${optional(c) ? "?" : ""}: ${value(c)};`).join(" ")} }`;
    tables.push(`${q(s.name)}: { row: ${of(() => true, type)}; fields: ${of(c => !!(c[3] & FILTER), c => inputType(c[2]))}; set: ${of(c => !!(c[3] & WRITE), c => `${inputType(c[2])} | null`)}; insert: ${of(c => !!(c[3] & WRITE), c => `${inputType(c[2])} | null`, c => !required.has(c[0]))}; order: ${cols.filter(c => c[3] & FILTER && ordered.has(c[1])).map(c => q(c[0])).join(" | ") || "never"} }`);
    const update = writePolicy(s, "update", { lock: true });
    descriptors.push(`${q(s.name)}: { table: ${q(s.name)}, cols: ${q(cols)}, caller: ${q(rowPolicy(s, "caller"))}, trusted: ${q(rowPolicy(s, "trusted"))}${cols.some(c => c[3] & WRITE) ? `, write: ${q({ fills: writePolicy(s, "insert").fills, sets: update.sets, lock: update.lock })}` : ""} }`);
  }
  return { tables: `{ ${tables.join("; ")} }`, descriptors: `{ ${descriptors.join(", ")} }` };
}
