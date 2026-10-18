/**
 * `compilePlan` (ADR-0034 decision 3): manifest sources in, the plan's IR out. Every View `sql` and
 * every Procedure `handler.sql` goes through `compileSql` with a context built from the Schema
 * declarations. Like `compileSql`, only the CLI and the plugin's helper scripts import this.
 */
import { validateDiagnostic, type Diagnostic, type SourceLocation } from "../../kernel/diagnostic.js";
import type { JsonSchema, ProcedureManifest } from "../../domain/model/ManifestGrammar.js";
import { NATIVE_OUTPUT_TYPES, RUNTIME_PLAN_VERSION, type PlanProcedure, type PlanSchema, type PlanTrigger, type PlanView, type RuntimePlan } from "../../domain/model/RuntimePlan.js";
import { classify, pinnedTarget } from "../../domain/service/SqlClassify.js";
import { planFingerprint } from "../../domain/service/PlanFingerprint.js";
import { fieldTypes as typesOf } from "../../domain/service/SqlTypes.js";
import { NATIVE_COLUMNS, viewCacheProblem, checkShapeProblem, storageColumnClash, storageColumns, type SqlContext, type SqlDiagnostic, type SqlNode, type SqlPlan } from "../../domain/model/SqlIr.js";
import { parseManifestSources, type ManifestSourceSet } from "../../domain/service/ManifestParser.js";
import { linkManifestSet, type LinkedManifestSet } from "../../domain/service/ManifestLinker.js";
import * as d1 from "../../../d1/compile/index.js";
import { compileSql, relationNames, type SqlDialect } from "./compileSql.js";
import { parseRowTemplate, type UserFieldSpec } from "../../domain/model/UserFields.js";
import { registerUserField } from "../../domain/service/UserReferences.js";
import { SqlRefusal } from "../../domain/service/SqlRefusal.js";
import { protectedColumns } from "../../domain/service/SqlRowPolicy.js";

export type CompilePlanResult =
  | { readonly ok: true; readonly plan: RuntimePlan }
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };

/** The physical columns of the native entry fields an index may name (SchemaIndexChecker); a declared field is its lower-cased name. */
const indexColumn = (field: string) => (Object.hasOwn(NATIVE_COLUMNS, field) ? NATIVE_COLUMNS[field]! : field.toLowerCase());

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

type Columns = Record<string, { schema: string; field: string }>;

/**
 * A View's outputs, read off its compiled SELECT: `keys` are the row's keys in order (undefined when an output has no name or
 * a `*` reads a subquery or `json_each`), `columns` the outputs that are a Schema field read unchanged.
 * `includeGeo` exposes logical geo columns to generators that must refuse them before executing native SQL.
 * `includeAggregates=false` limits selected transport metadata to unchanged column projections.
 */
export function viewOutputs(view: SqlPlan, schemas: Readonly<Record<string, PlanSchema>>, ctes: ReadonlyMap<string, Columns> = new Map(), includeGeo = false, includeAggregates = true): { keys?: string[]; columns: Columns; positions?: string[] } {
  const columns: Columns = Object.create(null);
  const sel = view.stmts[0]?.SelectStmt;
  if (!sel?.targetList) return { columns };
  const outputs = (stmt: SqlNode, scope: ReadonlyMap<string, Columns>) => viewOutputs({ grammar: view.grammar, stmts: [stmt] }, schemas, scope, includeGeo, includeAggregates);
  // a CTE's outputs, like a FROM subquery's, keep the Schema field they read unchanged; a body sees its earlier siblings,
  // and under RECURSIVE every sibling (one not yet read is untyped)
  const scope = new Map(ctes);
  if (sel.withClause?.recursive) for (const { CommonTableExpr: c } of sel.withClause.ctes) scope.set(c.ctename, Object.create(null));
  for (const { CommonTableExpr: c } of sel.withClause?.ctes ?? []) {
    const body = outputs(c.ctequery, scope);
    const renamed: string[] | undefined = c.aliascolnames?.map((x: SqlNode) => x.String.sval);
    // a rename names the body's outputs by position, repeated names included
    scope.set(c.ctename, renamed ? Object.fromEntries(renamed.flatMap((n, i) => (body.columns[body.positions?.[i] ?? ""] ? [[n, body.columns[body.positions![i]!]!]] : []))) : body.columns);
  }
  const rels = new Map<string, string | undefined>();
  // a FROM subquery's outputs that read a Schema field unchanged keep its type (including a named View dependency's)
  const subs = new Map<string, Columns>();
  const walk = (n: SqlNode): void => {
    if (n.JoinExpr) return (walk(n.JoinExpr.larg), walk(n.JoinExpr.rarg));
    const v = n.RangeVar;
    if (v) rels.set(v.alias?.aliasname ?? v.relname, v.mantle === "table" && schemas[String(v.relname).toLowerCase()] ? String(v.relname).toLowerCase() : undefined);
    else rels.set((n.RangeSubselect ?? n.RangeFunction)?.alias?.aliasname ?? "", undefined);
    if (v?.mantle === "cte" && scope.has(v.relname)) subs.set(v.alias?.aliasname ?? v.relname, scope.get(v.relname)!);
    if (n.RangeSubselect?.subquery?.SelectStmt) subs.set(n.RangeSubselect.alias?.aliasname ?? "", outputs(n.RangeSubselect.subquery, scope).columns);
  };
  for (const f of sel.fromClause ?? []) walk(f);
  const typeOf = (schema: string, col: string) => schemas[schema]!.fields[col] ?? (col === "published_at" && schemas[schema]!.publishing ? "timestamptz" : Object.hasOwn(NATIVE_OUTPUT_TYPES, col) ? NATIVE_OUTPUT_TYPES[col] : undefined);
  const field = (schema: string | undefined, col: string) => (schema && typeOf(schema, col) && (includeGeo || typeOf(schema, col) !== "geo") ? { schema, field: col } : undefined);
  let keys: string[] | undefined = [];
  for (const { ResTarget: r } of sel.targetList) {
    // sum, min and max of one column keep its type (a sum of money is money); a count or an average does not
    const agg = r.val?.FuncCall;
    const fn = agg?.funcname?.at(-1)?.String?.sval;
    const arg = agg && !agg.over && !agg.agg_distinct && agg.args?.length === 1 ? agg.args[0].ColumnRef?.fields : undefined;
    const refs = r.val?.ColumnRef?.fields ?? (includeAggregates && r.name && arg && ["sum", "min", "max"].includes(fn) ? arg : undefined);
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
    const relName = refs?.length === 2 ? refs[0].String.sval : refs?.length === 1 && rels.size === 1 ? [...rels.keys()][0] : undefined;
    const rel = relName === undefined ? undefined : rels.get(relName);
    const f = col ? field(rel, col) ?? (relName !== undefined ? subs.get(relName)?.[col] : undefined) : undefined;
    if (f && (fn !== "sum" || r.val?.ColumnRef || ["integer", "real"].includes(typeOf(f.schema, f.field)!) || typeOf(f.schema, f.field)!.startsWith("numeric("))) columns[name] = f;
  }
  return { ...(keys ? { keys: [...new Set(keys)], positions: keys } : {}), columns };
}

/** The functions whose result is always a JSON document (SQLite's JSON text, PostgreSQL's json/jsonb), never a scalar. */
const JSON_FUNCS = new Set(["json_group_array", "json_group_object", "json_set", "json_insert", "json_remove", "jsonb_agg", "jsonb_object_agg", "jsonb_build_object", "jsonb_build_array", "jsonb_strip_nulls", "to_jsonb"]);
/** A JSON document by construction: a JSON function, `CAST(… AS jsonb)`, a scalar subquery of one, or a COALESCE of those (a literal fallback must itself be JSON). */
const isJson = (n: SqlNode | undefined): boolean => {
  if (n?.FuncCall) return JSON_FUNCS.has(n.FuncCall.funcname?.at(-1)?.String?.sval);
  if (n?.TypeCast) return n.TypeCast.typeName?.names?.at(-1)?.String?.sval === "jsonb";
  const sub = n?.SubLink?.subLinkType === "EXPR_SUBLINK" ? n.SubLink.subselect?.SelectStmt : undefined;
  if (sub) return sub.targetList?.length === 1 && isJson(sub.targetList[0].ResTarget?.val);
  const args: SqlNode[] | undefined = n?.CoalesceExpr?.args;
  const literal = (a: SqlNode) => { const text = a.A_Const?.sval?.sval; try { return text !== undefined && (JSON.parse(text), true); } catch { return false; } };
  return !!args?.some(isJson) && args.every((a) => isJson(a) || literal(a));
};
/** The named outputs of a View's top-level SELECT that are computed JSON documents, so selected boundaries can type them as `json`. */
export const jsonOutputs = (view: SqlPlan): ReadonlySet<string> =>
  new Set((view.stmts[0]?.SelectStmt?.targetList ?? []).flatMap(({ ResTarget: r }: SqlNode) => (r?.name && isJson(r.val) ? [r.name as string] : [])));

/** Compile a linked manifest set to the sealed plan. Every refusal is reported, one per SQL source. */
export async function compileLinkedPlan(linked: LinkedManifestSet, dialect: SqlDialect = d1): Promise<CompilePlanResult> {
  const schemas: Record<string, PlanSchema> = {};
  const userFields: Record<string, UserFieldSpec> = Object.create(null);
  const diagnostics: Diagnostic[] = [];
  for (const { manifest: m } of linked.schemas) {
    const template = m.spec.scope === undefined ? undefined : parseRowTemplate(m.spec.scope);
    const scope = template && typeof template === "object" ? template.owner?.toLowerCase() : undefined;
    const userScopes = template && typeof template === "object" ? template.terms.map(({ column, field }) => {
      const property = m.spec.schema.properties?.[column];
      const type = property?.type === "string" ? "string" as const : "number" as const;
      try { registerUserField(userFields, field, { type, multiple: true, ...(property?.enum ? { enum: property.enum as (string | number)[] } : {}) }); }
      catch (error) { if (!(error instanceof SqlRefusal)) throw error; diagnostics.push(validateDiagnostic({ code: error.code, severity: "error", path: `schemas/${m.metadata.name}/scope`, message: error.message })); }
      return { column: column.toLowerCase(), field, type };
    }) : [];
    const props = m.spec.schema.properties ?? {};
    const lower = (xs: readonly string[]) => xs.map((x) => x.toLowerCase());
    schemas[m.metadata.name.toLowerCase()] = {
      name: m.metadata.name,
      title: m.spec.title,
      ...(m.spec.description ? { description: m.spec.description } : {}),
      ...(m.spec.uiSchema ? { uiSchema: m.spec.uiSchema } : {}),
      ...(m.spec.localized ? { localized: true } : {}),
      ...(scope ? { scope } : {}),
      ...(userScopes.length ? { userScopes } : {}),
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
  // ADR-0037 decision 3: the Views a FROM may name, by name with `-` as `_`; an internal View without input or requires becomes native SQL
  const refs: Record<string, { select?: SqlNode; refusal?: string }> = {};
  const refName = (name: string) => name.toLowerCase().replace(/-/g, "_");
  const refOf = new Map(linked.views.map((x) => [refName(x.manifest.metadata.name), x]));
  const readable = new Set<string>();
  for (const [ref, { manifest: v }] of refOf) {
    if (Object.hasOwn(schemas, ref)) continue; // the name reads the Schema: a View named like its Schema is never a relation
    const why = v.spec.surface !== "internal" ? `a ${v.spec.surface} View` : v.spec.input ? "a View with an input" : v.spec.requires ? "a View with requires" : undefined;
    if (!why) readable.add(ref);
    // a readable View is replaced by its SELECT once it compiles (in dependency order, below); until then it is refused
    refs[ref] = { refusal: why ? `${ref} is ${why}: FROM reads only an internal View without input or requires` : `${ref} did not compile` };
  }
  const ctxOf = (kind: SqlContext["kind"], input: JsonSchema | undefined, isPublic = false): SqlContext => ({ schemas, inputs: typesOf(input), kind, public: isPublic, views: refs });
  const compile = async (kind: SqlContext["kind"], sql: string, input: JsonSchema | undefined, source: SourceLocation, pointer: string, isPublic = false) => {
    const res = await compileSql(sql, ctxOf(kind, input, isPublic), dialect);
    if (res.ok) return res;
    diagnostics.push(toDiagnostic(res.diagnostic, source, pointer));
  };

  // a check is compiled as the WHERE of a read of its own Schema, so its columns resolve against that Schema
  for (const { manifest: m, source } of linked.schemas) {
    const name = m.metadata.name.toLowerCase();
    const clash = storageColumnClash(schemas[name]!.fields ?? {});
    if (clash) diagnostics.push(toDiagnostic({ code: "SQL_SHAPE", message: `field '${clash}' is a column storage creates for another purpose (_rid, or a geo field's _lat/_lng)` }, source, `/spec/schema/properties/${clash}`));
    const checks: SqlNode[] = [];
    for (const [i, text] of (m.spec.checks ?? []).entries()) {
      const pointer = `/spec/checks/${i}`;
      const res = await compileSql(`SELECT 1 FROM "${name.replace(/"/g, '""')}" WHERE ${text}`, { schemas, inputs: {}, kind: "view" }, dialect);
      if (!res.ok) { diagnostics.push(toDiagnostic(res.diagnostic, source, pointer)); continue; }
      const where: SqlNode | undefined = res.plan.stmts[0]?.SelectStmt?.whereClause;
      const problem = where ? checkShapeProblem(where, storageColumns(schemas[name]!)) : "a check is one boolean expression";
      if (problem) {
        diagnostics.push(toDiagnostic({ code: "SQL_SHAPE", message: problem }, source, pointer));
        continue;
      }
      checks.push(where!);
    }
    if (checks.length) schemas[name] = { ...schemas[name]!, checks };
  }

  // a View compiles after the Views it reads; a cycle is refused
  type LinkedView = (typeof linked.views)[number];
  const order: LinkedView[] = [];
  const state = new Map<string, "visiting" | "done">();
  const reads = new Map(await Promise.all(linked.views.map(async (x) => [x.manifest.metadata.name, [...await relationNames(x.manifest.spec.sql)].filter((r) => readable.has(r))] as const)));
  const procedureReads = new Map(await Promise.all(linked.procedures.flatMap(({ manifest: p }) => { const sql = (p.spec.handler as { sql?: string }).sql; return sql === undefined ? [] : [(async () => [sql, [...await relationNames(sql)].filter((r) => readable.has(r))] as const)()]; })));
  const viewRefs = (sql: string): readonly string[] => reads.get(linked.views.find(x => x.manifest.spec.sql === sql)?.manifest.metadata.name ?? "") ?? procedureReads.get(sql) ?? [];
  const visit = (x: LinkedView, path: string[]): void => {
    const name = x.manifest.metadata.name;
    if (state.get(name) === "done") return;
    if (state.get(name) === "visiting") { diagnostics.push(toDiagnostic({ code: "SQL_RELATION", message: `View '${name}' reads itself: ${[...path, name].join(" -> ")}` }, x.source, "/spec/sql")); return; }
    state.set(name, "visiting");
    for (const r of reads.get(name) ?? []) visit(refOf.get(r)!, [...path, name]);
    state.set(name, "done");
    order.push(x);
  };
  for (const x of linked.views) visit(x, []);
  const compiled = new Map<string, SqlPlan | undefined>();
  for (const { manifest: v, source } of order) {
    // a View that reads one that failed (or a cycle) is not compiled: the first diagnostic is the one to fix
    if ((reads.get(v.metadata.name) ?? []).some((r) => !refs[r]?.select)) continue;
    const result = await compile("view", v.spec.sql, v.spec.input, source, "/spec/sql", v.spec.surface === "public");
    const plan = result?.plan;
    compiled.set(v.metadata.name, plan);
    const ref = refName(v.metadata.name);
    if (plan && readable.has(ref)) refs[ref] = { select: result!.reference };
  }
  const views: Record<string, PlanView> = {};
  for (const { manifest: v, source } of linked.views) {
    const plan = compiled.get(v.metadata.name);
    const cacheProblem = plan && v.spec.cache ? viewCacheProblem(plan.stmts, schemas) : undefined;
    if (cacheProblem) diagnostics.push(validateDiagnostic({ code: "VIEW_CACHE_INVALID", severity: "error", path: `${source.sourceId}#/${source.documentIndex}/spec/cache`, source: { ...source, path: "/spec/cache" }, message: `View '${v.metadata.name}': ${cacheProblem}.` }));
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
    if (plan) views[v.metadata.name] = { ...plan, ...(Object.keys(columns).length ? { columns } : {}), ...(v.spec.title ? { title: v.spec.title } : {}), ...(v.spec.description ? { description: v.spec.description } : {}), ...(v.spec.uiSchema ? { uiSchema: v.spec.uiSchema } : {}), inputs: typesOf(v.spec.input), ...(v.spec.input ? { input: v.spec.input } : {}), source: v.spec.sql, surface: v.spec.surface, ...(v.spec.requires ? { requires: v.spec.requires } : {}), ...(v.spec.cache ? { sharedMaxAge: v.spec.cache.sharedMaxAge } : {}) };
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
    const plan = (await compile("procedure", p.spec.handler.sql, p.spec.input, source, "/spec/handler/sql"))?.plan;
    const target = p.spec.target ?? (plan ? inferTarget(p, plan.stmts) : undefined);
    for (const stmt of plan?.stmts ?? []) {
      const write = stmt.UpdateStmt ?? stmt.InsertStmt, columns = write ? protectedColumns(schemas[write.relation.relname]!) : [];
      const sets = stmt.UpdateStmt?.targetList ?? stmt.InsertStmt?.onConflictClause?.targetList ?? [];
      if (sets.some((set: SqlNode) => columns.includes(set.ResTarget.name.toLowerCase()))) diagnostics.push(validateDiagnostic({code:'USER_FIELD_POSITION',severity:'error',path:`procedures/${p.metadata.name}/handler/sql`,message:'The scoped column is never writable through SET.'}));
    }
    if (plan) procedures[p.metadata.name] = { ...common, ...(target ? { target } : {}), ...(plan.stmts.some(stmt => stmt.InsertStmt && schemas[stmt.InsertStmt.relation.relname]?.userScopes?.length) ? { trustedOnly: true as const } : {}), handler: { sql: plan, source: p.spec.handler.sql } };
  }
  if (diagnostics.length) return { ok: false, diagnostics };
  // `restrict`: extra row terms a target puts on the Schemas its SQL reads. Same grammar as `scope`; AND-ed, so it never widens.
  const touched = (node: unknown, includeCtes = false, found = new Set<string>()): Set<string> => {
    if (!node || typeof node !== "object") return found;
    const n = node as SqlNode, rel = includeCtes || n.RangeVar?.mantle !== "cte" ? n.RangeVar?.relname : undefined;
    if (rel) found.add(rel);
    for (const kind of ["InsertStmt", "UpdateStmt", "DeleteStmt"]) if (n[kind]?.relation?.relname) found.add(n[kind].relation.relname);
    Object.values(node).forEach(child => touched(child, includeCtes, found)); return found;
  };
  const restrictOf = (kind: "views" | "procedures", name: string, raw: Readonly<Record<string, string>> | undefined, stmts: unknown) => {
    if (!raw) return undefined;
    if (typeof raw !== "object" || Array.isArray(raw)) {
      diagnostics.push(validateDiagnostic({ code: "USER_FIELD_CONFLICT", severity: "error", path: `${kind}/${name}/restrict`, message: `restrict maps each Schema to a predicate, e.g. restrict: { orders: "author_id = auth.uid()" }.` }));
      return undefined;
    }
    const read = touched(stmts), out: Record<string, { owner?: string; terms: { column: string; field: string; type: "string" | "number" }[] }> = {};
    for (const [key, text] of Object.entries(raw)) {
      const table = key.toLowerCase(), schema = schemas[table], path = `${kind}/${name}/restrict/${key}`;
      const fail = (message: string) => { diagnostics.push(validateDiagnostic({ code: "USER_FIELD_CONFLICT", severity: "error", path, message })); };
      if (!schema || !read.has(table)) { fail(`restrict key '${key}' is not a Schema this target's SQL reads.`); continue; }
      const template = parseRowTemplate(text);
      if (typeof template === "string") { fail(`restrict: ${template}`); continue; }
      const column = (c: string) => Object.keys(schema.fields).find(f => f === c.toLowerCase());
      // `= auth.uid()` must read a column the system stamps from the caller, or a writer could claim someone else's rows.
      const owner = template.owner?.toLowerCase();
      if (owner && owner !== "author_id" && owner !== schema.scope) { fail(`restrict '${template.owner} = auth.uid()': use author_id (stamped from the caller on insert) or the Schema's own '= auth.uid()' scope column; '${template.owner}' is writable.`); continue; }
      const terms = template.terms.flatMap(({ column: c, field }) => {
        const found = column(c); if (!found) { fail(`restrict column '${c}' is not a field of '${schema.name}'.`); return []; }
        const property = schema.schema?.properties?.[schema.names?.[found] ?? c], type = property?.type === "string" ? "string" as const : "number" as const;
        try { registerUserField(userFields, field, { type, multiple: true, ...(property?.enum ? { enum: property.enum as (string | number)[] } : {}) }); }
        catch (error) { if (!(error instanceof SqlRefusal)) throw error; fail(error.message); }
        return [{ column: found, field, type }];
      });
      out[table] = { ...(owner ? { owner } : {}), terms };
    }
    return Object.keys(out).length ? out : undefined;
  };
  // A restricted View stays restricted when another target reads it: that target carries the View's restrict too
  // (AND-ed onto every relation of the Schema it names). `order` lists a View after the Views it reads.
  type Restrict = NonNullable<PlanView["restrict"]>;
  const inherit = (own: Restrict | undefined, sql: string | undefined, path: string): Restrict | undefined => {
    const merged: Record<string, { owner?: string; terms: { column: string; field: string; type: "string" | "number" }[] }> = Object.fromEntries(Object.entries(own ?? {}).map(([k, r]) => [k, { ...r, terms: [...r.terms] }]));
    for (const ref of sql === undefined ? [] : viewRefs(sql)) for (const [table, r] of Object.entries(views[refOf.get(ref)!.manifest.metadata.name]?.restrict ?? {})) {
      const into = merged[table] ??= { terms: [] };
      if (r.owner && into.owner && r.owner !== into.owner) { diagnostics.push(validateDiagnostic({ code: "USER_FIELD_CONFLICT", severity: "error", path, message: `reads Views whose restrict on '${table}' names different owner columns.` })); continue; }
      if (r.owner) into.owner = r.owner;
      for (const t of r.terms) if (!into.terms.some(x => x.column === t.column && x.field === t.field)) into.terms.push(t);
    }
    return Object.keys(merged).length ? merged : undefined;
  };
  for (const { manifest: v } of order) { const view = views[v.metadata.name], restrict = view && inherit(restrictOf("views", v.metadata.name, v.spec.restrict, view.stmts), v.spec.sql, `views/${v.metadata.name}/restrict`); if (restrict) views[v.metadata.name] = { ...view!, restrict }; }
  for (const { manifest: p } of linked.procedures) {
    const proc = procedures[p.metadata.name];
    if (p.spec.restrict && proc && "ref" in proc.handler) { diagnostics.push(validateDiagnostic({ code: "USER_FIELD_CONFLICT", severity: "error", path: `procedures/${p.metadata.name}/restrict`, message: "restrict applies to SQL Procedures; a ref handler restricts rows through its scoped ctx.store." })); continue; }
    const restrict = proc && "sql" in proc.handler && inherit(restrictOf("procedures", p.metadata.name, p.spec.restrict, proc.handler.sql.stmts) || undefined, (p.spec.handler as { sql?: string }).sql, `procedures/${p.metadata.name}/restrict`);
    if (restrict) procedures[p.metadata.name] = { ...proc!, restrict };
  }
  const triggers: Record<string, PlanTrigger> = Object.fromEntries(linked.triggers.map(({ manifest: t }) => [t.metadata.name, { source: t.spec.source, procedure: t.spec.target.procedure }]));
  const warnings: string[] = [];
  for (const [field, spec] of Object.entries(userFields)) if (!spec.enum) warnings.push(`USER_FIELD_VALUES_UNENUMERATED: '${field}' has no enum; no generated list of all values is available.`);
  const scopedFields = (schema: string) => (schemas[schema]?.userScopes ?? []).map(u => u.field).sort().join(",");
  for (const [name, view] of Object.entries(views)) {
    const read = [...touched(view.stmts, true)].filter(schema => schemas[schema]);
    if (view.surface === "public" && read.some(schema => schemas[schema]!.userScopes?.length))
      warnings.push(`USER_SCOPE_PUBLIC_ANON_EMPTY: public View '${name}' reads field-scoped data; anonymous callers are refused (UNAUTHENTICATED).`);
    if (view.surface === "admin" && read.some(schema => schemas[schema]!.userScopes?.length))
      warnings.push(`USER_SCOPE_ADMIN_VALUES: admin View '${name}' reads field-scoped data; admins without values for those fields see no rows.`);
    const sets = new Set(read.filter(schema => schemas[schema]!.userScopes?.length).map(scopedFields));
    if (sets.size > 1) warnings.push(`USER_SCOPE_JOIN_DROPS: View '${name}' joins Schemas scoped by different fields (${[...sets].join(" / ")}); rows outside any caller set are dropped.`);
  }
  // A Schema that references a field-scoped Schema must carry that Schema's terms, or it would expose rows the referenced scope hides.
  for (const [name, schema] of Object.entries(schemas)) for (const [field, property] of Object.entries(schema.schema?.properties ?? {})) {
    const raw = (property as Record<string, unknown>)["x-mantle-ref"], ref = typeof raw === "string" ? raw : (raw as { schema?: string } | undefined)?.schema;
    const target = ref ? schemas[ref.toLowerCase()] : undefined;
    for (const term of target ? target.userScopes ?? [] : []) if (!(schema.userScopes ?? []).some(u => u.field === term.field))
      diagnostics.push(validateDiagnostic({ code: "USER_FIELD_CONFLICT", severity: "error", path: `schemas/${schema.name}/scope`, message: `'${schema.name}.${field}' references '${target!.name}', which is scoped by auth.user('${term.field}'); scope '${schema.name}' by the same field so its rows cannot expose what that scope hides.` }));
  }
  if (diagnostics.length) return { ok: false, diagnostics };
  const sealed = { version: RUNTIME_PLAN_VERSION, dialect: { name: dialect.name, version: dialect.version }, schemas, views, procedures, triggers,
    ...(Object.keys(userFields).length ? { access: { roles: [], userFields, warnings } } : {}) };
  return { ok: true, plan: { ...sealed, fingerprint: await planFingerprint(sealed) } };
}

/** The plugin's contract: parse, link and compile manifest sources in one call. */
export async function compilePlan(sources: ManifestSourceSet, dialect: SqlDialect = d1, defaultLifecycle: "operational" | "publishing" = "publishing"): Promise<CompilePlanResult> {
  const parsed = parseManifestSources(sources, defaultLifecycle);
  if (!parsed.ok) return parsed;
  const linked = linkManifestSet(parsed.value);
  return linked.ok ? compileLinkedPlan(linked.value, dialect) : linked;
}
