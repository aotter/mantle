/** Build-time assembly only. None of these imports enter generated applications. */
import { compilePlan, viewOutputs, type ManifestSourceSet } from "@aotter/mantle/spec";
import * as sqliteCompiler from "@aotter/mantle/d1/compile";
import * as postgresCompiler from "@aotter/mantle/postgres/compile";
import { d1Dialect } from "../../../mantle/dist/d1/dialect.js";
import { postgresDialect } from "../../../mantle/dist/postgres/dialect.js";
import { lowerPlan } from "../../../mantle/dist/core/sql/lowered.js";
import { initialStorageSql as sqliteSchema } from "../../../mantle/dist/d1/storage.js";
import { initialStorageSql as postgresSchema } from "../../../mantle/dist/postgres/storage.js";
import { generate } from "../usecase/generate.js";
import type { GenerateResult, Target } from "../domain/model.js";

export async function generateFromSources(request: { readonly target: Target; readonly sources: ManifestSourceSet }): Promise<GenerateResult> {
  const postgres = request.target.endsWith("postgres");
  const compiled = await compilePlan(request.sources, postgres ? postgresCompiler : sqliteCompiler);
  if (!compiled.ok) return { ok: false, diagnostics: compiled.diagnostics.map(({ code, path, message }) => ({ code, path, message })) };
  const { lowered } = lowerPlan(compiled.plan, postgres ? postgresDialect() : d1Dialect);
  const viewKeys = Object.fromEntries(Object.entries(compiled.plan.views).map(([name, view]) => {
    const output = viewOutputs(view, compiled.plan.schemas);
    return [name, output.positions?.length === output.keys?.length ? output.keys : undefined];
  }));
  const result = generate({ target: request.target, plan: compiled.plan, lowered, viewKeys });
  if (!result.ok) return result;
  const ddl = (postgres ? postgresSchema : sqliteSchema)(compiled.plan.schemas);
  return { ok: true, files: { ...result.files, "schema.sql": ddl.join(";\n\n") + ";\n" } };
}
