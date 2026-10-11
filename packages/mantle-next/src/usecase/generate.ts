/** Canonical lowered programs become ordinary target-specific TypeScript, never a runtime plan. */
import { parseNumeric, type JsonSchema, type LoweredStatement } from "@aotter/mantle/spec";
import type { GenerateDiagnostic, GenerateInput, GenerateResult, Target } from "../domain/model.js";
import { outputType } from "../domain/wireScalars.js";

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
const scalarType = (type: string) => type === "bool" ? "boolean" : ["integer", "int4", "int8", "real", "float8"].includes(type) ? "number" : type === "json" ? "unknown" : type === "geo" ? "{lat:number;lng:number}" : "string";

export function generate({ target, plan, lowered, viewKeys }: GenerateInput): GenerateResult {
  const diagnostics: GenerateDiagnostic[] = [];
  const refuse = (path: string, message: string) => { diagnostics.push({ code: "GENERATE_UNSUPPORTED", path, message }); };
  const isSqlite = sqlite(target);
  const expected = isSqlite ? "@aotter/mantle/d1" : "@aotter/mantle/postgres";
  if (lowered.dialect.name !== expected || plan.dialect.name !== expected) refuse("target", `Target '${target}' needs canonical '${expected}' compilation and lowering.`);
  for (const name of Object.keys(plan.triggers)) refuse(`triggers/${name}`, "Native Trigger dispatch is not implemented; generation cannot omit it.");
  const helpers = new Set(["ContractError"]);
  const bind = (s: LoweredStatement, path: string, fieldNames: readonly string[]) => `${isSqlite ? "" : "["}${s.binds.map(b => {
    switch (b.k) {
      case "uid": return "uid";
      case "role": return "role";
      case "now": return isSqlite ? "now" : "new Date(now)";
      case "cutoff": return isSqlite ? `now - ${q(b.seconds)} * 1_000_000` : `new Date(now - ${q(b.seconds)} * 1000)`;
      case "const": return q(b.value) ?? "undefined";
      case "input": {
        const field = fieldNames.find(name => name.toLowerCase() === String(b.name).toLowerCase());
        if (field === undefined) refuse(path, `Input bind '${b.name}' has no declared field.`);
        const value = `given[${q(field ?? b.name)}]`, type = String(b.type);
        if (type !== "timestamptz" && type !== "date") return value;
        const helper = (isSqlite ? "encode" : "iso") + (type === "date" ? "Date" : "Timestamptz");
        helpers.add(helper);
        return `(${value} == null ? null : ${helper}(${value}))`;
      }
      default: refuse(path, `Bind recipe '${b.k}' needs an explicit native implementation.`); return "undefined";
    }
  }).join(", ")}${isSqlite ? "" : "]"}`;
  const declarations: string[] = [], views: string[] = [], procedures: string[] = [];
  const entries: Record<string, string> = {};
  const auth = (requires: typeof plan.views[string]["requires"], path: string): string[] => {
    if (requires?.guard) refuse(path, "Procedure guards require a generated native dispatch implementation.");
    return (requires?.auth?.all ?? []).map((p, index) => {
      const condition = typeof p === "string" ? 'caller.kind === "user"' : "ctx.auth.scope" in p ? `caller.kind === "user" && caller.scopes.includes(${q(p["ctx.auth.scope"])})` : `caller.kind === "user" && ${q(p["ctx.staff"])}.includes(caller.role ?? "")`;
      return `  let allowed${index}: boolean = ${condition};\n  if (!allowed${index}) throw new ContractError(caller.kind === "user" ? "AUTH_DENIED" : "UNAUTHENTICATED", "Authorization predicate not satisfied.", ${q(`${path}/requires/auth/all/${index}`)});`;
    });
  };
  const usesInput = (statements: readonly LoweredStatement[]) => statements.some(s => s.binds.some(b => b.k === "input"));
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
  const given = (statements: readonly LoweredStatement[]) => usesInput(statements) ? "  const given = raw;" : "";
  const inputFields = (schema: JsonSchema | undefined, path: string) => {
    const fields = Object.keys(schema?.properties ?? {});
    if (new Set(fields.map(field => field.toLowerCase())).size !== fields.length) refuse(path, "Input properties must have unique case-insensitive names.");
    return fields;
  };
  const context = (statements: readonly LoweredStatement[]) => [
    ...(statements.some(s => s.binds.some(b => b.k === "uid")) ? ['  const uid = caller.kind === "user" ? caller.subject : caller.kind === "system" ? `system:${caller.reason}` : null;'] : []),
    ...(statements.some(s => s.binds.some(b => b.k === "role")) ? ['  const role = caller.kind === "user" ? caller.role : null;'] : []),
    ...(statements.some(s => s.binds.some(b => b.k === "now" || b.k === "cutoff")) ? [isSqlite ? "  const now = Date.now() * 1000;" : "  const now = Date.now();"] : []),
  ];
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
  const read = (sql: string, binds: string): string => target === "bun-sqlite" ? `db.query(${q(sql)}).all(${binds})` : target === "cloudflare-d1" ? `(await db.prepare(${q(sql)}).bind(${binds}).all()).results` : `await db.unsafe(${q(sql)}, ${binds})`;
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
      const nativeType = !type ? "unknown" : ["date", "timestamptz"].includes(type) ? "string" : isSqlite
        ? type === "bool" ? "number" : type === "json" ? "string" : scalarType(type)
        : ["integer", "int8"].includes(type) ? "number | string" : scalarType(type);
      output.push(`readonly ${q(key)}: ${nativeType} | null;`);
    }
    declarations.push(`export type View${index}Input = ${queryInputType(view.input ?? { type: "object", additionalProperties: false }, [c, ...(trusted ? [trusted] : [])])};`, `export type View${index}Row = { ${output.join(" ")} };`);
    const fieldNames = inputFields(view.input, path + "/input");
    declarations.push(`async function ${fn}(db: Database, caller: Caller, raw: View${index}Input): Promise<View${index}Row[]> {`, ...auth(view.requires, path), given([c, ...(trusted ? [trusted] : [])]), ...context([c, ...(trusted ? [trusted] : [])]), `  const rows = (${mode === "caller" ? `caller.kind === "system" ? ${read(sqlOf(trusted!, path), bind(trusted!, path, fieldNames))} : ` : ""}${read(sqlOf(c, path), bind(c, path, fieldNames))})${isSqlite ? " as Record<string, unknown>[]" : ""};`, `  return rows as View${index}Row[];`, "}");
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
    declarations.push(`export type Procedure${index}Input = ${queryInputType(procedure.input, [...modes.caller, ...modes.trusted])};`, `export type Procedure${index}Output = { readonly results: ReadonlyArray<ReadonlyArray<Record<string, unknown>>> };`);
    const fieldNames = inputFields(procedure.input, path + "/input");
    declarations.push(`async function ${fn}(db: Database, caller: Caller, raw: Procedure${index}Input): Promise<Procedure${index}Output> {`, ...auth(procedure.requires, path), given([...modes.caller, ...modes.trusted]), ...context([...modes.caller, ...modes.trusted]));
    const branch = (statements: readonly LoweredStatement[]): string[] => {
      if (target === "cloudflare-d1") {
        const batch: string[] = [], rows: string[] = [];
        for (const [i, statement] of statements.entries()) {
          rows.push(`batch[${batch.length}]!.results`);
          batch.push(`db.prepare(${q(statement.sql)}).bind(${bind(statement, path, fieldNames)})`);
          if (statement.kind === "row") batch.push(`db.prepare(${q(`INSERT INTO _mantle_assert (op,ok) SELECT ${i}, changes() = 1`)})`);
        }
        return [`    const batch = await db.batch([${batch.join(", ")}]);`, `    return [${rows.join(", ")}];`];
      }
      const lines = ["    const results: unknown[][] = [];"];
      for (const s of statements) {
        const binds = bind(s, path, fieldNames);
        if (target === "bun-sqlite") {
          if (s.kind === "read" || s.returns) {
            lines.push(`    const rows${lines.length} = ${read(s.sql, binds)};`);
            const name = `rows${lines.length - 1}`;
            if (s.kind === "row") lines.push(`    if (${name}.length !== 1) throw new ContractError("CONFLICT", "Expected one affected row.", ${q(path)});`);
            lines.push(`    results.push(${name} as unknown[]);`);
          } else {
            const name = `changed${lines.length}`;
            lines.push(`    const ${name} = db.query(${q(s.sql)}).run(${binds});`);
            if (s.kind === "row") lines.push(`    if (${name}.changes !== 1) throw new ContractError("CONFLICT", "Expected one affected row.", ${q(path)});`);
            lines.push("    results.push([]);");
          }
        } else {
          const name = `result${lines.length}`;
          lines.push(`    const ${name} = await db.unsafe(${q(sqlOf(s, path))}, ${binds});`);
          if (s.kind === "row") lines.push(`    if (${name}.count !== 1) throw new ContractError("CONFLICT", "Expected one affected row.", ${q(path)});`);
          lines.push(`    results.push(${name});`);
        }
      }
      lines.push("    return results;"); return lines;
    };
    const trustedLines = branch(modes.trusted), callerLines = branch(modes.caller);
    const operation = ["  const execute = " + (target === "bun-sqlite" ? "(db: Database)" : "async (db: Database)") + " => {", ...(trustedLines.join() === callerLines.join() ? [] : ['    if (caller.kind === "system") {', ...trustedLines, "    }"]), ...callerLines, "  };" ];
    // One statement is atomic on its own: a row op touches at most one row (one-row INSERT or unique `id =`), so a failed
    // count check after autocommit has changed nothing. Skipping BEGIN/COMMIT saves two PostgreSQL round trips.
    const single = modes.caller.length === 1 && modes.trusted.length === 1;
    if (!isSqlite) helpers.add("postgresOutcome");
    declarations.push(...operation);
    const run = single ? "execute(db)" : "db.transaction(execute)(db)";
    if (target === "bun-sqlite") declarations.push(`  const results = ${run};`);
    else if (target === "cloudflare-d1") declarations.push("  const results = await execute(db);");
    else declarations.push(
      "  let results: unknown[][];",
      ...(single ? ["  try { results = await execute(db); } catch (error) {", `    throw error instanceof ContractError ? error : postgresOutcome(error, ${q(path)});`, "  }"]
        // Failure before the callback returns was rolled back by begin(); only a failed COMMIT can leave the outcome unknown.
        : ["  let committing = false;", '  try { results = await db.begin("isolation level serializable", async (tx) => { const rows = await execute(tx); committing = true; return rows; }); } catch (error) {',
          `    throw error instanceof ContractError || !committing ? error : postgresOutcome(error, ${q(path)});`, "  }"]));
    declarations.push(`  return { results } as Procedure${index}Output;`, "}");
    procedures.push(`[${q(name)}]: ${fn}`);
    declarations.push(`export { ${fn} as ${exportName("procedure", name)} };`);
    entries[`procedures/${encodeURIComponent(name)}.ts`] = `import { ${exportName("procedure", name)} as operation } from "../generated.js";\nexport default operation;\nexport type { Procedure${index}Input as Input, Procedure${index}Output as Output } from "../generated.js";\n`;
  }
  if (diagnostics.length) return { ok: false, diagnostics };
  const dbType = target === "bun-sqlite" ? 'import type { Database } from "bun:sqlite";' : target === "cloudflare-d1" ? 'import type { D1Database as Database } from "@cloudflare/workers-types";' : 'import type { Postgres as Database } from "@aotter/mantle-next/contracts";';
  return { ok: true, files: { ...entries, "generated.ts": ["// Generated native application SQL. No runtime plan or interpreter.", dbType, 'import type { Caller } from "@aotter/mantle-next/contracts";', `import { ${[...helpers].sort().join(", ")} } from "@aotter/mantle-next/contracts";`, ...(!isSqlite ? ["// Application/deployment-owned PostgreSQL settings; functions never apply SET or own connections.", 'export const postgresRequirements = { DateStyle: "ISO, YMD", IntervalStyle: "postgres", TimeZone: "UTC", standard_conforming_strings: "on", extra_float_digits: "1", statement_timeout: "10000ms" } as const;'] : []), ...declarations, `export const views = { ${views.join(", ")} };`, `export const procedures = { ${procedures.join(", ")} };`, ""].join("\n") } };
}
