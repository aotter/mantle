/** Build-time assembly only. None of these imports enter generated applications. */
import { compilePlan, viewOutputs, type ManifestSourceSet } from "@aotter/mantle/spec";
import * as sqliteCompiler from "@aotter/mantle/d1/compile";
import * as postgresCompiler from "@aotter/mantle/postgres/compile";
import { d1Dialect } from "../../../mantle/dist/d1/dialect.js";
import { postgresDialect } from "../../../mantle/dist/postgres/dialect.js";
import { lowerPlan } from "../../../mantle/dist/core/sql/lowered.js";
import { wireReturning, wireScalars } from "../domain/wireScalars.js";
import { declaredType, outputType } from "../domain/columns.js";
import { nextMode } from "../domain/visibility.js";
import { dialect as sqliteDialect } from "../kernel/dialect/sqlite.js";
import { cast, dialect as postgresDialect_ } from "../kernel/dialect/postgres.js";
import { initialStorageSql as sqliteSchema } from "../../../mantle/dist/d1/storage.js";
import { initialStorageSql as postgresSchema } from "../../../mantle/dist/postgres/storage.js";
import { publishingSql } from "../usecase/publishing.js";
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
    if (sql.split(core).join("").match(new RegExp(`\\$${i + 1}(?!\\d)`))) refusals.push({ code: "GENERATE_UNSUPPORTED", path, message: `Input ${param} must appear only as ${core}. Wrap each occurrence in ${core}.` });
    sql = sql.replaceAll(core, cast(param, type));
  }
  Object.assign(statement, { sql });
}

export async function generateFromSources(request: { readonly target: Target; readonly sources: ManifestSourceSet; /** The application's Better Auth options: their tables join schema.sql. */ readonly auth?: BetterAuthOptions }): Promise<GenerateResult> {
  const postgres = request.target.endsWith("postgres");
  const compiler = postgres ? postgresCompiler : sqliteCompiler;
  const compiled = await compilePlan(request.sources, compiler, "operational");
  if (!compiled.ok) return { ok: false, diagnostics: compiled.diagnostics.map(({ code, path, message }) => ({ code, path, message })) };
  const dialect = postgres ? postgresDialect() : d1Dialect;
  const wire = postgres ? postgresDialect_ : sqliteDialect;
  const viewKeys = Object.fromEntries(Object.entries(compiled.plan.views).map(([name, view]) => {
    const output = viewOutputs(view, compiled.plan.schemas);
    return [name, output.positions?.length === output.keys?.length ? output.keys : undefined];
  }));
  const refusals: GenerateDiagnostic[] = [], orderTypes: Record<string, (string | undefined)[]> = {};
  const { lowered } = lowerPlan(compiled.plan, dialect, {
    mode: nextMode,
    pageQuery(ast, name) {
      const view = compiled.plan.views[name]!;
      const lineage = [...new Set(Object.values(view.columns ?? {}).map(c => c.schema))];
      const schema = lineage.length === 1 ? compiled.plan.schemas[lineage[0]!] : Object.values(compiled.plan.schemas).length === 1 ? Object.values(compiled.plan.schemas)[0] : undefined;
      orderTypes[name] = (ast.SelectStmt.sortClause ?? []).map((s: any) => {
        const fields = s.SortBy.node.ColumnRef?.fields, field = fields?.at(-1)?.String?.sval;
        return schema && field ? declaredType(schema.fields, fields.length === 1 ? view.columns?.[field]?.field ?? field : field) : undefined;
      });
      return { SelectStmt: { ...ast.SelectStmt, limitCount: undefined, limitOption: "LIMIT_OPTION_DEFAULT" } };
    },
    project(ast, kind, name, page) {
      if (kind === "procedure") return wireReturning(ast, compiled.plan.schemas, wire);
      const keys = page ? [...page.names, ...Array.from({length:page.nkeys}, (_,i)=>`_k${i}`)] : viewKeys[name];
      if (!keys) return ast;
      const types = page ? [...page.names.map(key=>outputType(compiled.plan,name,key)), ...(orderTypes[name] ?? [])] : keys.map(key=>outputType(compiled.plan,name,key));
      const projected = wireScalars(ast,keys,types,wire);
      if (typeof projected !== "string") return projected;
      refusals.push({code:"GENERATE_UNSUPPORTED",path:`views/${name}`,message:projected});
      return ast;
    },
  });
  if (postgres) {
    const seen = new Set<LoweredStatement>();
    for (const [kind, all] of [["views", lowered.views], ["procedures", lowered.procedures]] as const) for (const [name, modes] of Object.entries(all)) {
      for (const statement of Object.values(modes).flat() as LoweredStatement[]) if (!seen.has(statement)) { seen.add(statement); castInputs(statement, `${kind}/${name}`, refusals);
        if ("paged" in statement) for (const page of Object.values((statement as import("@aotter/mantle/spec").LoweredView).paged)) {
          const inputPage = { ...statement, sql:page.sql };
          castInputs(inputPage, `${kind}/${name}`, refusals);
          let sql = inputPage.sql;
          for (const [i, source] of page.sources.entries()) {
            const type = "cursor" in source ? orderTypes[name]?.[source.cursor] : undefined;
            if (type === "timestamptz" || type === "date") {
              const n = statement.binds.length + i + 1;
              sql = sql.replace(new RegExp(`\\$${n}(?!\\d)`,"g"),cast(`$${n}`,type));
            }
          }
          Object.assign(page,{sql});
        } }
    }
  }
  const result = generate({ target: request.target, plan: compiled.plan, lowered, viewKeys, newId: coreNewId(dialect, compiled.plan.schemas) });
  if (refusals.length) return { ok: false, diagnostics: [...refusals, ...(!result.ok ? result.diagnostics : [])] };
  if (!result.ok) return result;
  const ddl = [...(postgres ? postgresSchema : sqliteSchema)(compiled.plan.schemas), ...publishingSql(compiled.plan.schemas, !postgres), ...(request.auth ? authSchemaSql(request.auth, postgres ? "postgres" : "sqlite") : [])];
  return { ok: true, files: { ...result.files, "schema.sql": ddl.join(";\n\n") + ";\n" } };
}
