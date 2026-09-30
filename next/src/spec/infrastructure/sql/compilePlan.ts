/**
 * `compilePlan` (ADR-0034 decision 3): manifest sources in, the plan's IR out. Every View `sql` and
 * every Procedure `handler.sql` goes through `compileSql` with a context built from the Schema
 * declarations. Like `compileSql`, only the CLI and the plugin's helper scripts import this.
 */
import { validateDiagnostic, type Diagnostic, type SourceLocation } from "../../kernel/diagnostic.js";
import type { JsonSchema } from "../../domain/model/ManifestGrammar.js";
import { RUNTIME_PLAN_VERSION, type PlanProcedure, type PlanSchema, type PlanTrigger, type PlanView, type RuntimePlan } from "../../domain/model/RuntimePlan.js";
import { planFingerprint } from "../../domain/service/PlanFingerprint.js";
import type { SqlContext, SqlDiagnostic, SqlNode, SqlPlan } from "../../domain/model/SqlIr.js";
import { parseManifestSources, type ManifestSourceSet } from "../../domain/service/ManifestParser.js";
import { linkManifestSet, type LinkedManifestSet } from "../../domain/service/ManifestLinker.js";
import { compileSql } from "./compileSql.js";

export type CompilePlanResult =
  | { readonly ok: true; readonly plan: RuntimePlan }
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };

/** JSON Schema property to Mantle type. `numeric(p,s)` and `geo` have no manifest spelling yet. */
function mantleType(p: JsonSchema): string {
  const t = [p.type].flat().find((x) => x !== "null");
  if (p.format === "geo") return "geo";
  if (t === "string") return p.format === "date-time" ? "timestamptz" : p.format === "date" ? "date" : "text";
  return ({ integer: "integer", number: "real", boolean: "bool" } as Record<string, string>)[String(t)] ?? "json";
}

/** SQL folds unquoted identifiers to lower case, so the context is keyed the way the parser reads names. */
function typesOf(schema: JsonSchema | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(schema?.properties ?? {}).map(([name, p]) => [name.toLowerCase(), mantleType(p)]));
}

function toDiagnostic(d: SqlDiagnostic, source: SourceLocation, pointer: string): Diagnostic {
  const at = d.line === undefined ? undefined : { line: d.line, column: d.column, ...(d.token ? { token: d.token } : {}) };
  return validateDiagnostic({
    code: d.code,
    severity: "error",
    path: `${source.sourceId}#/${source.documentIndex}${pointer}`,
    source: { ...source, path: pointer },
    ...(at ? { value: at } : {}),
    message: at ? `SQL ${at.line}:${at.column}${at.token ? ` near ${JSON.stringify(at.token)}` : ""}: ${d.message}` : d.message,
  });
}

/** Compile a linked manifest set to the sealed plan. Every refusal is reported, one per SQL source. */
export async function compileLinkedPlan(linked: LinkedManifestSet): Promise<CompilePlanResult> {
  const schemas: Record<string, PlanSchema> = {};
  for (const { manifest: m } of linked.schemas) {
    const scope = Object.keys(m.spec.scope ?? {})[0]?.toLowerCase();
    const props = m.spec.schema.properties ?? {};
    const lower = (xs: readonly string[]) => xs.map((x) => x.toLowerCase());
    schemas[m.metadata.name.toLowerCase()] = {
      ...(scope ? { scope } : {}),
      ...(m.spec.ttl ? { ttl: m.spec.ttl.field.toLowerCase() } : {}),
      publishing: m.spec.lifecycle === "publishing",
      schema: m.spec.schema,
      fields: typesOf(m.spec.schema),
      names: Object.fromEntries(Object.keys(props).map((n) => [n.toLowerCase(), n])),
      ...(m.spec.searchableFields?.length ? { search: lower(m.spec.searchableFields) } : {}),
      ...(m.spec.uniqueIndexes?.length ? { unique: m.spec.uniqueIndexes.map(lower) } : {}),
      ...(m.spec.indexes?.length ? { indexes: m.spec.indexes.map(lower) } : {}),
    };
  }
  const diagnostics: Diagnostic[] = [];
  const ctxOf = (kind: SqlContext["kind"], input: JsonSchema | undefined, isPublic = false): SqlContext => ({ schemas, inputs: typesOf(input), kind, public: isPublic });
  const compile = async (kind: SqlContext["kind"], sql: string, input: JsonSchema | undefined, source: SourceLocation, pointer: string, isPublic = false) => {
    const res = await compileSql(sql, ctxOf(kind, input, isPublic));
    if (res.ok) return res.plan;
    diagnostics.push(toDiagnostic(res.diagnostic, source, pointer));
  };

  // a check is compiled as the WHERE of a read of its own Schema, so its columns resolve against that Schema
  for (const { manifest: m, source } of linked.schemas) {
    const name = m.metadata.name.toLowerCase();
    const checks: SqlNode[] = [];
    for (const [i, text] of (m.spec.checks ?? []).entries()) {
      const pointer = `/spec/checks/${i}`;
      const res = await compileSql(`SELECT 1 FROM ${name} WHERE ${text}`, { schemas, inputs: {}, kind: "view" });
      if (!res.ok) { diagnostics.push(toDiagnostic(res.diagnostic, source, pointer)); continue; }
      const where: SqlNode | undefined = res.plan.stmts[0]?.SelectStmt?.whereClause;
      if (!where || JSON.stringify(where).includes('"SubLink"')) {
        diagnostics.push(toDiagnostic({ code: "SQL_SHAPE", message: "a check reads only the row's own columns: no subquery" }, source, pointer));
        continue;
      }
      checks.push(where);
    }
    if (checks.length) schemas[name] = { ...schemas[name]!, checks };
  }

  const views: Record<string, PlanView> = {};
  for (const { manifest: v, source } of linked.views) {
    const plan = await compile("view", v.spec.sql, v.spec.input, source, "/spec/sql", v.spec.surface === "public");
    if (plan) views[v.metadata.name] = { ...plan, inputs: typesOf(v.spec.input), ...(v.spec.input ? { input: v.spec.input } : {}), surface: v.spec.surface, ...(v.spec.requires ? { requires: v.spec.requires } : {}) };
  }
  const procedures: Record<string, PlanProcedure> = {};
  for (const { manifest: p, source } of linked.procedures) {
    const common = { input: p.spec.input, output: p.spec.output, inputs: typesOf(p.spec.input), ...(p.spec.requires ? { requires: p.spec.requires } : {}), ...(p.spec.target ? { target: p.spec.target } : {}), ...(p.spec.mcp ? { mcp: p.spec.mcp } : {}) };
    if ("ref" in p.spec.handler) { procedures[p.metadata.name] = { ...common, handler: { ref: p.spec.handler.ref } }; continue; }
    const plan = await compile("procedure", p.spec.handler.sql, p.spec.input, source, "/spec/handler/sql");
    if (plan) procedures[p.metadata.name] = { ...common, handler: { sql: plan } };
  }
  if (diagnostics.length) return { ok: false, diagnostics };
  const triggers: Record<string, PlanTrigger> = Object.fromEntries(linked.triggers.map(({ manifest: t }) => [t.metadata.name, { source: t.spec.source, procedure: t.spec.target.procedure }]));
  const sealed = { version: RUNTIME_PLAN_VERSION, schemas, views, procedures, triggers };
  return { ok: true, plan: { ...sealed, fingerprint: await planFingerprint(sealed) } };
}

/** The plugin's contract: parse, link and compile manifest sources in one call. */
export async function compilePlan(sources: ManifestSourceSet): Promise<CompilePlanResult> {
  const parsed = parseManifestSources(sources);
  if (!parsed.ok) return parsed;
  const linked = linkManifestSet(parsed.value);
  return linked.ok ? compileLinkedPlan(linked.value) : linked;
}
