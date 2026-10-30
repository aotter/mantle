import { userReferences } from "../domain/userReferences.js";
/** Canonical lowered programs become ordinary target-specific TypeScript, never a runtime plan. */
import { parseNumeric, tableOutputs, type JsonSchema, type LoweredStatement } from "../build/compiler.js";
import type { GenerateDiagnostic, GenerateInput, GenerateResult } from "../domain/model.js";
import { boundaryType, nativeType, outputType, wireType } from "../domain/columns.js";
import { databaseImport, driverFor, entry, exportName, generatedFiles, isSqlite as sqlite, q } from "../domain/entry.js";
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
import { emitAdminClient } from "./adminClient.js";
import { emitSite } from "./site.js";
import { emitTranslations } from "./translations.js";
import { emitAdminBindings } from "./adminBindings.js";
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
  const { target, plan, lowered, viewKeys, newId, site, admin, paging } = input;
  const diagnostics: GenerateDiagnostic[] = [];
  refuseDeclarations({ plan }, diagnostics);
  const refuse = (path: string, message: string) => { diagnostics.push({ code: "GENERATE_UNSUPPORTED", path, message }); };
  const isSqlite = sqlite(target);
  const user = userReferences(plan, isSqlite);
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
      const driverType = type === "json" ? typeOf(field) : type === "date" ? "string" : type === "timestamptz" ? "string | Date" : isSqlite
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
  // Repeated SQL texts and bind recipes are emitted once as module constants (see `unpool`).
  const pool = new Map<string, string>();
  const pooled = (text: string) => { let id = pool.get(text); if (!id) pool.set(text, id = `\u0000_p${pool.size}\u0000`); return id; };
  /** A statement as a constant: its text and how to bind it. */
  const step = (s: LoweredStatement, path: string, fields: readonly string[], row = false) => {
    // a row op must change exactly one row; a set op whose step says `onNoRows: conflict` at least one (#1874)
    const recipes = recipesOf(s, fields, message => refuse(path, message)), probe = row && s.probe ? recipesOf(s.probe, fields, message => refuse(path, message)) : [];
    for (const r of [...recipes, ...probe]) { if (r.k === "now" || r.k === "cutoff") values.add(r.k); else if (r.k === "input" && r.type) values.add(r.type === "date" ? "date" : "timestamp"); }
    // #1822: the lock probe the driver reads when this row write changes no row
    const locks = Object.fromEntries((plan.schemas[s.schema ?? ""]?.locks ?? []).filter(l => l.on.includes(s.verb as "update")).map(l => [l.name, l.message]));
    const lock = row && s.probe ? `, lock: ${q({ sql: s.probe.sql, binds: probe, schema: plan.schemas[s.schema!]!.name, verb: s.verb, locks })}` : "";
    return `{ sql: ${pooled(q(s.sql))}, binds: ${pooled(q(recipes))}${row ? ", row: true" : s.onNoRows ? ', row: "some"' : ""}${lock} }`;
  };
  const declarations: string[] = [], views: string[] = [], procedures: string[] = [], refProcedures: string[] = [];
  const entries: Record<string, string> = {};
  const base = "@aotter/mantle/";
  const refNames = emitHandlers(plan, target !== "cloudflare-d1", typeOf, declarations, refProcedures);
  const hasHandlers = refNames.length > 0;
  for (const [index, [name, view]] of Object.entries(plan.views).sort().entries()) {
    const path = `views/${name}`, fn = `view${index}`;
    const modes = lowered.views[name];
    const mode = view.surface === "public" ? "public" : "caller";
    const c = modes?.[mode], trusted = modes?.trusted;
    if (!c || (mode === "caller" && !trusted)) { refuse(path, "Every reachable visibility mode must have canonical lowered SQL."); continue; }
    const keys = Object.hasOwn(viewKeys, name) ? viewKeys[name] : undefined;
    if (!keys || new Set(keys).size !== keys.length) { refuse(path, "Dynamic or repeated View outputs need an explicit generated row contract. Give each SELECT output a unique explicit alias."); continue; }
    const output: string[] = [], direct = tableOutputs(view, plan.schemas);
    for (const key of keys) {
      // A table column read unchanged keeps its NOT NULL (and gives a native column such as `id` its type); anything else may be NULL.
      const type = outputType(plan, name, key) ?? direct[key]?.type;
      // Declared timestamps and dates arrive formatted by the SQL itself (domain/wireScalars).
      output.push(`readonly ${q(key)}: ${nativeType(type, isSqlite, direct[key]?.notNull)};`);
    }
    const fieldNames = inputFields(view.input, path + "/input");
    const callerStep = step(c, path, fieldNames), trustedStep = mode === "caller" ? step(trusted!, path, fieldNames) : callerStep;
    declarations.push(`export type View${index}Input = ${queryInputType(view.input ?? { type: "object", additionalProperties: false }, [c, ...(trusted ? [trusted] : [])])};`, `export type View${index}Row = { ${output.join(" ")} };`, `export type View${index}WireRow = { ${keys.map(key => `readonly ${q(key)}: ${boundaryType(plan, name, key) ? wireType(boundaryType(plan, name, key), direct[key]?.notNull) : `View${index}Row[${q(key)}]`};`).join(" ")} };`,
      `const ${fn}Caller = ${callerStep} as const;`, ...(trustedStep !== callerStep ? [`const ${fn}Trusted = ${trustedStep} as const;`] : []),
      `async function ${fn}(db: ${isSqlite ? "Database" : "Unsafe"}, caller: Caller, raw: View${index}Input): Promise<View${index}Row[]> {`, ...auth(view.requires, path), ...(user.used ? ['  USER.modeOf(caller);'] : []),
      `  const m = ${trustedStep !== callerStep ? `${user.used ? 'USER.modeOf(caller) === "trusted"' : 'caller.kind === "system"'} ? ${fn}Trusted : ` : ""}${fn}Caller;`, `  return DRIVER.read(db, ${user.used ? "USER.scoped(m.sql, caller)" : "m.sql"}, binds(D, m.binds, caller, raw));`, "}");
    views.push(`[${q(name)}]: ${fn}`);
    declarations.push(`export { ${fn} as ${exportName("view", name)} };`);
    entries[`views/${encodeURIComponent(name)}.ts`] = entry("view", name, `View${index}Input as Input, View${index}Row as Row, View${index}WireRow as WireRow`);
  }
  for (const [index, [name, procedure]] of Object.entries(plan.procedures).sort().entries()) {
    const path = `procedures/${name}`, fn = `procedure${index}`;
    if (!("sql" in procedure.handler)) continue;
    const modes = lowered.procedures[name];
    if (!modes?.caller || !modes.trusted) { refuse(path, "Both caller and trusted SQL must be lowered."); continue; }
    if ([...modes.caller, ...modes.trusted].some(s => s.publish || s.schema && plan.schemas[s.schema]?.publishing)) refuse(path, "A SQL Procedure cannot write a publishing Schema: create and edit its rows from a ref handler through the Store (`ctx.store.collection(...)`), and change status with the generated `<schema>.publish` / `.unpublish` / `.archive` transitions.");
    const fieldNames = inputFields(procedure.input, path + "/input");
    const steps = (statements: readonly LoweredStatement[]) => `[${statements.map(s => step(s, path, fieldNames, s.kind === "row")).join(", ")}] as const`;
    const same = steps(modes.caller) === steps(modes.trusted);
    declarations.push(`export type Procedure${index}Input = ${queryInputType(procedure.input, [...modes.caller, ...modes.trusted])};`,
      `const ${fn}Caller = ${steps(modes.caller)};`, ...(same ? [] : [`const ${fn}Trusted = ${steps(modes.trusted)};`]),
      `async function ${fn}(db: Database, caller: Caller, raw: Procedure${index}Input): Promise<Output> {`, ...(modes.caller.some(s => s.kind !== "read") ? [`  await _fresh(caller, ${q(path)});`] : []), ...auth(procedure.requires, path), ...(user.used ? ['  USER.modeOf(caller);'] : []), ...(procedure.trustedOnly ? [`  deny(caller, USER.modeOf(caller) === "trusted", ${q(path)});`] : []),
      `  return { results: await DRIVER.procedure(db, bound(D, ${user.used ? "USER.scopedAll(" : ""}${same ? "" : `${user.used ? 'USER.modeOf(caller) === "trusted"' : 'caller.kind === "system"'} ? ${fn}Trusted : `}${fn}Caller${user.used ? ", caller)" : ""}, caller, raw), ${q(path)}) };`, "}");
    procedures.push(`[${q(name)}]: ${fn}`);
    declarations.push(`export { ${fn} as ${exportName("procedure", name)} };`);
    entries[`procedures/${encodeURIComponent(name)}.ts`] = entry("procedure", name, `Procedure${index}Input as Input`, `export type { Output } from "${base}contracts";\n`);
  }
  emitTtl(plan, isSqlite, declarations, procedures, entries, refuse);
  emitPublishing(plan, isSqlite, declarations, procedures, entries, values, refuse, input.locks);
  const stores = emitStores(plan.schemas, isSqlite, newId, refuse, hasHandlers, input.locks);
  const surfaces = { ...emitPaging(plan, lowered, target, refuse, paging), ...emitPaging(plan, input.wireLowered ?? lowered, target, refuse, paging, true), ...emitValidation(plan, refuse), ...emitRest(plan, lowered, target, input.description), ...emitWeb(plan, lowered, target), ...emitMcp(plan, lowered, target, input.description, refuse, !!site), ...emitAdminDescriptors({plan,admin},diagnostics), ...emitAdminBindings(input,refuse), ...(admin ? emitAdminClient(plan, typeOf) : {}), ...emitSite(target, site, refuse, Object.keys(plan.schemas)), ...emitTranslations(plan,target) };
  if (diagnostics.length) return { ok: false, diagnostics };
  const storeProcedures = hasHandlers ? "storeProcedures" : "procedures";
  const code = [...(declarations.some(d => d.includes("  await _fresh(caller, ")) ? ['const _fresh = (caller: Caller, path: string) => "authenticatedAs" in caller && caller.authenticatedAs === "snapshot" ? import("@aotter/mantle/host-caller").then(m => m.checkFresh(caller, false, path)) : undefined;'] : []), ...(Object.keys(plan.access?.userFields ?? {}).length ? [`export const userFields = ${q(plan.access!.userFields)} as const;`] : []), ...declarations, `export const views = { ${views.join(", ")} };`, `export const procedures = { ${procedures.join(", ")} };`, ...(stores ? [
    `export type Tables = ${stores.tables};`, `const RULES = ${stores.rules} as const;`,
    ...(hasHandlers ? [`const storeProcedures = { ${[...procedures, ...refProcedures].join(", ")} };`] : []),
    `const initStore = () => createStore<Database, Tables, typeof DRIVER, { views: typeof views; procedures: typeof ${storeProcedures} }${hasHandlers ? ", { handlers: Handlers }" : ""}>(${user.used ? "{...DIALECT.dialect, ...USER_VALUES}" : "DIALECT.dialect"}, DRIVER, RULES, ${stores.facts}, { views, procedures: ${storeProcedures} });`,
    `let makeStore: ReturnType<typeof initStore>;`,
    `export function store${hasHandlers ? "<const H extends Handlers>" : ""}(db: Database, caller: Caller${hasHandlers ? ", options: { handlers: H & Record<Exclude<keyof H, keyof Handlers>, never> }" : ", _options?: { handlers?: Handlers }"}): ReturnType<typeof makeStore> { return (makeStore ??= initStore())(db, caller${hasHandlers ? ", options" : ""}); }`,
  ] : [])].join("\n");
  function unpool(text: string): string[] {
    const shared: string[] = [];
    for (const [value, token] of pool) {
      if (text.split(token).length > 2) { const id = token.slice(1, -1); shared.push(`const ${id} = ${value} as const;`); text = text.replaceAll(token, id); }
      else text = text.replace(token, () => value);
    }
    return [...shared, text];
  }
  const dialect = `${base}dialect/${isSqlite ? "sqlite" : "postgres"}`;
  const contracts = [...(target.endsWith("postgres") ? ["type Postgres as Database", ...(views.length ? ["type Unsafe"] : [])] : []), "type Caller", ...(hasHandlers ? ["ContractError"] : []), ...(/^  deny\(/m.test(code) ? ["deny", ...(/\bisAdmin\(/.test(code) ? ["isAdmin"] : []), ...(/\bisUser\(/.test(code) ? ["isUser"] : [])] : []), ...(procedures.length ? ["type Output"] : [])];
  const dbType = isSqlite ? databaseImport(target) : "";
  return { ok: true, refProcedures: refNames, files: generatedFiles({ ...surfaces, ...entries, "generated.ts": ["// Generated native application SQL. No runtime plan or interpreter.", user.code, dbType, `import { ${contracts.join(", ")} } from "${base}contracts";`,
    ...(values.size || stores ? [`import * as DIALECT from "${dialect}";`] : []), `import * as DRIVER from "${base}driver/${driver}";`, ...((names => names.length ? [`import { ${names.join(", ")} } from "${base}store";`] : [])([...(stores ? ["createStore"] : []), ...(hasHandlers && target !== "cloudflare-d1" ? ["handlerTransaction"] : [])])),
    `import { ${procedures.length ? "binds, bound" : "binds"} } from "${base}binds";`,
    `const D = { ${[...values].sort().map(v => `${v}: DIALECT.${v}`).concat(user.values ? [user.values] : []).join(", ")} };`, ...unpool(code)].filter(Boolean).join("\n") + "\n" }) };
}
