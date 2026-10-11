/** Canonical lowered programs become ordinary target-specific TypeScript, never a runtime plan. */
import { parseNumeric, type JsonSchema, type LoweredStatement } from "@aotter/mantle/spec";
import type { GenerateDiagnostic, GenerateInput, GenerateResult, Target } from "../domain/model.js";
import { nativeType, outputType } from "../domain/columns.js";
import { recipesOf } from "../domain/recipes.js";
import { emitStores } from "./stores.js";

const q = JSON.stringify;
const sqlite = (target: Target) => target === "bun-sqlite" || target === "cloudflare-d1";
const typeOf = (s: JsonSchema | undefined): string => {
  if (!s) return "unknown";
  if (s.nullable === true) return `${typeOf({ ...s, nullable: false })} | null`;
  if (s.enum) return s.enum.map(v => q(v)).join(" | ") || "never";
  if (s.const !== undefined) return q(s.const);
  if (Array.isArray(s.type)) return s.type.map(type => typeOf({ ...s, type })).join(" | ") || "never";
  switch (s.type) {
    case "string": return "string";
    case "integer": case "number": return "number";
    case "boolean": return "boolean";
    case "null": return "null";
    case "array": return `ReadonlyArray<${Array.isArray(s.items) ? "unknown" : typeOf(s.items)}>`;
    case "object": return `{ ${Object.entries(s.properties ?? {}).map(([key, child]) => `readonly ${q(key)}${s.required?.includes(key) ? "" : "?"}: ${typeOf(child)};`).join(" ")} ${s.additionalProperties !== false ? "readonly [key: string]: unknown;" : ""} }`;
    default: return "unknown";
  }
};
// Stable, injective build-only export names; stale entry files cannot bind a new ordinal.
const exportName = (kind: string, name: string) => kind + "_" + Array.from(name, c => c.codePointAt(0)!.toString(16)).join("_");

export function generate({ target, plan, lowered, viewKeys, stores = [] }: GenerateInput): GenerateResult {
  const diagnostics: GenerateDiagnostic[] = [];
  const refuse = (path: string, message: string) => { diagnostics.push({ code: "GENERATE_UNSUPPORTED", path, message }); };
  const isSqlite = sqlite(target);
  const expected = isSqlite ? "@aotter/mantle/d1" : "@aotter/mantle/postgres";
  if (lowered.dialect.name !== expected || plan.dialect.name !== expected) refuse("target", `Target '${target}' needs canonical '${expected}' compilation and lowering.`);
  for (const name of Object.keys(plan.triggers)) refuse(`triggers/${name}`, "Native Trigger dispatch is not implemented; generation cannot omit it.");
  const driver = target === "bun-sqlite" ? "bun-sqlite" : target === "cloudflare-d1" ? "d1" : "bun-sql";
  const used = new Set<string>();
  const auth = (requires: typeof plan.views[string]["requires"], path: string): string[] => {
    if (requires?.guard) refuse(path, "Procedure guards require a generated native dispatch implementation.");
    return (requires?.auth?.all ?? []).map((p, index) => {
      used.add("ContractError");
      const condition = typeof p === "string" ? 'caller.kind === "user"' : "ctx.auth.scope" in p ? `caller.kind === "user" && caller.scopes.includes(${q(p["ctx.auth.scope"])})` : `caller.kind === "user" && ${q(p["ctx.staff"])}.includes(caller.role ?? "")`;
      return `  let allowed${index}: boolean = ${condition};\n  if (!allowed${index}) throw new ContractError(caller.kind === "user" ? "AUTH_DENIED" : "UNAUTHENTICATED", "Authorization predicate not satisfied.", ${q(`${path}/requires/auth/all/${index}`)});`;
    });
  };
  const queryInputType = (schema: JsonSchema | undefined, statements: readonly LoweredStatement[]) => {
    if (!schema?.properties) return typeOf(schema);
    const binds = statements.flatMap(s => s.binds).filter(b => b.k === "input");
    const properties = Object.entries(schema.properties).map(([name, field]) => {
      const bind = binds.find(b => b.k === "input" && name.toLowerCase() === String(b.name).toLowerCase());
      if (!bind || bind.k !== "input") return `readonly ${q(name)}${schema.required?.includes(name) ? "" : "?"}: ${typeOf(field)};`;
      const type = String(bind.type);
      const driverType = type === "json" ? "string" : type === "date" ? "string" : type === "timestamptz" ? "string | Date" : isSqlite
        ? type === "bool" || parseNumeric(type) ? "number" : typeOf(field)
        : parseNumeric(type) ? "number | string" : typeOf(field);
      const nullable = field.nullable === true || Array.isArray(field.type) && field.type.includes("null") || !schema.required?.includes(name);
      // D1 cannot bind undefined. Bound fields are explicit, null represents absence.
      return `readonly ${q(name)}: ${driverType}${nullable ? " | null" : ""};`;
    });
    return `{ ${properties.join(" ")} ${schema.additionalProperties !== false ? "readonly [key:string]: unknown;" : ""} }`;
  };
  const inputFields = (schema: JsonSchema | undefined, path: string) => {
    const fields = Object.keys(schema?.properties ?? {});
    if (new Set(fields.map(field => field.toLowerCase())).size !== fields.length) refuse(path, "Input properties must have unique case-insensitive names.");
    return fields;
  };
  // JSON input is driver-ready text. Declaring its parameter as text makes every driver send it verbatim: Bun.SQL would
  // otherwise JSON-encode a string bound to a jsonb parameter a second time.
  const sqlOf = (s: LoweredStatement, path: string): string => {
    if (isSqlite) return s.sql;
    let sql = s.sql;
    for (const [i, b] of s.binds.entries()) {
      if (b.k !== "input" || String(b.type) !== "json") continue;
      const param = `$${i + 1}`, cast = `CAST(${param} AS jsonb)`;
      if (sql.split(cast).join("").match(new RegExp(`\\$${i + 1}(?!\\d)`))) refuse(path, `JSON input ${param} must appear only as ${cast}.`);
      sql = sql.replaceAll(cast, `CAST(CAST(${param} AS text) AS jsonb)`);
    }
    return sql;
  };
  /** A statement as a constant: its text and how to bind it. */
  const step = (s: LoweredStatement, path: string, fields: readonly string[], row = false) => `{ sql: ${q(sqlOf(s, path))}, binds: ${q(recipesOf(s, fields, message => refuse(path, message)))}${row ? ", row: true" : ""} }`;
  const declarations: string[] = [], views: string[] = [], procedures: string[] = [];
  const entries: Record<string, string> = {};
  // Entries import then export: Bun 1.3 drops a bare `export { x as default } from` binding under "sideEffects": false.
  for (const [index, [name, view]] of Object.entries(plan.views).sort().entries()) {
    const path = `views/${name}`, fn = `view${index}`;
    const modes = lowered.views[name];
    const mode = view.surface === "public" ? "public" : "caller";
    const c = modes?.[mode], trusted = modes?.trusted;
    if (!c || (mode === "caller" && !trusted)) { refuse(path, "Every reachable visibility mode must have canonical lowered SQL."); continue; }
    const keys = Object.hasOwn(viewKeys, name) ? viewKeys[name] : undefined;
    if (!keys || new Set(keys).size !== keys.length) { refuse(path, "Dynamic or repeated View outputs need an explicit generated row contract."); continue; }
    const output: string[] = [];
    for (const key of keys) {
      const type = outputType(plan, name, key);
      if (type === "geo") refuse(path, "Native geo projection is not implemented.");
      // Declared timestamps and dates arrive formatted by the SQL itself (domain/wireScalars).
      output.push(`readonly ${q(key)}: ${nativeType(type, isSqlite)} | null;`);
    }
    const fieldNames = inputFields(view.input, path + "/input");
    used.add("read");
    declarations.push(`export type View${index}Input = ${queryInputType(view.input ?? { type: "object", additionalProperties: false }, [c, ...(trusted ? [trusted] : [])])};`, `export type View${index}Row = { ${output.join(" ")} };`,
      `const ${fn}Caller = ${step(c, path, fieldNames)} as const;`, ...(mode === "caller" ? [`const ${fn}Trusted = ${step(trusted!, path, fieldNames)} as const;`] : []),
      `async function ${fn}(db: Database, caller: Caller, raw: View${index}Input): Promise<View${index}Row[]> {`, ...auth(view.requires, path),
      ...(mode === "caller" ? [`  const m = caller.kind === "system" ? ${fn}Trusted : ${fn}Caller;`, "  return await read(db, m.sql, binds(D, m.binds, caller, raw)) as View" + index + "Row[];"] : [`  return await read(db, ${fn}Caller.sql, binds(D, ${fn}Caller.binds, caller, raw)) as View${index}Row[];`]), "}");
    views.push(`[${q(name)}]: ${fn}`);
    declarations.push(`export { ${fn} as ${exportName("view", name)} };`);
    entries[`views/${encodeURIComponent(name)}.ts`] = `import { ${exportName("view", name)} as operation } from "../generated.js";\nexport default operation;\nexport type { View${index}Input as Input, View${index}Row as Row } from "../generated.js";\n`;
  }
  for (const [index, [name, procedure]] of Object.entries(plan.procedures).sort().entries()) {
    const path = `procedures/${name}`, fn = `procedure${index}`;
    if (!("sql" in procedure.handler)) { refuse(path, "Ref handlers require an explicit generated application implementation."); continue; }
    const modes = lowered.procedures[name];
    if (!modes?.caller || !modes.trusted) { refuse(path, "Both caller and trusted SQL must be lowered."); continue; }
    if (modes.caller.some(s => s.hooked || s.publish || s.schema && plan.schemas[s.schema]?.publishing)) refuse(path, "Publishing and lifecycle hooks require explicit native execution.");
    const fieldNames = inputFields(procedure.input, path + "/input");
    const steps = (statements: readonly LoweredStatement[]) => `[${statements.map(s => step(s, path, fieldNames, s.kind === "row")).join(", ")}] as const`;
    const same = steps(modes.caller) === steps(modes.trusted);
    used.add("procedure"); used.add("bound");
    declarations.push(`export type Procedure${index}Input = ${queryInputType(procedure.input, [...modes.caller, ...modes.trusted])};`, `export type Procedure${index}Output = { readonly results: ReadonlyArray<ReadonlyArray<Record<string, unknown>>> };`,
      `const ${fn}Caller = ${steps(modes.caller)};`, ...(same ? [] : [`const ${fn}Trusted = ${steps(modes.trusted)};`]),
      `async function ${fn}(db: Database, caller: Caller, raw: Procedure${index}Input): Promise<Procedure${index}Output> {`, ...auth(procedure.requires, path),
      `  const results = await procedure(db, bound(D, ${same ? `${fn}Caller` : `caller.kind === "system" ? ${fn}Trusted : ${fn}Caller`}, caller, raw), ${q(path)});`,
      `  return { results } as Procedure${index}Output;`, "}");
    procedures.push(`[${q(name)}]: ${fn}`);
    declarations.push(`export { ${fn} as ${exportName("procedure", name)} };`);
    entries[`procedures/${encodeURIComponent(name)}.ts`] = `import { ${exportName("procedure", name)} as operation } from "../generated.js";\nexport default operation;\nexport type { Procedure${index}Input as Input, Procedure${index}Output as Output } from "../generated.js";\n`;
  }
  const emitted = emitStores(stores, { isSqlite, step, refuse, entries });
  if (emitted.names.length) used.add("createStore");
  if (diagnostics.length) return { ok: false, diagnostics };
  const base = "@aotter/mantle-next/";
  const dbType = target === "bun-sqlite" ? `import type { Handle as Database } from "${base}driver/bun-sqlite";` : target === "cloudflare-d1" ? `import type { Handle as Database } from "${base}driver/d1";` : `import type { Postgres as Database } from "${base}contracts";`;
  const driverImports = [...["read", "procedure"].filter(n => used.has(n))];
  return { ok: true, files: { ...entries, "generated.ts": ["// Generated native application SQL. No runtime plan or interpreter.", dbType, `import type { Caller } from "${base}contracts";`,
    ...(used.has("ContractError") ? [`import { ContractError } from "${base}contracts";`] : []),
    `import * as D from "${base}dialect/${isSqlite ? "sqlite" : "postgres"}";`,
    ...(driverImports.length ? [`import { ${driverImports.join(", ")} } from "${base}driver/${driver}";`] : []),
    ...(emitted.names.length ? [`import * as DRIVER from "${base}driver/${driver}";`, `import { createStore } from "${base}store";`] : []),
    `import { ${["binds", ...(used.has("bound") ? ["bound"] : [])].join(", ")} } from "${base}binds";`,
    ...declarations, ...emitted.declarations, `export const views = { ${views.join(", ")} };`, `export const procedures = { ${procedures.join(", ")} };`, `export const stores = { ${emitted.names.join(", ")} };`, ""].join("\n") } };
}
