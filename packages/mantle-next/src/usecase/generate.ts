/** Canonical lowered programs become ordinary target-specific TypeScript, never a runtime plan. */
import { parseNumeric, type JsonSchema, type LoweredStatement } from "@aotter/mantle/spec";
import type { GenerateDiagnostic, GenerateInput, GenerateResult } from "../domain/model.js";
import { nativeType, outputType } from "../domain/columns.js";
import { databaseImport, driverFor, entry, exportName, isSqlite as sqlite, q } from "../domain/entry.js";
import { authLines as auth } from "../domain/input.js";
import { recipesOf } from "../domain/recipes.js";
import { emitTtl } from "./ttl.js";
import { emitPublishing } from "./publishing.js";
import { emitStores } from "./stores.js";
import { emitPaging } from "./paging.js";
import { emitWeb } from "./web.js";
import { emitMcp } from "./mcp.js";
import { emitValidation } from "./validation.js";
import { refuseDeclarations } from "./refusals.js";
import { emitHandlers } from "./handlers.js";
import { emitAdminDescriptors } from "./adminDescriptors.js";
import { emitAdmin } from "./admin.js";
import { emitAdminDesign } from "./adminDesign.js";
import { emitSite } from "./site.js";
import { emitTranslations } from "./translations.js";
import { emitRest } from "./rest.js";

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
export function generate(input: GenerateInput): GenerateResult {
  const { target, plan, lowered, viewKeys, newId, adminExtensions, site, paging } = input;
  const diagnostics: GenerateDiagnostic[] = [];
  refuseDeclarations({ target, plan, lowered, viewKeys, newId }, diagnostics);
  const refuse = (path: string, message: string) => { diagnostics.push({ code: "GENERATE_UNSUPPORTED", path, message }); };
  const isSqlite = sqlite(target);
  const expected = isSqlite ? "@aotter/mantle/d1" : "@aotter/mantle/postgres";
  if (lowered.dialect.name !== expected || plan.dialect.name !== expected) refuse("target", `Target '${target}' needs canonical '${expected}' compilation and lowering.`);
  const driver = driverFor(target);
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
    if (new Set(fields.map(field => field.toLowerCase())).size !== fields.length) refuse(path, "Input properties must have unique case-insensitive names. Rename input properties to be unique without regard to case.");
    return fields;
  };
  // The dialect functions the bind recipes call, so a bundle carries only those (`binds` takes this object).
  const values = new Set<string>();
  /** A statement as a constant: its text and how to bind it. */
  const step = (s: LoweredStatement, path: string, fields: readonly string[], row = false) => {
    const recipes = recipesOf(s, fields, message => refuse(path, message));
    for (const r of recipes) { if (r.k === "now" || r.k === "cutoff") values.add(r.k); else if (r.k === "input" && r.type) values.add(r.type === "date" ? "date" : "timestamp"); }
    return `{ sql: ${q(s.sql)}, binds: ${q(recipes)}${row ? ", row: true" : ""} }`;
  };
  const declarations: string[] = [], views: string[] = [], procedures: string[] = [], refProcedures: string[] = [];
  const entries: Record<string, string> = {};
  const base = "@aotter/mantle-next/";
  const refNames = emitHandlers(plan, typeOf, declarations, refProcedures);
  const hasHandlers = refNames.length > 0;
  for (const [index, [name, view]] of Object.entries(plan.views).sort().entries()) {
    const path = `views/${name}`, fn = `view${index}`;
    const modes = lowered.views[name];
    const mode = view.surface === "public" ? "public" : "caller";
    const c = modes?.[mode], trusted = modes?.trusted;
    if (!c || (mode === "caller" && !trusted)) { refuse(path, "Every reachable visibility mode must have canonical lowered SQL."); continue; }
    const keys = Object.hasOwn(viewKeys, name) ? viewKeys[name] : undefined;
    if (!keys || new Set(keys).size !== keys.length) { refuse(path, "Dynamic or repeated View outputs need an explicit generated row contract. Give each SELECT output a unique explicit alias."); continue; }
    const output: string[] = [];
    for (const key of keys) {
      const type = outputType(plan, name, key);
      // Declared timestamps and dates arrive formatted by the SQL itself (domain/wireScalars).
      output.push(`readonly ${q(key)}: ${nativeType(type, isSqlite)};`);
    }
    const fieldNames = inputFields(view.input, path + "/input");
    const callerStep = step(c, path, fieldNames), trustedStep = mode === "caller" ? step(trusted!, path, fieldNames) : callerStep;
    declarations.push(`export type View${index}Input = ${queryInputType(view.input ?? { type: "object", additionalProperties: false }, [c, ...(trusted ? [trusted] : [])])};`, `export type View${index}Row = { ${output.join(" ")} };`,
      `const ${fn}Caller = ${callerStep} as const;`, ...(trustedStep !== callerStep ? [`const ${fn}Trusted = ${trustedStep} as const;`] : []),
      `async function ${fn}(db: Database, caller: Caller, raw: View${index}Input): Promise<View${index}Row[]> {`, ...auth(view.requires, path),
      `  const m = ${trustedStep !== callerStep ? `caller.kind === "system" ? ${fn}Trusted : ` : ""}${fn}Caller;`, `  return DRIVER.read(db, m.sql, binds(D, m.binds, caller, raw));`, "}");
    views.push(`[${q(name)}]: ${fn}`);
    declarations.push(`export { ${fn} as ${exportName("view", name)} };`);
    entries[`views/${encodeURIComponent(name)}.ts`] = entry("view", name, `View${index}Input as Input, View${index}Row as Row`);
  }
  for (const [index, [name, procedure]] of Object.entries(plan.procedures).sort().entries()) {
    const path = `procedures/${name}`, fn = `procedure${index}`;
    if (!("sql" in procedure.handler)) continue;
    const modes = lowered.procedures[name];
    if (!modes?.caller || !modes.trusted) { refuse(path, "Both caller and trusted SQL must be lowered."); continue; }
    if ([...modes.caller, ...modes.trusted].some(s => s.publish || s.schema && plan.schemas[s.schema]?.publishing)) refuse(path, "Publishing writes are generated: use the Store and the `<schema>.publish` / `.unpublish` / `.archive` transitions.");
    const fieldNames = inputFields(procedure.input, path + "/input");
    const steps = (statements: readonly LoweredStatement[]) => `[${statements.map(s => step(s, path, fieldNames, s.kind === "row")).join(", ")}] as const`;
    const same = steps(modes.caller) === steps(modes.trusted);
    declarations.push(`export type Procedure${index}Input = ${queryInputType(procedure.input, [...modes.caller, ...modes.trusted])};`,
      `const ${fn}Caller = ${steps(modes.caller)};`, ...(same ? [] : [`const ${fn}Trusted = ${steps(modes.trusted)};`]),
      `async function ${fn}(db: Database, caller: Caller, raw: Procedure${index}Input): Promise<Output> {`, ...auth(procedure.requires, path),
      `  return { results: await DRIVER.procedure(db, bound(D, ${same ? "" : `caller.kind === "system" ? ${fn}Trusted : `}${fn}Caller, caller, raw), ${q(path)}) };`, "}");
    procedures.push(`[${q(name)}]: ${fn}`);
    declarations.push(`export { ${fn} as ${exportName("procedure", name)} };`);
    entries[`procedures/${encodeURIComponent(name)}.ts`] = entry("procedure", name, `Procedure${index}Input as Input`, `export type { Output } from "${base}contracts";\n`);
  }
  emitTtl(plan, isSqlite, declarations, procedures, entries, refuse);
  emitPublishing(plan, isSqlite, declarations, procedures, entries, values, refuse);
  const stores = emitStores(plan.schemas, isSqlite, newId, refuse, hasHandlers);
  const surfaces = { ...emitPaging(plan, lowered, target, refuse, paging), ...emitValidation(plan, refuse), ...emitRest(plan, lowered, target), ...emitWeb(plan, lowered, target), ...emitMcp(plan, lowered, target, refuse), ...emitAdminDescriptors({plan,adminExtensions},diagnostics), ...emitAdmin(input,refuse), ...emitAdminDesign(), ...emitSite(target, site, refuse, Object.keys(plan.schemas)), ...emitTranslations(plan,target) };
  if (diagnostics.length) return { ok: false, diagnostics };
  const storeProcedures = hasHandlers ? "storeProcedures" : "procedures";
  const code = [...declarations, `export const views = { ${views.join(", ")} };`, `export const procedures = { ${procedures.join(", ")} };`, ...(stores ? [
    `export type Tables = ${stores.tables};`, `const RULES = ${stores.rules} as const;`,
    ...(hasHandlers ? [`const storeProcedures = { ${[...procedures, ...refProcedures].join(", ")} };`] : []),
    `${hasHandlers ? "const makeStore" : "export const store"} = /* @__PURE__ */ createStore<Database, Tables, typeof DRIVER, { views: typeof views; procedures: typeof ${storeProcedures} }${hasHandlers ? ", { handlers: Handlers }" : ""}>(DIALECT.dialect, DRIVER, RULES, ${stores.facts}, { views, procedures: ${storeProcedures} });`,
    ...(hasHandlers ? [`export function store<const H extends Handlers>(db: Database, caller: Caller, options: { handlers: H & Record<Exclude<keyof H, keyof Handlers>, never> }): ReturnType<typeof makeStore> { return makeStore(db, caller, options); }`] : []),
  ] : [])].join("\n");
  const dialect = `${base}dialect/${isSqlite ? "sqlite" : "postgres"}`;
  const contracts = [...(target.endsWith("postgres") ? ["type Postgres as Database"] : []), "type Caller", ...(hasHandlers ? ["ContractError"] : []), ...(/^  deny\(/m.test(code) ? ["deny"] : []), ...(procedures.length ? ["type Output"] : [])];
  const dbType = isSqlite ? databaseImport(target) : "";
  return { ok: true, refProcedures: refNames, files: { ...surfaces, ...entries, "generated.ts": ["// Generated native application SQL. No runtime plan or interpreter.", dbType, `import { ${contracts.join(", ")} } from "${base}contracts";`,
    ...(values.size || stores ? [`import * as DIALECT from "${dialect}";`] : []), `import * as DRIVER from "${base}driver/${driver}";`, ...(stores ? [`import { createStore } from "${base}store";`] : []),
    `import { ${procedures.length ? "binds, bound" : "binds"} } from "${base}binds";`,
    `const D = { ${[...values].sort().map(v => `${v}: DIALECT.${v}`).join(", ")} };`, code].filter(Boolean).join("\n") + "\n" } };
}
