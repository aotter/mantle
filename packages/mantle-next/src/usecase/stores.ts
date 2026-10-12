/**
 * One typed collection per Schema, over the generic `createStore`. Core's row rules (`rowPolicy`, `writePolicy`) are evaluated
 * here, at build time, ONCE for a placeholder scope and TTL into the shared `Rules`; a Schema adds only a `Fact` (scope, TTL,
 * publishing, its date-time and date columns). Generation is refused if a Schema's expanded rules differ from Core's own for it
 * (caller and trusted rows, insert fills, update sets and lock, delete lock).
 * Column names, value types, writable columns and `orderBy` are TypeScript types only: nothing at runtime knows them.
 */
import { NATIVE_NOT_NULL, notNullColumns, rowPolicy, writePolicy, type RuntimePlan } from "@aotter/mantle/spec";
import { nextMode } from "../domain/visibility.js";
import { declaredType, inputType, nativeType } from "../domain/columns.js";
import { expand, SCOPE, TTL, type Fact, type Rules } from "../kernel/store.js";

const q = JSON.stringify;
// Types the typed Store compares and writes as plain bind values. Fixed numerics are scaled integers on SQLite; geo is two columns.
const SCALAR = new Set(["text", "real", "float8", "integer", "int4", "int8", "bool", "timestamptz", "date"]);

/** Core's own rules for a Schema, in the shape of `Rules` without the id expression (a delete's lock is compared separately). */
const core = (s: Parameters<typeof rowPolicy>[0]) => {
  const update = writePolicy(s, "update", { lock: true });
  return { caller: rowPolicy(s, nextMode("caller")), trusted: rowPolicy(s, "trusted"), fills: writePolicy(s, "insert").fills, sets: update.sets, lock: update.lock! };
};
const probe = { scope: SCOPE, ttl: TTL, ttlSeconds: 0, publishing: true };

/** @internal */
export function emitStores(schemas: RuntimePlan["schemas"], isSqlite: boolean, newId: string, refuse: (path: string, message: string) => void): { tables: string; rules: string; facts: string } | undefined {
  const all = Object.values(schemas).sort((a, b) => a.name < b.name ? -1 : 1);
  if (!all.length) return undefined;
  const rules: Rules = { ...core(probe), newId };
  const tables: string[] = [], facts: string[] = [];
  for (const s of all) {
    const type = (column: string) => declaredType(s.fields, column) ?? (column === "version" ? "integer" : column === "published_at" ? "timestamptz" : "text");
    const declared = Object.keys(s.fields).filter(f => f !== s.scope && s.fields[f] !== "geo");
    const geo = Object.keys(s.fields).filter(f => s.fields[f] === "geo").flatMap(f => [`${f}_lat`, `${f}_lng`]); // `*` returns a geo field's two columns
    const names = [...["id", "version", "created_at", "updated_at", "author_id", ...(s.publishing ? ["status", "published_at"] : [])], ...declared];
    const required = new Set(s.schema.required ?? []), notNull = notNullColumns(s);
    const nonNull = (column: string) => NATIVE_NOT_NULL.has(column) || notNull.has(column);
    const ts = [...(s.publishing ? ["published_at"] : []), ...declared.filter(c => s.fields[c] === "timestamptz")], dates = declared.filter(c => s.fields[c] === "date");
    const fact: Fact = {
      ...(s.scope ? { s: s.scope } : {}), ...(s.ttl ? { ttl: [s.ttl, s.ttlSeconds ?? 0] as const } : {}), ...(s.publishing ? { pub: 1 as const } : {}),
      ...(ts.length ? { ts } : {}), ...(dates.length ? { d: dates } : {}),
    };
    // the shared rules, with this Schema's scope and TTL put in, are Core's rules for it: or the runtime would enforce something else
    const expected = q([core(s), writePolicy(s, "delete", { lock: true }).lock]), got = q([expand(rules, fact), rules.lock]);
    if (expected !== got) refuse(`schemas/${s.name}`, `Core's row rules for this Schema differ from the shared rules (${expected} vs ${got}); the generic Store cannot serve it.`);
    // ORDER BY is allowed where the caller's scoped read can walk an index (its first column, or the one after the scope column) and the column is NOT NULL.
    const indexed = new Set([...(s.publishing ? [[...(s.scope ? [s.scope] : []), "published_at", "id"]] : []), ...(s.indexes ?? []), ...(s.unique ?? [])].map(i => i[0] === s.scope ? i[1] : i[0]).filter((c): c is string => !!c));
    const key = (c: string) => /^[A-Za-z_]\w*$/.test(c) ? c : q(c);
    const of = (columns: string[], value: (c: string) => string) => `{ ${columns.map(c => `${key(c)}: ${value(c)};`).join(" ")} }`;
    const union = (columns: string[]) => columns.map(c => q(c)).join(" | ") || "never";
    const scalar = (c: string) => SCALAR.has(type(c));
    const writable = declared.filter(c => scalar(c) || type(c) === "json");
    const input = (c: string) => `${inputType(type(c))}${nonNull(c) ? "" : " | null"}`;
    tables.push(`${key(s.name)}: { row: ${of([...names, ...geo], c => c === "id" ? "string" : nativeType(geo.includes(c) ? "real" : type(c), isSqlite, nonNull(c)))}; fields: ${of(names.filter(scalar), c => inputType(type(c)))}; set: ${of(writable, input)}; required: ${union(s.publishing ? [] : writable.filter(c => required.has(s.names?.[c] ?? c)))}; order: ${union(["id", ...names.filter(c => c !== "id" && scalar(c) && indexed.has(c) && (nonNull(c) || s.publishing && c === "published_at"))])} }`);
    facts.push(`${q(s.name)}: ${q(fact)}`);
  }
  return { tables: `{ ${tables.join("; ")} }`, rules: q(rules), facts: `{ ${facts.join(", ")} }` };
}
