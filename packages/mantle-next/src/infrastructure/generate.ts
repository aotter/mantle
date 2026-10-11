/** Build-time assembly only. None of these imports enter generated applications. */
import { compilePlan, viewOutputs, type ManifestSourceSet } from "@aotter/mantle/spec";
import * as sqliteCompiler from "@aotter/mantle/d1/compile";
import * as postgresCompiler from "@aotter/mantle/postgres/compile";
import { d1Dialect } from "../../../mantle/dist/d1/dialect.js";
import { postgresDialect } from "../../../mantle/dist/postgres/dialect.js";
import { lowerPlan } from "../../../mantle/dist/core/sql/lowered.js";
import { compileProgram } from "../../../mantle/dist/core/sql/compile.js";
import { schemaColumns } from "../../../mantle/dist/core/sql/allowlist.js";
import { flattenView } from "../domain/flattenView.js";
import { initialStorageSql as sqliteSchema } from "../../../mantle/dist/d1/storage.js";
import { initialStorageSql as postgresSchema } from "../../../mantle/dist/postgres/storage.js";
import { generate } from "../usecase/generate.js";
import type { GenerateResult, Target } from "../domain/model.js";

export async function generateFromSources(request: { readonly target: Target; readonly sources: ManifestSourceSet; readonly checked?: boolean }): Promise<GenerateResult> {
  const postgres = request.target.endsWith("postgres");
  const compiled = await compilePlan(request.sources, postgres ? postgresCompiler : sqliteCompiler);
  if (!compiled.ok) return { ok: false, diagnostics: compiled.diagnostics.map(({ code, path, message }) => ({ code, path, message })) };
  const dialect = postgres ? postgresDialect() : d1Dialect;
  const { lowered } = lowerPlan(compiled.plan, dialect);
  if (postgres) {
    const columns = schemaColumns(compiled.plan.schemas);
    for (const [name, view] of Object.entries(compiled.plan.views)) {
      for (const [mode, statement] of Object.entries(lowered.views[name] ?? {})) {
        const [raw] = compileProgram(view.stmts, { dialect, schemas: compiled.plan.schemas, columns, inputs: view.inputs, kind: "view", mode: mode as "caller" | "public" | "trusted" });
        const ast = flattenView(raw!.ast, compiled.plan.schemas);
        if (ast !== raw!.ast) Object.assign(statement!, { sql: dialect.print!(ast, compiled.plan.schemas) });
      }
    }
  }
  const viewKeys = Object.fromEntries(Object.entries(compiled.plan.views).map(([name, view]) => {
    const output = viewOutputs(view, compiled.plan.schemas);
    return [name, output.positions?.length === output.keys?.length ? output.keys : undefined];
  }));
  const result = generate({ target: request.target, plan: compiled.plan, lowered, viewKeys, checked: request.checked });
  if (!result.ok) return result;
  const ddl = (postgres ? postgresSchema : sqliteSchema)(compiled.plan.schemas);
  return { ok: true, files: { ...result.files, "schema.sql": ddl.join(";\n\n") + ";\n" } };
}
