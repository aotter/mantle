/**
 * `compilePlan` (ADR-0034 decision 3): manifest sources in, the plan's IR out. Every View `sql` and
 * every Procedure `handler.sql` goes through `compileSql` with a context built from the Schema
 * declarations. Like `compileSql`, only the CLI and the plugin's helper scripts import this.
 */
import { validateDiagnostic, type Diagnostic, type SourceLocation } from "../../kernel/diagnostic.js";
import type { JsonSchema } from "../../domain/model/ManifestGrammar.js";
import type { SqlContext, SqlDiagnostic, SqlPlan } from "../../domain/model/SqlIr.js";
import { parseManifestSources, type ManifestSourceSet } from "../../domain/service/ManifestParser.js";
import { linkManifestSet, type LinkedManifestSet } from "../../domain/service/ManifestLinker.js";
import { compileSql } from "./compileSql.js";

/** The IR of every View and inline Procedure, by manifest name. */
export interface CompiledPlan {
  readonly views: Readonly<Record<string, SqlPlan>>;
  readonly procedures: Readonly<Record<string, SqlPlan>>;
}

export type CompilePlanResult =
  | { readonly ok: true; readonly plan: CompiledPlan }
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };

/** JSON Schema property to Mantle type. `numeric(p,s)` and `geo` have no manifest spelling yet. */
function mantleType(p: JsonSchema): string {
  const t = [p.type].flat().find((x) => x !== "null");
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

/** Compile the SQL of a linked manifest set. Every refusal is reported, one per SQL source. */
export async function compileLinkedPlan(linked: LinkedManifestSet): Promise<CompilePlanResult> {
  const schemas: Record<string, SqlContext["schemas"][string]> = {};
  for (const { manifest: m } of linked.schemas) {
    const scope = Object.keys(m.spec.scope ?? {})[0]?.toLowerCase();
    schemas[m.metadata.name.toLowerCase()] = {
      ...(scope ? { scope } : {}),
      ...(m.spec.ttl ? { ttl: m.spec.ttl.field.toLowerCase() } : {}),
      publishing: m.spec.lifecycle === "publishing",
      fields: typesOf(m.spec.schema),
    };
  }
  const diagnostics: Diagnostic[] = [];
  const views: Record<string, SqlPlan> = {};
  const procedures: Record<string, SqlPlan> = {};
  const compile = async (kind: SqlContext["kind"], sql: string, input: JsonSchema | undefined, source: SourceLocation, pointer: string, isPublic = false) => {
    const res = await compileSql(sql, { schemas, inputs: typesOf(input), kind, public: isPublic });
    if (res.ok) return res.plan;
    diagnostics.push(toDiagnostic(res.diagnostic, source, pointer));
  };
  for (const { manifest: v, source } of linked.views) {
    const plan = await compile("view", v.spec.sql, v.spec.input, source, "/spec/sql", v.spec.surface === "public");
    if (plan) views[v.metadata.name] = plan;
  }
  for (const { manifest: p, source } of linked.procedures) {
    if (!("sql" in p.spec.handler)) continue;
    const plan = await compile("procedure", p.spec.handler.sql, p.spec.input, source, "/spec/handler/sql");
    if (plan) procedures[p.metadata.name] = plan;
  }
  return diagnostics.length ? { ok: false, diagnostics } : { ok: true, plan: { views, procedures } };
}

/** The plugin's contract: parse, link and compile manifest sources in one call. */
export async function compilePlan(sources: ManifestSourceSet): Promise<CompilePlanResult> {
  const parsed = parseManifestSources(sources);
  if (!parsed.ok) return parsed;
  const linked = linkManifestSet(parsed.value);
  return linked.ok ? compileLinkedPlan(linked.value) : linked;
}
