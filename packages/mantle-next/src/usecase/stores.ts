/**
 * One typed collection per Schema, over the generic `createStore`. Core's row rules (`rowPolicy`, `writePolicy`) are evaluated
 * here, at build time, ONCE for a placeholder scope and TTL into the shared `Rules`; a Schema adds only a `Fact` (scope, TTL,
 * publishing, its date-time and date columns). Generation is refused if a Schema's expanded rules differ from Core's own for it
 * (caller and trusted rows, insert fills, update sets and lock, delete lock).
 * Column names, value types, writable columns and `orderBy` are TypeScript types only: nothing at runtime knows them.
 */
import { rowPolicy, writePolicy, type RuntimePlan } from "@aotter/mantle/spec";
import { declaredType, inputType, nativeType } from "../domain/columns.js";
import { expand, SCOPE, TTL, type Fact, type Rules } from "../kernel/store.js";

const q = JSON.stringify;
type Schema = RuntimePlan["schemas"][string];
// Types the typed Store compares and writes as plain bind values. Fixed numerics are scaled integers on SQLite; geo is two columns.
const SCALAR = new Set(["text", "real", "float8", "integer", "int4", "int8", "bool", "timestamptz", "date"]);
const SYSTEM_NOT_NULL = new Set(["id", "version", "created_at", "updated_at", "status"]);

/** Core's own rules for a Schema, in the shape of `Rules` without the id expression (a delete's lock is compared separately). */
const core = (s: Parameters<typeof rowPolicy>[0]) => {
  const update = writePolicy(s, "update", { lock: true });
  return { caller: rowPolicy(s, "caller"), trusted: rowPolicy(s, "trusted"), fills: writePolicy(s, "insert").fills, sets: update.sets, lock: update.lock! };
};
const probe = { scope: SCOPE, ttl: TTL, ttlSeconds: 0 };

/** @internal */
export function emitStores(schemas: RuntimePlan["schemas"], isSqlite: boolean, newId: string, refuse: (path: string, message: string) => void): { tables: string; rules: string; facts: string } | undefined {
  const all = Object.values(schemas).sort((a, b) => a.name < b.name ? -1 : 1);
  if (!all.length) return undefined;
  const rules: Rules = { ...core(probe), newId };
  const tables: string[] = [], facts: string[] = [];
  for (const s of all) {
    const type = (column: string) => declaredType(s.fields, column) ?? (column === "version" ? "integer" : "text");
    const declared = Object.keys(s.fields).filter(f => f !== s.scope && s.fields[f] !== "geo");
    const names = [...["id", "version", "created_at", "updated_at", "author_id", ...(s.publishing ? ["status"] : [])], ...declared];
    const required = new Set(s.schema.required ?? []);
    const nonNull = (column: string) => {
      if (SYSTEM_NOT_NULL.has(column)) return true;
      const authored = s.names?.[column] ?? column, p = s.schema.properties?.[authored];
      return required.has(authored) && !!p && p.nullable !== true && !(Array.isArray(p.type) && p.type.includes("null"));
    };
    const fact: Fact = {
      ...(s.scope ? { s: s.scope } : {}), ...(s.ttl ? { ttl: [s.ttl, s.ttlSeconds ?? 0] as const } : {}), ...(s.publishing ? { pub: 1 as const } : {}),
      ...(declared.some(c => s.fields[c] === "timestamptz") ? { ts: declared.filter(c => s.fields[c] === "timestamptz") } : {}),
      ...(declared.some(c => s.fields[c] === "date") ? { d: declared.filter(c => s.fields[c] === "date") } : {}),
    };
    // the shared rules, with this Schema's scope and TTL put in, are Core's rules for it: or the runtime would enforce something else
    const expected = q([core(s), writePolicy(s, "delete", { lock: true }).lock]), got = q([expand(rules, fact), rules.lock]);
    if (expected !== got) refuse(`schemas/${s.name}`, `Core's row rules for this Schema differ from the shared rules (${expected} vs ${got}); the generic Store cannot serve it.`);
    // ORDER BY is allowed where the caller's scoped read can walk an index (its first column, or the one after the scope column) and the column is NOT NULL.
    const indexed = new Set([...(s.indexes ?? []), ...(s.unique ?? [])].map(i => i[0] === s.scope ? i[1] : i[0]).filter((c): c is string => !!c));
    const of = (columns: string[], value: (c: string) => string, optional = (_: string) => false) => `{ ${columns.map(c => `readonly ${q(c)}${optional(c) ? "?" : ""}: ${value(c)};`).join(" ")} }`;
    const scalar = (c: string) => SCALAR.has(type(c));
    const writable = s.publishing ? [] : declared.filter(c => scalar(c) || type(c) === "json");
    const input = (c: string) => `${inputType(type(c))}${nonNull(c) ? "" : " | null"}`;
    tables.push(`${q(s.name)}: { row: ${of(names, c => c === "id" ? "string" : `${nativeType(type(c), isSqlite)} | null`)}; fields: ${of(names.filter(scalar), c => inputType(type(c)))}; set: ${of(writable, input)}; insert: ${of(writable, input, c => !required.has(s.names?.[c] ?? c))}; order: ${["id", ...names.filter(c => c !== "id" && scalar(c) && indexed.has(c) && nonNull(c))].map(c => q(c)).join(" | ")} }`);
    facts.push(`${q(s.name)}: ${q(fact)}`);
  }
  return { tables: `{ ${tables.join("; ")} }`, rules: q(rules), facts: `{ ${facts.join(", ")} }` };
}
