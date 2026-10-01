/**
 * `compilePlan` (ADR-0034 decision 3): manifest sources in, the plan's IR out. Every View `sql` and
 * every Procedure `handler.sql` goes through `compileSql` with a context built from the Schema
 * declarations. Like `compileSql`, only the CLI and the plugin's helper scripts import this.
 */
import { validateDiagnostic, type Diagnostic, type SourceLocation } from "../../kernel/diagnostic.js";
import { enumOptions, type JsonSchema, type ProcedureManifest } from "../../domain/model/ManifestGrammar.js";
import { NATIVE_OUTPUT_TYPES, RUNTIME_PLAN_VERSION, type PlanProcedure, type PlanSchema, type PlanTrigger, type PlanView, type RuntimePlan } from "../../domain/model/RuntimePlan.js";
import { classify, pinnedTarget } from "../../domain/service/SqlClassify.js";
import { planFingerprint } from "../../domain/service/PlanFingerprint.js";
import type { SqlContext, SqlDiagnostic, SqlNode, SqlPlan } from "../../domain/model/SqlIr.js";
import { parseManifestSources, type ManifestSourceSet } from "../../domain/service/ManifestParser.js";
import { linkManifestSet, type LinkedManifestSet } from "../../domain/service/ManifestLinker.js";
import * as d1 from "../../../d1/compile/index.js";
import { compileSql, type SqlDialect } from "./compileSql.js";

export type CompilePlanResult =
  | { readonly ok: true; readonly plan: RuntimePlan }
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };

/** JSON Schema property to Mantle type. `numeric(p,s)` and `geo` have no manifest spelling yet. */
function mantleType(p: JsonSchema): string {
  const t = [p.type].flat().find((x) => x !== "null");
  if (p.format === "geo") return "geo";
  if (!t && enumOptions(p)) return "text"; // a string enum or a oneOf of string consts
  if (t === "string") return p.format === "date-time" ? "timestamptz" : p.format === "date" ? "date" : "text";
  return ({ integer: "integer", number: "real", boolean: "bool" } as Record<string, string>)[String(t)] ?? "json";
}

/** The physical columns of the native entry fields an index may name (SchemaIndexChecker); a declared field is its lower-cased name. */
const NATIVE_COLUMNS: Readonly<Record<string, string>> = { id: "id", status: "status", version: "version", createdAt: "created_at", updatedAt: "updated_at", authorId: "author_id" };
const indexColumn = (field: string) => (Object.hasOwn(NATIVE_COLUMNS, field) ? NATIVE_COLUMNS[field]! : field.toLowerCase());

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

/** What `SELECT *` expands to (the policy's `starCols`): the declared fields but the scope field, a geo field as its two columns. */
const starCols = (s: PlanSchema) => Object.entries(s.fields).filter(([f]) => f !== s.scope).flatMap(([f, t]) => (t === "geo" ? [`${f}_lat`, `${f}_lng`] : [f]));

/**
 * A View's outputs, read off its compiled SELECT: `keys` are the row's keys in order (undefined when an output has no name or
 * a `*` reads a subquery or `json_each`), `columns` the outputs that are a Schema field read unchanged.
 */
export function viewOutputs(view: SqlPlan, schemas: Readonly<Record<string, PlanSchema>>): { keys?: string[]; columns: Record<string, { schema: string; field: string }> } {
  const columns: Record<string, { schema: string; field: string }> = {};
  const sel = view.stmts[0]?.SelectStmt;
  if (!sel?.targetList) return { columns };
  const rels = new Map<string, string | undefined>();
  const walk = (n: SqlNode): void => {
    if (n.JoinExpr) return (walk(n.JoinExpr.larg), walk(n.JoinExpr.rarg));
    const v = n.RangeVar;
    if (v) rels.set(v.alias?.aliasname ?? v.relname, v.mantle === "table" && schemas[String(v.relname).toLowerCase()] ? String(v.relname).toLowerCase() : undefined);
    else rels.set((n.RangeSubselect ?? n.RangeFunction)?.alias?.aliasname ?? "", undefined);
  };
  for (const f of sel.fromClause ?? []) walk(f);
  const typeOf = (schema: string, col: string) => schemas[schema]!.fields[col] ?? (Object.hasOwn(NATIVE_OUTPUT_TYPES, col) ? NATIVE_OUTPUT_TYPES[col] : undefined);
  const field = (schema: string | undefined, col: string) => (schema && typeOf(schema, col) && typeOf(schema, col) !== "geo" ? { schema, field: col } : undefined);
  let keys: string[] | undefined = [];
  for (const { ResTarget: r } of sel.targetList) {
    // sum, min and max of one column keep its type (a sum of money is money); a count or an average does not
    const agg = r.val?.FuncCall;
    const fn = agg?.funcname?.at(-1)?.String?.sval;
    const arg = agg && !agg.over && !agg.agg_distinct && agg.args?.length === 1 ? agg.args[0].ColumnRef?.fields : undefined;
    const refs = r.val?.ColumnRef?.fields ?? (r.name && arg && ["sum", "min", "max"].includes(fn) ? arg : undefined);
    if (!r.name && refs?.at(-1)?.A_Star) {
      const from = refs.length > 1 ? [rels.get(refs[0].String.sval)] : [...rels.values()];
      if (from.some((s) => !s)) { keys = undefined; continue; }
      for (const s of from as string[]) for (const c of starCols(schemas[s]!)) { keys?.push(c); const f = field(s, c); if (f) columns[c] = f; }
      continue;
    }
    const col: string | undefined = refs?.at(-1)?.String?.sval;
    const name: string | undefined = r.name ?? col;
    if (!name) { keys = undefined; continue; }
    keys?.push(name);
    const rel = refs?.length === 2 ? rels.get(refs[0].String.sval) : refs?.length === 1 && rels.size === 1 ? [...rels.values()][0] : undefined;
    const f = col ? field(rel, col) : undefined;
    if (f && (fn !== "sum" || r.val?.ColumnRef || ["integer", "real"].includes(typeOf(f.schema, f.field)!) || typeOf(f.schema, f.field)!.startsWith("numeric("))) columns[name] = f;
  }
  return { ...(keys ? { keys: [...new Set(keys)] } : {}), columns };
}

/** Compile a linked manifest set to the sealed plan. Every refusal is reported, one per SQL source. */
export async function compileLinkedPlan(linked: LinkedManifestSet, dialect: SqlDialect = d1): Promise<CompilePlanResult> {
  const schemas: Record<string, PlanSchema> = {};
  for (const { manifest: m } of linked.schemas) {
    const scope = Object.keys(m.spec.scope ?? {})[0]?.toLowerCase();
    const props = m.spec.schema.properties ?? {};
    const lower = (xs: readonly string[]) => xs.map((x) => x.toLowerCase());
    schemas[m.metadata.name.toLowerCase()] = {
      name: m.metadata.name,
      title: m.spec.title,
      ...(m.spec.description ? { description: m.spec.description } : {}),
      ...(m.spec.uiSchema ? { uiSchema: m.spec.uiSchema } : {}),
      ...(m.spec.localized ? { localized: true } : {}),
      ...(scope ? { scope } : {}),
      ...(m.spec.ttl ? { ttl: m.spec.ttl.field.toLowerCase(), ttlSeconds: m.spec.ttl.expireAfterSeconds } : {}),
      publishing: m.spec.lifecycle === "publishing",
      schema: m.spec.schema,
      ...(m.spec.translates ? { translates: { parent: m.spec.translates.parent, on: m.spec.translates.on } } : {}),
      fields: typesOf(m.spec.schema),
      names: Object.fromEntries(Object.keys(props).map((n) => [n.toLowerCase(), n])),
      ...(m.spec.searchableFields?.length ? { search: lower(m.spec.searchableFields) } : {}),
      ...(m.spec.uniqueIndexes?.length ? { unique: m.spec.uniqueIndexes.map(lower) } : {}),
      ...(m.spec.indexes?.length ? { indexes: m.spec.indexes.map((cols) => cols.map(indexColumn)) } : {}),
    };
  }
  const diagnostics: Diagnostic[] = [];
  const ctxOf = (kind: SqlContext["kind"], input: JsonSchema | undefined, isPublic = false): SqlContext => ({ schemas, inputs: typesOf(input), kind, public: isPublic });
  const compile = async (kind: SqlContext["kind"], sql: string, input: JsonSchema | undefined, source: SourceLocation, pointer: string, isPublic = false) => {
    const res = await compileSql(sql, ctxOf(kind, input, isPublic), dialect);
    if (res.ok) return res.plan;
    diagnostics.push(toDiagnostic(res.diagnostic, source, pointer));
  };

  // a check is compiled as the WHERE of a read of its own Schema, so its columns resolve against that Schema
  for (const { manifest: m, source } of linked.schemas) {
    const name = m.metadata.name.toLowerCase();
    const checks: SqlNode[] = [];
    for (const [i, text] of (m.spec.checks ?? []).entries()) {
      const pointer = `/spec/checks/${i}`;
      const res = await compileSql(`SELECT 1 FROM "${name.replace(/"/g, '""')}" WHERE ${text}`, { schemas, inputs: {}, kind: "view" }, dialect);
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
    const outputs = plan ? viewOutputs(plan, schemas) : undefined;
    const columns = outputs?.columns ?? {};
    // searchFields and filterFields become conditions on the View's outputs (ADR-0032 decision 5), so each must name one
    const list = (v.spec.uiSchema?.["list"] ?? {}) as Record<string, string[] | undefined>;
    for (const key of ["searchFields", "filterFields"] as const) for (const [i, f] of (list[key] ?? []).entries()) {
      if (!outputs?.keys || outputs.keys.some((k) => k === f || k === f.toLowerCase())) continue;
      diagnostics.push(validateDiagnostic({ code: "VIEW_UI_INVALID", severity: "error", path: `${source.sourceId}#/${source.documentIndex}/spec/uiSchema/list/${key}/${i}`, source: { ...source, path: `/spec/uiSchema/list/${key}/${i}` }, value: f, expected: `one of the View's outputs: ${outputs.keys.join(", ")}`, message: `View '${v.metadata.name}' uiSchema.list.${key} names '${f}', which the View's SELECT does not output.` }));
    }
    // a column is read off the row by its exact key: a field read carries the declared name, anything else the name SQL gave it
    const wire = (outputs?.keys ?? []).map((k) => (columns[k]?.field === k ? schemas[columns[k]!.schema]!.names?.[k] ?? k : k));
    for (const [i, f] of (list["columns"] ?? []).entries()) {
      if (!outputs?.keys || wire.includes(f)) continue;
      const folded = wire.find((k) => k.toLowerCase() === f.toLowerCase());
      diagnostics.push(validateDiagnostic({ code: "VIEW_UI_INVALID", severity: "error", path: `${source.sourceId}#/${source.documentIndex}/spec/uiSchema/list/columns/${i}`, source: { ...source, path: `/spec/uiSchema/list/columns/${i}` }, value: f, expected: `one of the View's outputs: ${wire.join(", ")}`,
        message: folded ? `View '${v.metadata.name}' uiSchema.list.columns names '${f}', but the row carries '${folded}': an unquoted alias folds to lower case, so write AS "${f}".` : `View '${v.metadata.name}' uiSchema.list.columns names '${f}', which the View's SELECT does not output.` }));
    }
    if (plan) views[v.metadata.name] = { ...plan, ...(Object.keys(columns).length ? { columns } : {}), ...(v.spec.title ? { title: v.spec.title } : {}), ...(v.spec.description ? { description: v.spec.description } : {}), ...(v.spec.uiSchema ? { uiSchema: v.spec.uiSchema } : {}), inputs: typesOf(v.spec.input), ...(v.spec.input ? { input: v.spec.input } : {}), source: v.spec.sql, surface: v.spec.surface, ...(v.spec.requires ? { requires: v.spec.requires } : {}) };
  }
  const procedures: Record<string, PlanProcedure> = {};
  const declaredSchema = new Map(linked.schemas.map((x) => [x.manifest.metadata.name.toLowerCase(), x.manifest.metadata.name]));
  /** ADR-0032 decision 2: a program with exactly one row op that pins `id` to an input gets that target, by the rule Store classifies with. */
  const inferTarget = (p: ProcedureManifest, stmts: readonly SqlNode[]) => {
    const rows = stmts.filter((s) => classify(s) === "row");
    const pinned = rows.length === 1 ? pinnedTarget(rows[0]!) : undefined;
    const props = Object.keys(p.spec.input.properties ?? {});
    const declared = (lower: string) => props.find((k) => k.toLowerCase() === lower);
    const id = pinned && declared(pinned.id);
    const schema = pinned && declaredSchema.get(pinned.schema.toLowerCase());
    // the same shape an explicit target must have: a required string id (PROCEDURE_TARGET_INVALID otherwise)
    if (!pinned || !id || !schema || !p.spec.input.required?.includes(id) || p.spec.input.properties![id]!.type !== "string") return undefined;
    const version = pinned.version && declared(pinned.version);
    // the same shapes an explicit target must have: a numeric version, or none at all
    if (version && !["number", "integer"].includes(String(p.spec.input.properties![version]!.type))) return undefined;
    return { schema, id, ...(version ? { version } : {}) };
  };
  for (const { manifest: p, source } of linked.procedures) {
    const common = { ...(p.spec.title ? { title: p.spec.title } : {}), ...(p.spec.description ? { description: p.spec.description } : {}), ...(p.spec.uiSchema ? { uiSchema: p.spec.uiSchema } : {}), input: p.spec.input, output: p.spec.output, inputs: typesOf(p.spec.input), ...(p.spec.requires ? { requires: p.spec.requires } : {}), ...(p.spec.mcp ? { mcp: p.spec.mcp } : {}) };
    if ("ref" in p.spec.handler) { procedures[p.metadata.name] = { ...common, ...(p.spec.target ? { target: p.spec.target } : {}), handler: { ref: p.spec.handler.ref } }; continue; }
    const plan = await compile("procedure", p.spec.handler.sql, p.spec.input, source, "/spec/handler/sql");
    const target = p.spec.target ?? (plan ? inferTarget(p, plan.stmts) : undefined);
    if (plan) procedures[p.metadata.name] = { ...common, ...(target ? { target } : {}), handler: { sql: plan, source: p.spec.handler.sql } };
  }
  if (diagnostics.length) return { ok: false, diagnostics };
  const triggers: Record<string, PlanTrigger> = Object.fromEntries(linked.triggers.map(({ manifest: t }) => [t.metadata.name, { source: t.spec.source, procedure: t.spec.target.procedure }]));
  const sealed = { version: RUNTIME_PLAN_VERSION, dialect: { name: dialect.name, version: dialect.version }, schemas, views, procedures, triggers };
  return { ok: true, plan: { ...sealed, fingerprint: await planFingerprint(sealed) } };
}

/** The plugin's contract: parse, link and compile manifest sources in one call. */
export async function compilePlan(sources: ManifestSourceSet, dialect: SqlDialect = d1): Promise<CompilePlanResult> {
  const parsed = parseManifestSources(sources);
  if (!parsed.ok) return parsed;
  const linked = linkManifestSet(parsed.value);
  return linked.ok ? compileLinkedPlan(linked.value, dialect) : linked;
}
