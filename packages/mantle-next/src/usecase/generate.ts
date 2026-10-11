/** Canonical lowered programs become ordinary target-specific TypeScript, never a runtime plan. */
import { parseNumeric, type JsonSchema, type LoweredStatement } from "@aotter/mantle/spec";
import type { GenerateDiagnostic, GenerateInput, GenerateResult, Target } from "../domain/model.js";
import { emitValidator } from "../domain/validation.js";

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

export function generate(input: GenerateInput): GenerateResult {
  const native = emit(input, true);
  if (!native.ok || !input.checked) return native;
  const checked = emit(input, false);
  if (!checked.ok) return checked;
  return { ok: true, files: { ...native.files,
    "checked.ts": checked.files["generated.ts"]!,
    ...Object.fromEntries(Object.entries(checked.files).filter(([name]) => name !== "generated.ts")
      .map(([name, source]) => ["checked/" + name, source.replaceAll('"../generated.js"', '"../../checked.js"')])),
  } };
}

/** Selection happens during generation, never during a query call. */
function emit({ target, plan, lowered, viewKeys }: GenerateInput, native: boolean): GenerateResult {
  const diagnostics: GenerateDiagnostic[] = [];
  const refuse = (path: string, message: string) => { diagnostics.push({ code: "GENERATE_UNSUPPORTED", path, message }); };
  const isSqlite = sqlite(target);
  const expected = isSqlite ? "@aotter/mantle/d1" : "@aotter/mantle/postgres";
  if (lowered.dialect.name !== expected || plan.dialect.name !== expected) refuse("target", `Target '${target}' needs canonical '${expected}' compilation and lowering.`);
  for (const name of Object.keys(plan.triggers)) refuse(`triggers/${name}`, "Native Trigger dispatch is not implemented; generation cannot omit it.");
  const helpers = new Set(native ? ["ContractError"] : ["validate", "ContractError", "databaseError", ...(!isSqlite ? ["decodeField"] : [])]);
  const encode = (type: string, value: string, path: string): string => {
    if (native) return value;
    const call = (helper: string, args = value) => { helpers.add(helper); return `${helper}(${args})`; };
    const numeric = parseNumeric(type);
    let expression: string;
    if (numeric) { expression = call("encodeNumeric", `value, ${numeric.p}, ${numeric.s}`); if (!isSqlite) expression = call("decodeNumeric", `${expression}, ${numeric.s}`); }
    else switch (type) {
      case "text": expression = "String(value)"; break;
      case "integer": case "int4": case "int8": expression = call("encodeInteger", "value"); break;
      case "real": case "float8": expression = "value"; break;
      case "bool": expression = isSqlite ? "value ? 1 : 0" : "!!value"; break;
      case "json": expression = "JSON.stringify(value)"; break;
      case "date": expression = call("encodeDate", "value"); if (!isSqlite) expression = call("decodeDate", expression); break;
      case "timestamptz": expression = call("encodeTimestamptz", "value"); if (!isSqlite) expression = call("decodeTimestamptz", expression); break;
      default: refuse(path, `Native binding for '${type}' is not implemented.`); expression = "undefined";
    }
    return `(value = ${value}, value == null ? null : ${expression})`;
  };
  const bind = (s: LoweredStatement, path: string, fieldNames: readonly string[]) => `${isSqlite ? "" : "["}${s.binds.map(b => {
    switch (b.k) {
      case "uid": return "uid";
      case "role": return "role";
      case "now": return native && !isSqlite ? "new Date(now)" : encode("timestamptz", "now", path);
      case "cutoff": return native && !isSqlite ? `new Date(now - ${q(b.seconds)} * 1000)` : encode("timestamptz", `now - ${q(b.seconds)} * 1_000_000`, path);
      case "const": return q(b.value) ?? "undefined";
      case "input": {
        const field = fieldNames.find(name => name.toLowerCase() === String(b.name).toLowerCase());
        if (field === undefined) refuse(path, `Input bind '${b.name}' has no declared field.`);
        return encode(String(b.type), `given[${q(field ?? b.name)}]`, path);
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
  const validation = (name: string, schema: JsonSchema | undefined, path: string) => {
    const actual = schema ?? { type: "object" as const, properties: {}, additionalProperties: false };
    const expression = emitValidator(actual);
    if (!expression) refuse(path, "This JSON Schema cannot yet be emitted as a native validation factory.");
    declarations.push(`let ${name}: z.ZodType | undefined;`);
    return `${name} ??= ${expression ?? "z.never()"}`;
  };
  const usesInput = (statements: readonly LoweredStatement[]) => statements.some(s => s.binds.some(b => b.k === "input"));
  const queryInputType = (schema: JsonSchema | undefined, statements: readonly LoweredStatement[]) => {
    if (!native || !schema?.properties) return typeOf(schema);
    const binds = statements.flatMap(s => s.binds).filter(b => b.k === "input");
    const properties = Object.entries(schema.properties).map(([name, field]) => {
      const bind = binds.find(b => b.k === "input" && name.toLowerCase() === String(b.name).toLowerCase());
      if (!bind || bind.k !== "input") return `readonly ${q(name)}${schema.required?.includes(name) ? "" : "?"}: ${typeOf(field)};`;
      const type = String(bind.type);
      const driverType = type === "json" ? "string" : isSqlite
        ? ["bool", "date", "timestamptz"].includes(type) || parseNumeric(type) ? "number" : typeOf(field)
        : ["date", "timestamptz"].includes(type) ? "Date | string" : parseNumeric(type) ? "number | string" : typeOf(field);
      const nullable = field.nullable === true || Array.isArray(field.type) && field.type.includes("null") || !schema.required?.includes(name);
      // D1 cannot bind undefined. Bound fields are explicit, null represents absence.
      return `readonly ${q(name)}: ${driverType}${nullable ? " | null" : ""};`;
    });
    return `{ ${properties.join(" ")} ${schema.additionalProperties !== false ? "readonly [key:string]: unknown;" : ""} }`;
  };
  const checkedInput = (validator: string, path: string, statements: readonly LoweredStatement[]) => native ? (usesInput(statements) ? "  const given = raw;" : "") : `  ${usesInput(statements) ? "const given = " : ""}validate(${validator}, raw, ${q(path + "/input")})${usesInput(statements) ? " as Record<string, unknown>" : ""};`;
  const inputFields = (schema: JsonSchema | undefined, path: string) => {
    const fields = Object.keys(schema?.properties ?? {});
    if (new Set(fields.map(field => field.toLowerCase())).size !== fields.length) refuse(path, "Input properties must have unique case-insensitive names.");
    return fields;
  };
  const context = (statements: readonly LoweredStatement[]) => [
    ...(statements.some(s => s.binds.some(b => b.k === "uid")) ? ['  const uid = caller.kind === "user" ? caller.subject : caller.kind === "system" ? `system:${caller.reason}` : null;'] : []),
    ...(statements.some(s => s.binds.some(b => b.k === "role")) ? ['  const role = caller.kind === "user" ? caller.role : null;'] : []),
    ...(statements.some(s => s.binds.some(b => b.k === "now" || b.k === "cutoff")) ? [native && !isSqlite ? "  const now = Date.now();" : "  const now = Date.now() * 1000;"] : []),
    ...(!native && statements.some(s => s.binds.some(b => b.k === "input" || b.k === "now" || b.k === "cutoff")) ? ["  let value: any;"] : []),
  ];
  const read = (sql: string, binds: string): string => target === "bun-sqlite" ? `db.query(${q(sql)}).all(${binds})` : target === "cloudflare-d1" ? `(await db.prepare(${q(sql)}).bind(${binds}).all()).results` : `await db.query({ text: ${q(sql)}, values: ${binds}${native ? "" : ", types: rawTypes"} })`;
  for (const [index, [name, view]] of Object.entries(plan.views).sort().entries()) {
    const path = `views/${name}`, fn = `view${index}`;
    const modes = lowered.views[name];
    const mode = view.surface === "public" ? "public" : "caller";
    const c = modes?.[mode], trusted = modes?.trusted;
    if (!c || (mode === "caller" && !trusted)) { refuse(path, "Every reachable visibility mode must have canonical lowered SQL."); continue; }
    const keys = Object.hasOwn(viewKeys, name) ? viewKeys[name] : undefined;
    if (!keys || new Set(keys).size !== keys.length) { refuse(path, "Dynamic or repeated View outputs need an explicit generated row contract."); continue; }
    const output: string[] = [], fields: string[] = [];
    const outputNames = new Set<string>();
    for (const [columnIndex, key] of keys.entries()) {
      const field = view.columns && Object.hasOwn(view.columns, key) ? view.columns[key] : undefined;
      const schema = field && plan.schemas[field.schema];
      const type = schema && (schema.fields[field!.field] ?? (["created_at", "updated_at"].includes(field!.field) ? "timestamptz" : undefined));
      const out = native ? key : schema && key === field!.field ? schema.names[field!.field] ?? key : key;
      if (outputNames.has(out)) {
        refuse(path, `Projected View output '${out}' repeats after authored-name mapping.`);
        continue;
      }
      outputNames.add(out);
      let expression = isSqlite ? `row[${q(key)}]` : `decodeField(result.fields[${columnIndex}]!.dataTypeID, row[${q(key)}] as string | null, result.fields[${columnIndex}]!.dataTypeModifier)`;
      if (type === "geo") refuse(path, "Native geo projection is not implemented.");
      if (isSqlite && !native) {
        if (type === "bool") expression = `(value = ${expression}, value == null ? null : value === 1)`;
        else if (type === "timestamptz" || type === "date" || type === "json" || parseNumeric(type ?? "")) {
          const helper = type === "timestamptz" ? "decodeTimestamptz" : type === "date" ? "decodeDate" : type === "json" ? "decodeJson" : "decodeNumeric";
          helpers.add(helper);
          const num = parseNumeric(type ?? "");
          expression = `(value = ${expression}, value == null ? null : ${helper}(value${num ? `, ${num.s}` : ""}))`;
        }
      }
      if (native) {
        const nativeType = !type ? "unknown" : isSqlite
          ? ["bool", "date", "timestamptz"].includes(type) || parseNumeric(type) ? "number" : type === "json" ? "string" : scalarType(type)
          : ["date", "timestamptz"].includes(type) ? "Date | string" : ["integer", "int8"].includes(type) ? "number | string" : scalarType(type);
        output.push(`readonly ${q(out)}: ${nativeType} | null;`);
        continue;
      }
      output.push(`readonly ${q(out)}: ${type ? `${!isSqlite && ["integer", "int8"].includes(type) ? "number | string" : scalarType(type)} | null` : "unknown"};`);
      fields.push(`${out === "__proto__" ? `[${q(out)}]` : q(out)}: ${expression}`);
    }
    declarations.push(`export type View${index}Input = ${queryInputType(view.input ?? { type: "object", additionalProperties: false }, [c, ...(trusted ? [trusted] : [])])};`, `export type View${index}Row = { ${output.join(" ")} };`);
    const validator = native ? "" : validation(`${fn}Input`, view.input, path + "/input");
    const fieldNames = inputFields(view.input, path + "/input");
    declarations.push(`async function ${fn}(db: Database, caller: Caller, raw: View${index}Input): Promise<View${index}Row[]> {`, ...auth(view.requires, path), checkedInput(validator, path, [c, ...(trusted ? [trusted] : [])]), ...context([c, ...(trusted ? [trusted] : [])]), ...(native ? [] : ["  try {"]), `  const ${isSqlite ? "rows" : "result"} = (${mode === "caller" ? `caller.kind === "system" ? ${read(trusted!.sql, bind(trusted!, path, fieldNames))} : ` : ""}${read(c.sql, bind(c, path, fieldNames))})${isSqlite ? " as Record<string, unknown>[]" : ""};`, ...(native ? [`  return ${isSqlite ? "rows" : "result.rows"} as View${index}Row[];`] : [`  return ${isSqlite ? "rows" : "result.rows"}.map(row => ${fields.some(field => field.includes("value =")) ? `{ let value: any; return { ${fields.join(", ")} }; }` : `({ ${fields.join(", ")} })`}) as View${index}Row[];`, `  } catch (error) { throw databaseError(error, "read", ${q(path)}, ${q(isSqlite ? "sqlite" : "postgres")}); }`]), "}");
    views.push(`[${q(name)}]: ${fn}`);
    declarations.push(`export { ${fn} as ${exportName("view", name)} };`);
    entries[`views/${encodeURIComponent(name)}.ts`] = `export { ${exportName("view", name)} as default } from "../generated.js";\nexport type { View${index}Input as Input, View${index}Row as Row } from "../generated.js";\n`;
  }
  for (const [index, [name, procedure]] of Object.entries(plan.procedures).sort().entries()) {
    const path = `procedures/${name}`, fn = `procedure${index}`;
    if (!("sql" in procedure.handler)) { refuse(path, "Ref handlers require an explicit generated application implementation."); continue; }
    const modes = lowered.procedures[name];
    if (!modes?.caller || !modes.trusted) { refuse(path, "Both caller and trusted SQL must be lowered."); continue; }
    if (modes.caller.some(s => s.hooked || s.publish || s.schema && plan.schemas[s.schema]?.publishing)) refuse(path, "Publishing and lifecycle hooks require explicit native execution.");
    declarations.push(`export type Procedure${index}Input = ${queryInputType(procedure.input, [...modes.caller, ...modes.trusted])};`, `export type Procedure${index}Output = ${native ? "{ readonly results: ReadonlyArray<ReadonlyArray<Record<string, unknown>>> }" : typeOf(procedure.output)};`);
    const inputValidator = native ? "" : validation(`${fn}Input`, procedure.input, path + "/input"), outputValidator = native ? "" : validation(`${fn}Output`, procedure.output, path + "/output");
    const fieldNames = inputFields(procedure.input, path + "/input");
    declarations.push(`async function ${fn}(db: Database, caller: Caller, raw: Procedure${index}Input): Promise<Procedure${index}Output> {`, ...auth(procedure.requires, path), checkedInput(inputValidator, path, [...modes.caller, ...modes.trusted]), ...context([...modes.caller, ...modes.trusted]));
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
          lines.push(`    const ${name} = await db.query({ text: ${q(s.sql)}, values: ${binds}${native ? "" : ", types: rawTypes"} });`);
          if (s.kind === "row") lines.push(`    if (${name}.rowCount !== 1) throw new ContractError("CONFLICT", "Expected one affected row.", ${q(path)});`);
          lines.push(native ? `    results.push(${name}.rows);` : `    results.push(${name}.rows.map(row => Object.fromEntries(${name}.fields.map(field => [field.name, decodeField(field.dataTypeID, row[field.name] as string | null, field.dataTypeModifier)]))));`);
        }
      }
      lines.push("    return results;"); return lines;
    };
    const trustedLines = branch(modes.trusted), callerLines = branch(modes.caller);
    const operation = ["  const execute = " + (target === "bun-sqlite" ? "()" : "async ()") + " => {", ...(trustedLines.join() === callerLines.join() ? [] : ['    if (caller.kind === "system") {', ...trustedLines, "    }"]), ...callerLines, "  };" ];
    // One statement is atomic on its own: a row op touches at most one row (one-row INSERT or unique `id =`), so a failed
    // count check after autocommit has changed nothing. Skipping BEGIN/COMMIT saves two PostgreSQL round trips.
    const single = modes.caller.length === 1 && modes.trusted.length === 1;
    declarations.push(...operation);
    const run = single ? "execute()" : "db.transaction(execute)()";
    if (target === "bun-sqlite") declarations.push("  let results: unknown[][];", native ? `  results = ${run};` : `  try { results = ${run}; } catch (error) { throw databaseError(error, "write", ${q(path)}, "sqlite"); }`);
    else if (target === "cloudflare-d1") declarations.push("  let results: unknown[][];", native ? "  results = await execute();" : `  try { results = await execute(); } catch (error) { throw databaseError(error, "write", ${q(path)}, "sqlite"); }`);
    else if (single) declarations.push(
      "  let results: unknown[][];",
      "  try { results = await execute(); } catch (error) {",
      "    if (error instanceof ContractError) throw error;",
      // A server ErrorResponse (SQLSTATE + severity) means the statement rolled back, timeouts included;
      // anything else (socket loss, EPIPE) may have committed.
      '    const server = error as {code?: unknown; severity?: unknown} | null;',
      '    if (typeof server?.code !== "string" || !/^[0-9A-Z]{5}$/.test(server.code) || typeof server.severity !== "string") {',
      `      throw new ContractError("OUTCOME_UNKNOWN", "Statement outcome is unknown; discard this client before further use.", ${q(path)}, { cause: error });`,
      "    }", native ? "    throw error;" : `    throw databaseError(error, "write", ${q(path)}, "postgres");`, "  }");
    else declarations.push(
      native ? '  await db.query("BEGIN ISOLATION LEVEL SERIALIZABLE");' : `  try { await db.query("BEGIN ISOLATION LEVEL SERIALIZABLE"); } catch (error) { throw databaseError(error, "read", ${q(path)}, "postgres"); }`,
      "  let results: unknown[][];",
      "  try { results = await execute(); } catch (error) {",
      '    try { await db.query("ROLLBACK"); } catch (rollbackError) {',
      `      throw new ContractError("OUTCOME_UNKNOWN", "Rollback failed; discard this client before further use.", ${q(path)}, { cause: new AggregateError([error, rollbackError], "Execution and rollback failed.") });`,
      "    }", native ? "    throw error;" : `    throw databaseError(error, "read", ${q(path)}, "postgres");`, "  }",
      '  try { await db.query("COMMIT"); } catch (error) {',
      '    try { await db.query("ROLLBACK"); } catch (rollbackError) {',
      `      throw new ContractError("OUTCOME_UNKNOWN", "Rollback failed; discard this client before further use.", ${q(path)}, { cause: new AggregateError([error, rollbackError], "Commit and rollback failed.") });`,
      "    }", '    const state = (error as {code?: unknown} | null)?.code;',
      '    if (typeof state === "string" && /^[0-9A-Z]{5}$/.test(state) && !/^(08|28|53|57|58|XX)/.test(state)) {',
      native ? "      throw error;" : `      throw databaseError(error, "write", ${q(path)}, "postgres");`, "    }",
      `    throw new ContractError("OUTCOME_UNKNOWN", "Commit outcome is unknown; discard this client before further use.", ${q(path)}, { cause: error });`, "  }");
    declarations.push(native ? `  return { results } as Procedure${index}Output;` : `  return validate(${outputValidator}, { results }, ${q(path + "/output")}, "OUTPUT_VALIDATION_FAILED") as Procedure${index}Output;`, "}");
    procedures.push(`[${q(name)}]: ${fn}`);
    declarations.push(`export { ${fn} as ${exportName("procedure", name)} };`);
    entries[`procedures/${encodeURIComponent(name)}.ts`] = `export { ${exportName("procedure", name)} as default } from "../generated.js";\nexport type { Procedure${index}Input as Input, Procedure${index}Output as Output } from "../generated.js";\n`;
  }
  if (diagnostics.length) return { ok: false, diagnostics };
  const dbType = target === "bun-sqlite" ? 'import type { Database } from "bun:sqlite";' : target === "cloudflare-d1" ? 'import type { D1Database as Database } from "@cloudflare/workers-types";' : `import type { ${target === "bun-postgres" ? "Client, PoolClient" : "Client"} } from "pg";\ntype Database = ${target === "bun-postgres" ? "Client | PoolClient" : "Client"};`;
  return { ok: true, files: { ...entries, "generated.ts": [native ? "// Generated native application SQL. No runtime plan or interpreter." : "// Generated checked SQL. Explicit opt-in; external boundary and legacy codecs.", dbType, ...(native ? [] : ['import * as z from "zod";']), 'import type { Caller } from "@aotter/mantle-next/contracts";', `import { ${[...helpers].sort().join(", ")} } from "@aotter/mantle-next/contracts";`, ...(!isSqlite ? ["// Application/deployment-owned PostgreSQL settings; functions never apply SET or own connections.", 'export const postgresRequirements = { DateStyle: "ISO, YMD", IntervalStyle: "postgres", TimeZone: "UTC", standard_conforming_strings: "on", extra_float_digits: "1", statement_timeout: "10000ms" } as const;', ...(native ? [] : ["const rawTypes = { getTypeParser: (_oid: number, _format?: string) => (text: string) => text };"])] : []), ...declarations, `export const views = { ${views.join(", ")} };`, `export const procedures = { ${procedures.join(", ")} };`, ""].join("\n") } };
}
