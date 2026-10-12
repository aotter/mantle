/** Build-time assembly only. None of these imports enter generated applications. */
import { compilePlan, viewOutputs, type ManifestSourceSet } from "@aotter/mantle/spec";
import * as sqliteCompiler from "@aotter/mantle/d1/compile";
import * as postgresCompiler from "@aotter/mantle/postgres/compile";
import { d1Dialect } from "../../../mantle/dist/d1/dialect.js";
import { postgresDialect } from "../../../mantle/dist/postgres/dialect.js";
import { lowerPlan } from "../../../mantle/dist/core/sql/lowered.js";
import { compileProgram } from "../../../mantle/dist/core/sql/compile.js";
import { schemaColumns } from "../../../mantle/dist/core/sql/allowlist.js";
import { wireReturning, wireScalars } from "../domain/wireScalars.js";
import { outputType } from "../domain/columns.js";
import { dialect as sqliteDialect } from "../kernel/dialect/sqlite.js";
import { cast, dialect as postgresDialect_ } from "../kernel/dialect/postgres.js";
import { initialStorageSql as sqliteSchema } from "../../../mantle/dist/d1/storage.js";
import { initialStorageSql as postgresSchema } from "../../../mantle/dist/postgres/storage.js";
import { generate } from "../usecase/generate.js";
import type { LoweredStatement } from "@aotter/mantle/spec";
import type { GenerateDiagnostic, GenerateResult, Target } from "../domain/model.js";
import type { BetterAuthOptions } from "better-auth/types";
import { authSchemaSql } from "../auth/schema.js";

/** Core's own new-entry-id lowering for a dialect, printed once as an SQL expression: the Store's inserts carry the same one its compiled INSERTs do. */
export const coreNewId = (dialect: Pick<typeof d1Dialect, "print" | "lowering">, schemas: Parameters<NonNullable<typeof d1Dialect.print>>[1]): string =>
  dialect.print!({ SelectStmt: { targetList: [{ ResTarget: { val: dialect.lowering.newId() } }], limitOption: "LIMIT_OPTION_DEFAULT", op: "SETOP_NONE" } }, schemas).replace(/^SELECT /, "");

// JSON, date-time and date inputs are driver-ready text. Declaring their parameter as text makes every driver send it verbatim:
// Bun.SQL would JSON-encode a string bound to jsonb a second time, and postgres.js turns one bound to timestamptz or date into a
// JavaScript Date, which loses microseconds. Core prints `CAST($n AS <type>)`; the PostgreSQL dialect spells what replaces it (the
// same cast the Store writes with). Any other use of such a parameter is refused.
const CORE_CAST: Record<string, string> = { json: "jsonb", timestamptz: "timestamptz", date: "date" };
function castInputs(statement: LoweredStatement, path: string, refusals: GenerateDiagnostic[]): void {
  let sql = statement.sql;
  for (const [i, b] of statement.binds.entries()) {
    const type = b.k === "input" ? String(b.type) : "", target = CORE_CAST[type];
    if (!target) continue;
    const param = `$${i + 1}`, core = `CAST(${param} AS ${target})`;
    if (sql.split(core).join("").match(new RegExp(`\\$${i + 1}(?!\\d)`))) refusals.push({ code: "GENERATE_UNSUPPORTED", path, message: `Input ${param} must appear only as ${core}.` });
    sql = sql.replaceAll(core, cast(param, type));
  }
  Object.assign(statement, { sql });
}

export async function generateFromSources(request: { readonly target: Target; readonly sources: ManifestSourceSet; /** The application's Better Auth options: their tables join schema.sql. */ readonly auth?: BetterAuthOptions }): Promise<GenerateResult> {
  const postgres = request.target.endsWith("postgres");
  const compiler = postgres ? postgresCompiler : sqliteCompiler;
  const compiled = await compilePlan(request.sources, compiler);
  if (!compiled.ok) return { ok: false, diagnostics: compiled.diagnostics.map(({ code, path, message }) => ({ code, path, message })) };
  const dialect = postgres ? postgresDialect() : d1Dialect;
  const wire = postgres ? postgresDialect_ : sqliteDialect;
  const { lowered } = lowerPlan(compiled.plan, dialect);
  const viewKeys = Object.fromEntries(Object.entries(compiled.plan.views).map(([name, view]) => {
    const output = viewOutputs(view, compiled.plan.schemas);
    return [name, output.positions?.length === output.keys?.length ? output.keys : undefined];
  }));
  const columns = schemaColumns(compiled.plan.schemas);
  const refusals: GenerateDiagnostic[] = [];
  // Re-print a View through the dialect's own printer when its declared date-time and date outputs are formatted in SQL.
  for (const [name, view] of Object.entries(compiled.plan.views)) {
    const keys = viewKeys[name];
    const types = keys?.map(key => outputType(compiled.plan, name, key)) ?? [];
    for (const [mode, statement] of Object.entries(lowered.views[name] ?? {})) {
      const [raw] = compileProgram(view.stmts, { dialect, schemas: compiled.plan.schemas, columns, inputs: view.inputs, kind: "view", mode: mode as "caller" | "public" | "trusted" });
      const ast = keys ? wireScalars(raw!.ast, keys, types, wire) : raw!.ast;
      if (typeof ast === "string") { refusals.push({ code: "GENERATE_UNSUPPORTED", path: `views/${name}`, message: ast }); continue; }
      if (ast !== raw!.ast) Object.assign(statement!, { sql: dialect.print!(ast, compiled.plan.schemas) });
    }
  }
  for (const [name, procedure] of Object.entries(compiled.plan.procedures)) {
    if (!("sql" in procedure.handler)) continue;
    for (const [mode, statements] of Object.entries(lowered.procedures[name] ?? {})) {
      const compiledStatements = compileProgram(procedure.handler.sql.stmts, { dialect, schemas: compiled.plan.schemas, columns, inputs: procedure.inputs, kind: "procedure", mode: mode as "caller" | "trusted" });
      for (const [i, c] of compiledStatements.entries()) {
        const ast = wireReturning(c.ast, compiled.plan.schemas, wire);
        if (ast !== c.ast) Object.assign(statements![i]!, { sql: dialect.print!(ast, compiled.plan.schemas) });
      }
    }
  }
  if (postgres) {
    const seen = new Set<LoweredStatement>();
    for (const [kind, all] of [["views", lowered.views], ["procedures", lowered.procedures]] as const) for (const [name, modes] of Object.entries(all)) {
      for (const statement of Object.values(modes).flat() as LoweredStatement[]) if (!seen.has(statement)) { seen.add(statement); castInputs(statement, `${kind}/${name}`, refusals); }
    }
  }
  if (refusals.length) return { ok: false, diagnostics: refusals };
  const result = generate({ target: request.target, plan: compiled.plan, lowered, viewKeys, newId: coreNewId(dialect, compiled.plan.schemas) });
  if (!result.ok) return result;
  const ddl = [...(postgres ? postgresSchema : sqliteSchema)(compiled.plan.schemas), ...(request.auth ? authSchemaSql(request.auth, postgres ? "postgres" : "sqlite") : [])];
  return { ok: true, files: { ...result.files, "schema.sql": ddl.join(";\n\n") + ";\n" } };
}
