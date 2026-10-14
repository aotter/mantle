import { describeApp } from "../domain/describe/index.js";
/** Build-time assembly only. None of these imports enter generated applications. */
import { compilePlan, viewOutputs, sqliteCompiler, postgresCompiler, d1Dialect, postgresDialect, lowerPlan, sqliteSchema, postgresSchema, type AdminExtension, type ManifestSourceSet, type LoweredStatement, type RuntimePlan, type SqlNode } from "../build/compiler.js";
import { wireReturning, wireScalars } from "../domain/wireScalars.js";
import { boundaryType, outputType } from "../domain/columns.js";
import { castCursor, provePaging, type PagingProof } from "../domain/paging.js";
import { dialect as sqliteDialect } from "../kernel/dialect/sqlite.js";
import { cast, dialect as postgresDialect_ } from "../kernel/dialect/postgres.js";
import { adminBindingsOf } from "./adminPaging.js";
import { adminIndexes } from "../domain/adminOrder.js";
import { publishingSql } from "../usecase/publishing.js";
import { searchDiagnostics } from "../usecase/search.js";
import { generate } from "../usecase/generate.js";
import type { GenerateDiagnostic, GenerateResult, Target } from "../domain/generation.js";
import { generatedFiles } from "../domain/entry.js";

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

/** Operational records are added in Admin only through a Procedure placed with `uiSchema.collectionAction`; name the Schemas left without one. */
function adminCreateWarnings(plan: RuntimePlan): string[] {
  const placed = new Set(Object.values(plan.procedures).map(p => p.uiSchema?.["collectionAction"]).filter((name): name is string => typeof name === "string").map(name => name.toLowerCase()));
  return Object.values(plan.schemas).filter(s => {
    const required = new Set(s.schema.required ?? []);
    // Folded children open from their parent; translations from their language tabs.
    const folded = Object.entries(s.schema.properties ?? {}).some(([name, property]) => required.has(name) && typeof (property as { "x-mantle-ref"?: unknown })?.["x-mantle-ref"] === "string");
    // Field-scoped rows belong to their members, who create them.
    return !s.publishing && s.schema.readOnly !== true && !s.scope && !s.translates && !folded && !placed.has(s.name.toLowerCase());
  }).map(s => `Schema '${s.name}' is operational and writable, but no Procedure places a create action on it, so Admin cannot add its records. Add a Procedure with uiSchema.collectionAction: ${s.name} and an admin MCP Trigger, or mark the Schema readOnly.`);
}

/** Warn about SQL's case folding without changing the authored output names. */
function outputNameWarnings(plan: RuntimePlan): string[] {
  const warnings: string[] = [];
  const inspect = (kind: string, name: string, stmts: readonly SqlNode[]) => {
    for (const stmt of stmts) {
      const select = stmt.SelectStmt, write = stmt.InsertStmt ?? stmt.UpdateStmt ?? stmt.DeleteStmt;
      const targets = kind === "View" ? select?.targetList : write?.returningClause?.exprs;
      const relations = new Map<string, string | undefined>();
      const from = (node: SqlNode): void => {
        if (node.JoinExpr) { from(node.JoinExpr.larg); from(node.JoinExpr.rarg); return; }
        const r = node.RangeVar ?? node;
        if (r.relname) relations.set(r.alias?.aliasname ?? r.relname, r.mantle === "table" ? r.relname : undefined);
      };
      if (write) from(write.relation);
      for (const node of select?.fromClause ?? write?.fromClause ?? write?.usingClause ?? []) from(node);
      for (const { ResTarget: target } of targets ?? []) {
        const refs = target.val?.ColumnRef?.fields;
        if (target.name || !refs?.every((ref: SqlNode) => ref.String) || refs.length > 2) continue;
        const column = refs.at(-1).String.sval;
        const candidates = refs.length === 2 ? [relations.get(refs[0].String.sval)] : [...relations.values()].filter(schema => schema && plan.schemas[schema]?.fields[column]);
        if (candidates.length !== 1 || !candidates[0]) continue;
        const declared = plan.schemas[candidates[0]]?.names?.[column];
        if (declared && declared !== column) {
          const reference = refs.length === 2 ? `${refs[0].String.sval}.${declared}` : declared;
          warnings.push(`${kind} '${name}' field '${declared}' outputs storage name '${column}'; use ${reference} AS "${declared}" to preserve the declared name.`);
        }
      }
    }
  };
  for (const [name, view] of Object.entries(plan.views)) inspect("View", name, view.stmts);
  for (const [name, procedure] of Object.entries(plan.procedures)) if ("sql" in procedure.handler) inspect("Procedure", name, procedure.handler.sql.stmts);
  return [...new Set(warnings)];
}

export interface GenerateRequest { readonly target: Target; readonly admin?: boolean; readonly sources: ManifestSourceSet; /** Select the optional generated site/media capability and deployment tables. */ readonly site?: import("../build/compiler.js").SiteDefaults; readonly adminExtensions?: readonly AdminExtension[] }

export async function generateFromSources(request: GenerateRequest, schema?: () => readonly string[]): Promise<GenerateResult> {
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
  const refusals: GenerateDiagnostic[] = [], paging: Record<string, PagingProof | undefined> = {};
  const lower = (boundary: boolean) => lowerPlan(compiled.plan, dialect, {
    pageQuery(ast, name) {
      // Core visits public/caller before trusted. Prove the real caller equality prefixes;
      // a trusted all-scope read does not acquire a fictional scope predicate.
      if (!Object.hasOwn(paging, name)) paging[name] = provePaging(compiled.plan, ast);
      return { SelectStmt: { ...ast.SelectStmt, limitCount: undefined, limitOption: "LIMIT_OPTION_DEFAULT" } };
    },
    project(ast, kind, name, page) {
      if (kind === "procedure") return wireReturning(ast, compiled.plan.schemas, wire);
      if (page && !page.flat) ast = castCursor(ast, page.sources, paging[name]?.types ?? [], postgres);
      const keys = page && !page.flat ? [...page.names, ...Array.from({length:page.nkeys}, (_,i)=>`_k${i}`)] : viewKeys[name];
      if (!keys) return ast;
      const types = page && !page.flat ? [...page.names.map(key=>boundaryType(compiled.plan,name,key)), ...(paging[name]?.types ?? [])] : keys.map(key=>page ? boundaryType(compiled.plan,name,key) : outputType(compiled.plan,name,key));
      let projected = wireScalars(ast,keys,types,wire,boundary && !!page);
      if (typeof projected !== "string" && page && !page.flat && !boundary) projected = wireScalars(projected,keys,[...page.names.map(() => undefined), ...(paging[name]?.types ?? []).map(type => ["integer","int8","int4"].includes(type) ? type : undefined)],wire,true);
      if (typeof projected !== "string") return projected;
      refusals.push({code:"GENERATE_UNSUPPORTED",path:`views/${name}`,message:projected});
      return ast;
    },
  });
  const { lowered, warnings } = lower(false);
  const wireLowered = lower(true).lowered;
  if (postgres) {
    const seen = new Set<LoweredStatement>();
    const plans = [lowered, wireLowered];
    for (const plan of plans) for (const [kind, all] of [["views", plan.views], ["procedures", plan.procedures]] as const) for (const [name, modes] of Object.entries(all)) {
      for (const statement of Object.values(modes).flat() as LoweredStatement[]) if (!seen.has(statement)) { seen.add(statement); castInputs(statement, `${kind}/${name}`, refusals);
        if ("paged" in statement) for (const page of Object.values((statement as import("../build/compiler.js").LoweredView).paged)) {
          const inputPage = { ...statement, sql:page.sql };
          castInputs(inputPage, `${kind}/${name}`, refusals);
          Object.assign(page,{sql:inputPage.sql});
        } }
    }
  }
  const searchProblems = searchDiagnostics(warnings);
  refusals.push(...searchProblems);
  const adminReads=request.admin?await adminBindingsOf(compiled.plan,dialect,paging,wire,refusals):undefined;
  const {adminPages,adminEntries}=adminReads??{};
  const report = await describeApp(compiled.plan);
  const result = generate({ description: report, target: request.target, admin:request.admin, adminPages, adminEntries, site: request.site, plan: compiled.plan, lowered, wireLowered, viewKeys, newId: coreNewId(dialect, compiled.plan.schemas), adminExtensions: request.adminExtensions, paging });
  if (refusals.length) {
    const diagnostics = result.ok ? [] : result.diagnostics.filter(d =>
      !searchProblems.some(p => p.path === d.path) ||
      !["Every reachable visibility mode must have canonical lowered SQL.", "Both caller and trusted SQL must be lowered."].includes(d.message));
    return { ok: false, diagnostics: [...refusals, ...diagnostics] };
  }
  if (!result.ok) return result;
  const accessTargets = Object.fromEntries(report.targets.map(({ _meta: m }) => {
    const policy = ({ opaque, requires }: typeof m | typeof m.variants[number]) => ({ opaque, ...(requires.guard ? {guard: requires.guard} : {}) });
    return [m.id, { targetHash: m.targetHash, ...policy(m), ...(m.variants.length ? { variants: m.variants.map(v => ({ id: v.id, ...policy(v) })) } : {}) }];
  }));
  const gatewayFiles = generatedFiles({ "access-targets.ts": `import type { AccessTarget } from "@aotter/mantle/contracts";\nexport const targets: Readonly<Record<string, AccessTarget>> = ${JSON.stringify(accessTargets)};\n` });
  const ddl = [...(postgres ? postgresSchema : sqliteSchema)(compiled.plan.schemas), ...publishingSql(compiled.plan.schemas, !postgres), ...(request.admin ? adminIndexes(compiled.plan.schemas, !postgres) : []), ...(schema?.() ?? [])];
  const { "site-schema.sql": siteSql = "", ...files } = result.files;
  return { ...result, warnings: [...outputNameWarnings(compiled.plan), ...(request.admin ? adminCreateWarnings(compiled.plan) : []), ...(compiled.plan.access?.warnings ?? [])], files: { ...files, ...gatewayFiles, ...generatedFiles({ "schema.sql": ddl.join(";\n\n") + ";\n" + siteSql }) } };
}
