/** Canonical lowered programs become ordinary target-specific TypeScript, never a runtime plan. */
import { parseNumeric, type JsonSchema, type LoweredStatement } from "@aotter/mantle/spec";
import type { GenerateDiagnostic, GenerateInput, GenerateResult, Target } from "../domain/model.js";
import { nativeType, outputType } from "../domain/columns.js";
import { exportName } from "../domain/entry.js";
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
export function generate({ target, plan, lowered, viewKeys, newId }: GenerateInput): GenerateResult {
  const diagnostics: GenerateDiagnostic[] = [];
  const refuse = (path: string, message: string) => { diagnostics.push({ code: "GENERATE_UNSUPPORTED", path, message }); };
  const isSqlite = sqlite(target);
  const expected = isSqlite ? "@aotter/mantle/d1" : "@aotter/mantle/postgres";
  if (lowered.dialect.name !== expected || plan.dialect.name !== expected) refuse("target", `Target '${target}' needs canonical '${expected}' compilation and lowering.`);
  for (const name of Object.keys(plan.triggers)) refuse(`triggers/${name}`, "Native Trigger dispatch is not implemented; generation cannot omit it.");
  const driver = target === "bun-sqlite" ? "bun-sqlite" : target === "cloudflare-d1" ? "d1" : "postgres";
  const auth = (requires: typeof plan.views[string]["requires"], path: string, location = q(path)): string[] => {
    if (requires?.guard) refuse(path, "Procedure guards require a generated native dispatch implementation.");
    return (requires?.auth?.all ?? []).map((p, index) => {
      const condition = typeof p === "string" ? 'caller.kind === "user"' : "ctx.auth.scope" in p ? `caller.kind === "user" && caller.scopes.includes(${q(p["ctx.auth.scope"])})` : `caller.kind === "user" && ${q(p["ctx.staff"])}.includes(caller.role ?? "")`;
      return `  deny(caller, ${condition}, ${location} + ${q(`/requires/auth/all/${index}`)});`;
    });
  };
  const queryInputType = (schema: JsonSchema | undefined, statements: readonly LoweredStatement[]) => {
    if (!schema?.properties) return typeOf(schema);
    const binds = statements.flatMap(s => s.binds).filter(b => b.k === "input");
    const properties = Object.entries(schema.properties).map(([name, field]) => {
      const bind = binds.find(b => b.k === "input" && name.toLowerCase() === String(b.name).toLowerCase());
      if (!bind || bind.k !== "input") return `readonly ${q(name)}${schema.required?.includes(name) ? "" : "?"}: ${typeOf(field)};`;
      const type = String(bind.type);
      const driverType = type === "json" || type === "date" ? "string" : type === "timestamptz" ? "string | Date" : isSqlite
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
  /** A statement as a constant: its text and how to bind it. */
  const step = (s: LoweredStatement, path: string, fields: readonly string[], row = false) => {
    const recipes = recipesOf(s, fields, message => refuse(path, message));
    return `{ sql: ${q(s.sql)}, binds: ${q(recipes)}${row ? ", row: true" : ""} }`;
  };
  const declarations: string[] = [], views: string[] = [], procedures: string[] = [];
  const entries: Record<string, string> = {};
  const base = "@aotter/mantle-next/";
  const dialect = `${base}dialect/${isSqlite ? "sqlite" : "postgres"}`;
  const dbType = target === "bun-sqlite" ? `import type { Handle as Database } from "${base}driver/bun-sqlite";` : target === "cloudflare-d1" ? `import type { Handle as Database } from "${base}driver/d1";` : `import type { Postgres as Database } from "${base}contracts";`;
  const operation = (kind: "view" | "procedure", name: string, fn: string, input: string, output: string, body: string[]) => {
    // A file name and a module specifier at once: characters a loader could URL-decode would not resolve.
    if (!/^[A-Za-z0-9._-]+$/.test(name)) refuse(`${kind}s/${name}`, "Operation names must use only letters, digits, '.', '_' and '-'.");
    const path = `${kind}s/${name}`, row = kind === "view" ? output.slice(0, -2) : undefined;
    declarations.push(`const ${fn} = (...args: [db: Database, caller: Caller, input: ${input}]): Promise<${output}> => import(${q("./" + path + ".js")}).then(m => m.default(...args));`, `export { ${fn} as ${exportName(kind, name)} };`);
    entries[path + ".ts"] = ["// Generated native operation. No runtime plan or interpreter.", dbType,
      `import { ${["type Caller", ...(kind === "procedure" ? ["type Output"] : []), ...(body.some(line => line.startsWith("  deny(")) ? ["deny"] : [])].join(", ")} } from "${base}contracts";`,
      `import { values as D } from "${dialect}";`, `import * as DRIVER from "${base}driver/${driver}";`,
      `import { ${kind === "view" ? "binds" : "bound"} } from "${base}binds";`,
      `import type { ${input}${kind === "view" ? `, ${row}` : ""} } from "../generated.js";`,
      `export type { ${input} as Input${kind === "view" ? `, ${row} as Row` : ""} } from "../generated.js";`,
      ...(kind === "procedure" ? [`export type { Output } from "${base}contracts";`] : []), ...body].join("\n") + "\n";
  };
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
      output.push(`readonly ${q(key)}: ${nativeType(type, isSqlite)};`);
    }
    const fieldNames = inputFields(view.input, path + "/input");
    declarations.push(`export type View${index}Input = ${queryInputType(view.input ?? { type: "object", additionalProperties: false }, [c, ...(trusted ? [trusted] : [])])};`, `export type View${index}Row = { ${output.join(" ")} };`);
    operation("view", name, fn, `View${index}Input`, `View${index}Row[]`, [
      `const ${fn}Caller = ${step(c, path, fieldNames)} as const;`, ...(mode === "caller" ? [`const ${fn}Trusted = ${step(trusted!, path, fieldNames)} as const;`] : []),
      `export default async function op(db: Database, caller: Caller, raw: View${index}Input): Promise<View${index}Row[]> {`, ...auth(view.requires, path),
      `  const m = ${mode === "caller" ? `caller.kind === "system" ? ${fn}Trusted : ` : ""}${fn}Caller;`, `  return DRIVER.read(db, m.sql, binds(D, m.binds, caller, raw));`, "}"]);
    views.push(`[${q(name)}]: ${fn}`);
  }
  for (const [index, [name, procedure]] of Object.entries(plan.procedures).sort().entries()) {
    const path = `procedures/${name}`, fn = `procedure${index}`;
    if (!("sql" in procedure.handler)) { refuse(path, "Ref handlers require an explicit generated application implementation."); continue; }
    const modes = lowered.procedures[name];
    if (!modes?.caller || !modes.trusted) { refuse(path, "Both caller and trusted SQL must be lowered."); continue; }
    if ([...modes.caller, ...modes.trusted].some(s => s.hooked || s.publish || s.schema && plan.schemas[s.schema]?.publishing)) refuse(path, "Publishing and lifecycle hooks require explicit native execution.");
    const fieldNames = inputFields(procedure.input, path + "/input");
    const steps = (statements: readonly LoweredStatement[]) => `[${statements.map(s => step(s, path, fieldNames, s.kind === "row")).join(", ")}] as const`;
    const same = steps(modes.caller) === steps(modes.trusted);
    declarations.push(`export type Procedure${index}Input = ${queryInputType(procedure.input, [...modes.caller, ...modes.trusted])};`);
    operation("procedure", name, fn, `Procedure${index}Input`, "Output", [
      `const PATH = ${q(path)};`,
      `const ${fn}Caller = ${steps(modes.caller)};`, ...(same ? [] : [`const ${fn}Trusted = ${steps(modes.trusted)};`]),
      `export default async function op(db: Database, caller: Caller, raw: Procedure${index}Input): Promise<Output> {`, ...auth(procedure.requires, path, "PATH"),
      `  return { results: await DRIVER.procedure(db, bound(D, ${same ? "" : `caller.kind === "system" ? ${fn}Trusted : `}${fn}Caller, caller, raw), PATH) };`, "}"]);
    procedures.push(`[${q(name)}]: ${fn}`);
  }
  const stores = emitStores(plan.schemas, isSqlite, newId, refuse);
  if (diagnostics.length) return { ok: false, diagnostics };
  const code = [...declarations, `export const views = { ${views.join(", ")} };`, `export const procedures = { ${procedures.join(", ")} };`, ...(stores ? [`export type Tables = ${stores.tables};`, `const RULES = ${stores.rules} as const;`, `export const store = /* @__PURE__ */ createStore<Database, Tables, typeof DRIVER, { views: typeof views; procedures: typeof procedures }>(DIALECT.dialect, DRIVER, RULES, ${stores.facts}, { views, procedures });`] : [])].join("\n");
  return { ok: true, files: { ...entries, "generated.ts": ["// Generated native application SQL. No runtime plan or interpreter.", dbType,
    `import type { Caller${procedures.length ? ", Output" : ""} } from "${base}contracts";`,
    ...(stores ? [`import * as DIALECT from "${dialect}";`, `import * as DRIVER from "${base}driver/${driver}";`, `import { createStore } from "${base}store";`] : []),
    code].join("\n") + "\n" } };
}
