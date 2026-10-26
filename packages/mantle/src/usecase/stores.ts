/**
 * One typed collection per Schema, over the generic `createStore`. Core's row rules (`rowPolicy`, `writePolicy`) are evaluated
 * here, at build time, ONCE for a placeholder scope and TTL into the shared `Rules`; a Schema adds only a `Fact` (scope, TTL,
 * publishing, its date-time and date columns). Generation is refused if a Schema's expanded rules differ from Core's own for it
 * (caller and trusted rows, insert fills, update sets and lock, delete lock).
 * Column names, value types, writable columns and `orderBy` are TypeScript types only: nothing at runtime knows them.
 */
import { NATIVE_NOT_NULL, notNullColumns, rowPolicy, writePolicy, type RuntimePlan } from "../build/compiler.js";
import { declaredType, inputType, nativeType } from "../domain/columns.js";
import { q } from "../domain/entry.js";
import { expand, SCOPE, TTL, type Fact, type Lock, type Rules } from "../kernel/store.js";
import { refChecks, userScopeTerm } from '../build/compiler.js';
import { publishRequired } from "./publishing.js";

// Types the typed Store compares and writes as plain bind values. Fixed numerics are scaled integers on SQLite; geo is two columns.
const SCALAR = new Set(["text", "real", "float8", "integer", "int4", "int8", "bool", "timestamptz", "date"]);

/** Core's own rules for a Schema, in the shape of `Rules` without the id expression (a delete's lock is compared separately). */
const core = (s: Parameters<typeof rowPolicy>[0], schemas?: RuntimePlan["schemas"]) => {
  const update = writePolicy(s, "update", { lock: true });
  return { caller: rowPolicy(s, "caller", schemas), trusted: rowPolicy(s, "trusted", schemas), fills: writePolicy(s, "insert").fills, sets: update.sets, lock: update.lock! };

};
const probe = { scope: SCOPE, ttl: TTL, ttlSeconds: 0, publishing: true };

/** @internal */
export function emitStores(schemas: RuntimePlan["schemas"], isSqlite: boolean, newId: string, refuse: (path: string, message: string) => void, required = false, locks: Readonly<Record<string, readonly Lock[]>> = {}): { tables: string; rules: string; facts: string } | undefined {
  const all = Object.values(schemas).sort((a, b) => a.name < b.name ? -1 : 1);
  if (!all.length && !required) return undefined;
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
    const parent = s.translates && schemas[s.translates.parent.toLowerCase()];
    const inherited = parent ? Object.keys(parent.fields).filter(c => c !== parent.scope && !Object.hasOwn(s.fields,c)).flatMap(c => parent.fields[c] === "geo" ? [`${c}_lat`, `${c}_lng`] : [c]) : [];
    const inheritedType = (c:string) => parent?.fields[c] ?? "real";
    const ref = refChecks(s, schemas);
    const fact: Fact = {
      ...(s.userScopes?.length ? { u: s.userScopes.map(u => userScopeTerm(u, true)) } : {}),
      ...(s.scope ? { s: s.scope } : {}), ...(s.ttl ? { ttl: [s.ttl, s.ttlSeconds ?? 0] as const } : {}), ...(s.publishing ? { pub: 1 as const, ...(publishRequired(s).length ? { req: publishRequired(s) } : {}) } : {}),
      ...(ts.length ? { ts } : {}), ...(dates.length ? { d: dates } : {}),
      ...(s.search?.length ? { search: s.search } : {}),
      ...(ref.length ? { ref } : {}),
      ...(locks[s.name.toLowerCase()]?.length ? { lock: locks[s.name.toLowerCase()] } : {}),
      ...(parent ? { parent: { on: s.translates!.on.toLowerCase(), ...(parent.scope ? {scope:[parent.scope,s.scope!] as const} : {}), table: s.translates!.parent.toLowerCase(), visible: rowPolicy(s,"caller",schemas).find(t=>t[1]==="parent")!, caller: rowPolicy(parent,"caller",schemas), trusted: rowPolicy(parent,"trusted",schemas), fields: inherited, ts: inherited.filter(c=>parent.fields[c]==="timestamptz"), d: inherited.filter(c=>parent.fields[c]==="date") } } : {}),
    };
    // the shared rules, with this Schema's scope and TTL put in, are Core's rules for it: or the runtime would enforce something else
    const expected = q([core(s, schemas), writePolicy(s, "delete", { lock: true }).lock]), got = q([expand(rules, fact), rules.lock]);
    for (const verb of ["update", "delete"] as const) if (q(writePolicy(s, verb).locks.map(l => l[0])) !== q((fact.lock ?? []).filter(l => l.on.includes(verb)).map(l => l.name))) refuse(`schemas/${s.name}`, `Core's ${verb} locks for this Schema differ from the Store's.`);
    if (expected !== got) refuse(`schemas/${s.name}`, `Core's row rules for this Schema differ from the shared rules (${expected} vs ${got}); the generic Store cannot serve it.`);
    // ORDER BY is allowed where the caller's scoped read can walk an index (its first column, or the one after the scope column) and the column is NOT NULL.
    const indexed = new Set([...(s.publishing ? [[...(s.scope ? [s.scope] : []), "published_at", "id"]] : []), ...(s.indexes ?? []), ...(s.unique ?? [])].map(i => i[0] === s.scope ? i[1] : i[0]).filter((c): c is string => !!c));
    const key = (c: string) => /^[A-Za-z_]\w*$/.test(c) ? c : q(c);
    const of = (columns: string[], value: (c: string) => string) => `{ ${columns.map(c => `${key(c)}: ${value(c)};`).join(" ")} }`;
    const union = (columns: string[]) => columns.map(c => q(c)).join(" | ") || "never";
    const scalar = (c: string) => SCALAR.has(type(c));
    const writable = declared.filter(c => !(s.userScopes ?? []).some(u => u.column === c) && (scalar(c) || type(c) === "json"));
    const input = (c: string) => `${inputType(type(c))}${nonNull(c) ? "" : " | null"}`;
    tables.push(`${key(s.name)}: { row: ${of([...names, ...geo], c => c === "id" ? "string" : c === "version" ? "number" : nativeType(geo.includes(c) ? "real" : type(c), isSqlite, nonNull(c)))}${inherited.length ? ` & { ${inherited.map(c=>`${key(c)}?: ${nativeType(inheritedType(c),isSqlite)};`).join(" ")} }` : ""}; fields: ${of(names.filter(scalar), c => inputType(type(c)))}; set: ${of(writable, input)}${s.userScopes?.length ? `; insert: ${of([...writable, ...s.userScopes.map(u => u.column)], input)}` : ""}; required: ${union(s.publishing ? [] : writable.filter(c => required.has(s.names?.[c] ?? c)))}; order: ${union(["id", ...names.filter(c => c !== "id" && scalar(c) && indexed.has(c) && (nonNull(c) || s.publishing && c === "published_at"))])} }`);
    facts.push(`${q(s.name)}: ${q(fact)}`);
  }
  return { tables: `{ ${tables.join("; ")} }`, rules: q(rules), facts: `{ ${facts.join(", ")} }` };
}
