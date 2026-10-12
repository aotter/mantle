/** Build-time assembly only. None of these imports enter generated applications. */
import { compilePlan, viewOutputs, sqliteCompiler, postgresCompiler, d1Dialect, postgresDialect, lowerPlan, sqliteSchema, postgresSchema, type AdminExtension, type ManifestSourceSet, type LoweredStatement } from "@aotter/mantle/compiler";
import { wireReturning, wireScalars } from "../domain/wireScalars.js";
import { outputType } from "../domain/columns.js";
import { provePaging, type PagingProof } from "../domain/paging.js";
import { nextMode, STAFF_ROLES } from "../domain/visibility.js";
import { dialect as sqliteDialect } from "../kernel/dialect/sqlite.js";
import { cast, dialect as postgresDialect_ } from "../kernel/dialect/postgres.js";
import { publishingSql } from "../usecase/publishing.js";
import { searchDiagnostics } from "../usecase/search.js";
import { generate } from "../usecase/generate.js";
import type { GenerateDiagnostic, GenerateResult, Target } from "../domain/model.js";
import type { BetterAuthOptions } from "better-auth/types";
import { adminPage } from "../domain/adminPaging.js";
import { generatedFiles } from "../domain/artifacts.js";

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

export async function generateFromSources(request: { readonly target: Target; readonly sources: ManifestSourceSet; /** Select the optional generated site/media capability and deployment tables. */ readonly site?: import("@aotter/mantle/compiler").SiteDefaults; /** The application's Better Auth options: their tables join schema.sql. */ readonly auth?: BetterAuthOptions; readonly adminExtensions?: readonly Pick<AdminExtension,"id"|"contributes">[] }): Promise<GenerateResult> {
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
  const refusals: GenerateDiagnostic[] = [], paging:Record<string,PagingProof|undefined>={};
  const adminPages: Record<string, {sql:string;matches:string[]}[]> = {};
  const { lowered, warnings } = lowerPlan(compiled.plan, dialect, {
    mode: nextMode,
    staffRoles: STAFF_ROLES,
    pageQuery(ast, name) {
      // Core visits public/caller before trusted. Prove the real caller equality prefixes;
      // a trusted all-scope read does not acquire a fictional scope predicate.
      if (!Object.hasOwn(paging, name)) paging[name] = provePaging(compiled.plan, ast);
      return { SelectStmt: { ...ast.SelectStmt, limitCount: undefined, limitOption: "LIMIT_OPTION_DEFAULT" } };
    },
    project(ast, kind, name, page) {
      if (kind === "procedure") return wireReturning(ast, compiled.plan.schemas, wire);
      const keys = page && !page.flat ? [...page.names, ...Array.from({length:page.nkeys}, (_,i)=>`_k${i}`)] : viewKeys[name];
      if (!keys) return ast;
      const types = page && !page.flat ? [...page.names.map(key=>outputType(compiled.plan,name,key)), ...(paging[name]?.types ?? [])] : keys.map(key=>outputType(compiled.plan,name,key));
      const projected = wireScalars(ast,keys,types,wire);
      if (typeof projected !== "string") {
        if(page && compiled.plan.views[name]?.surface === "staff" && (adminPages[name]?.length??0)<(page.nkeys?2:1)) {
          const matched=adminPage(ast,compiled.plan.views[name]!,compiled.plan.schemas,!postgres,keys);
          const formatted=wireScalars(matched.ast,keys,types,wire);
          if(typeof formatted === "string")refusals.push({code:"GENERATE_UNSUPPORTED",path:`views/${name}`,message:formatted});
          else (adminPages[name]??=[]).push({sql:dialect.print!(formatted,compiled.plan.schemas),matches:matched.matches});
        }
        return projected;
      }
      refusals.push({code:"GENERATE_UNSUPPORTED",path:`views/${name}`,message:projected});
      return ast;
    },
  });
  if (postgres) {
    const castPage = (statement: LoweredStatement, page: {sql:string}, sources: import("@aotter/mantle/compiler").LoweredPage["sources"], name:string, path:string):void => {
      const inputPage={...statement,sql:page.sql};castInputs(inputPage,path,refusals);
      let sql=inputPage.sql;
      for(const [i,source] of sources.entries()) {
        const type="cursor" in source?paging[name]?.types[source.cursor]:undefined;
        if(type==="timestamptz"||type==="date") {
          const n=statement.binds.length+i+1;
          sql=sql.replace(new RegExp(`\\$${n}(?!\\d)`,"g"),cast(`$${n}`,type));
        }
      }
      Object.assign(page,{sql});
    };
    const seen = new Set<LoweredStatement>();
    for (const [kind, all] of [["views", lowered.views], ["procedures", lowered.procedures]] as const) for (const [name, modes] of Object.entries(all)) {
      for (const statement of Object.values(modes).flat() as LoweredStatement[]) if (!seen.has(statement)) { seen.add(statement); castInputs(statement, `${kind}/${name}`, refusals);
        if ("paged" in statement) for (const page of Object.values((statement as import("@aotter/mantle/compiler").LoweredView).paged)) castPage(statement,page,page.sources,name,`${kind}/${name}`);
      }
    }
    for (const [name,pages] of Object.entries(adminPages)) {
      const statement=lowered.views[name]!.caller!;
      for(const [index,page] of pages.entries()) {
        const original=Object.values(statement.paged).find(p=>p.sources.some(s=>"cursor" in s)===!!(index%2));
        castPage(statement,page,original?.sources??[],name,`views/${name}`);
      }
    }
  }
  const searchProblems = searchDiagnostics(warnings);
  refusals.push(...searchProblems);
  const result = generate({ target: request.target, site: request.site, plan: compiled.plan, lowered, viewKeys, newId: coreNewId(dialect, compiled.plan.schemas), adminExtensions: request.adminExtensions, adminPages, paging });
  if (refusals.length) {
    const diagnostics = result.ok ? [] : result.diagnostics.filter(d =>
      !searchProblems.some(p => p.path === d.path) ||
      !["Every reachable visibility mode must have canonical lowered SQL.", "Both caller and trusted SQL must be lowered."].includes(d.message));
    return { ok: false, diagnostics: [...refusals, ...diagnostics] };
  }
  if (!result.ok) return result;
  const ddl = [...(postgres ? postgresSchema : sqliteSchema)(compiled.plan.schemas), ...publishingSql(compiled.plan.schemas, !postgres), ...(request.auth ? (await import("./authSchema.js")).authSchemaSql(request.auth, postgres ? "postgres" : "sqlite") : [])];
  const { "site-schema.sql": siteSql = "", ...files } = result.files;
  return { ...result, files: generatedFiles({ ...files, "schema.sql": ddl.join(";\n\n") + ";\n" + siteSql }) };
}
