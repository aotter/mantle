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
import * as sqliteDialect from "../kernel/dialect/sqlite.js";
import * as postgresDialect_ from "../kernel/dialect/postgres.js";
import { initialStorageSql as sqliteSchema } from "../../../mantle/dist/d1/storage.js";
import { initialStorageSql as postgresSchema } from "../../../mantle/dist/postgres/storage.js";
import { generate } from "../usecase/generate.js";
import type { GenerateDiagnostic, GenerateResult, Target } from "../domain/model.js";
import type { BetterAuthOptions } from "better-auth/types";
import { authSchemaSql } from "../auth/schema.js";

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
  if (refusals.length) return { ok: false, diagnostics: refusals };
  const result = generate({ target: request.target, plan: compiled.plan, lowered, viewKeys });
  if (!result.ok) return result;
  const ddl = [...(postgres ? postgresSchema : sqliteSchema)(compiled.plan.schemas), ...(request.auth ? authSchemaSql(request.auth, postgres ? "postgres" : "sqlite") : [])];
  return { ok: true, files: { ...result.files, "schema.sql": ddl.join(";\n\n") + ";\n" } };
}
