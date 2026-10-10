/**
 * The shared front end (ADR-0035 decision 4): SQL text to IR. The parser reads the text and every relation is tagged;
 * the dialect's `accepts` runs on the raw AST (so a refusal has a source offset); then locations are stripped.
 * The dialect is D1 unless the caller passes another (`mantle.config.json`'s `dialect`, ADR-0035 decision 5). Nothing in a Worker imports this module.
 */
import type { SqlContext, SqlDiagnostic, SqlNode, SqlPlan } from "../../domain/model/SqlIr.js";
import { PG_GRAMMAR } from "../../domain/model/SqlIr.js";
import { SqlRefusal } from "../../domain/service/SqlRefusal.js";
import * as d1 from "../../../d1/compile/index.js";
import { parsePgSql } from "./PgQueryParser.js";
import { refuseForEveryDialect } from "./frontEnd.js";

/** A dialect's compile side, as `<dialect>/compile` exports it (ADR-0035 decision 3). */
export interface SqlDialect {
  readonly name: string;
  readonly version: string;
  /** Throws the first refusal as a `SqlRefusal` with its source offset. */
  accepts(stmts: SqlNode[], context: SqlContext & { source: string }, locations: (number | undefined)[]): void;
}

/** Relations outside lexical CTE scope: the compiler orders named Views by these dependencies. */
export async function relationNames(sql: string): Promise<Set<string>> {
  const names = new Set<string>();
  const walk = (v: any, scope = new Set<string>()): void => {
    if (Array.isArray(v)) return v.forEach((x) => walk(x, scope));
    if (!v || typeof v !== "object") return;
    if (typeof v.relname === "string" && !scope.has(v.relname)) names.add(v.relname);
    const w = v.withClause;
    if (w) {
      const declared = w.ctes.map((x: SqlNode) => x.CommonTableExpr.ctename);
      w.ctes.forEach((x: SqlNode, i: number) => walk(x.CommonTableExpr.ctequery, new Set([...scope, ...(w.recursive ? declared : declared.slice(0, i))])));
      scope = new Set([...scope, ...declared]);
    }
    for (const [key, child] of Object.entries(v)) if (key !== "withClause") walk(child, scope);
  };
  try { walk((await parsePgSql(sql)).stmts); } catch { /* compileSql reports it */ }
  return names;
}

export type CompileSqlResult = { readonly ok: true; readonly plan: SqlPlan; /** Compile-only dependency source; never sealed into a RuntimePlan. */ readonly reference?: SqlNode } | { readonly ok: false; readonly diagnostic: SqlDiagnostic };

/** UTF-8 byte offset (what libpg-query reports) to offset, 1-based line and column, and the token there. */
export function locate(source: string, byteOffset: number): Pick<SqlDiagnostic, "offset" | "line" | "column" | "token"> {
  const prefix = new TextDecoder("utf-8", { ignoreBOM: true, fatal: false }).decode(new TextEncoder().encode(source).subarray(0, byteOffset));
  const lines = prefix.split("\n");
  const rest = source.slice(prefix.length);
  const token = /^("[^"]*"|'[^']*'|[\w.$]+|\S)/.exec(rest)?.[0];
  return { offset: prefix.length, line: lines.length, column: lines[lines.length - 1]!.length + 1, ...(token ? { token } : {}) };
}

function toDiagnostic(e: SqlRefusal, source: string): SqlDiagnostic {
  // a clause the AST gives no position: point at its keyword, never at a quoted string or identifier
  // that spells it (literals are blanked to the same length, so indexes still match the source)
  const at = e.keyword?.exec(source.replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"/g, (m) => " ".repeat(m.length)));
  if (at) return { code: e.code, message: e.message, ...locate(source, new TextEncoder().encode(source.slice(0, at.index)).byteLength), token: at[0] };
  return { code: e.code, message: e.message, ...(e.offset === undefined ? {} : locate(source, e.offset)) };
}

/** Tag every RangeVar a table; the front end retags a CTE in scope `cte` and a View `view`. */
function tagRelations(v: any): any {
  if (Array.isArray(v)) return v.map(tagRelations);
  if (!v || typeof v !== "object") return v;
  const out: SqlNode = {};
  for (const [k, c] of Object.entries(v)) out[k] = tagRelations(c);
  if ("relname" in out && !("mantle" in out)) out.mantle = "table";
  return out;
}

/** A named dependency is native SQL structure, shared inside its outermost SELECT rather than copied per reference. */
function expandViews(v: any, views: NonNullable<SqlContext["views"]>): any {
  if (Array.isArray(v)) return v.map((x) => expandViews(x, views));
  if (!v || typeof v !== "object") return v;
  if (!v.SelectStmt) return Object.fromEntries(Object.entries(v).map(([k, c]) => [k, expandViews(c, views)]));
  const used = new Set<string>(), tables = new Set<string>();
  const reserve = (n: any): void => {
    if (!n || typeof n !== "object") return;
    if (n.RangeVar?.mantle === "table") tables.add(n.RangeVar.relname);
    for (const [key, child] of Object.entries(n)) {
      if (["relname", "ctename", "aliasname"].includes(key)) used.add(String(child));
      reserve(child);
    }
  };
  reserve(v);
  for (const ref of Object.values(views)) reserve(ref.select);
  let serial = 0;
  const fresh = () => { let name: string; do { name = `_view_${serial++}`; } while (used.has(name)); used.add(name); return name; };
  const names = new Map<string, string>(), definitions: SqlNode[] = [];
  const walk = (n: any, scope = new Map<string, string>()): any => {
    if (Array.isArray(n)) return n.map((x) => walk(x, scope));
    if (!n || typeof n !== "object") return n;
    const rv = n.RangeVar;
    if (rv?.mantle === "view") {
      let name = names.get(rv.relname);
      if (!name) {
        names.set(rv.relname, name = fresh());
        // A dependency was validated in its own lexical scope, not under the caller's authored WITH.
        const select = walk(views[rv.relname]!.select);
        definitions.push({ CommonTableExpr: { ctename: name, ctequery: { SelectStmt: select }, ctematerialized: "CTEMaterializeDefault" } });
      }
      return { RangeVar: { ...rv, mantle: "cte", relname: name, alias: rv.alias ?? { aliasname: rv.relname } } };
    }
    if (rv?.mantle === "cte" && scope.has(rv.relname) && scope.get(rv.relname) !== rv.relname)
      return { RangeVar: { ...rv, relname: scope.get(rv.relname), alias: rv.alias ?? { aliasname: rv.relname } } };
    const w = n.withClause;
    if (!w) return Object.fromEntries(Object.entries(n).map(([k, c]) => [k, walk(c, scope)]));
    // Rename authored CTEs too: neither later SQLite siblings nor a recursive WITH may capture a dependency's table read.
    const local = new Map<string, string>(w.ctes.map((x: SqlNode) => [x.CommonTableExpr.ctename, tables.has(x.CommonTableExpr.ctename) ? fresh() : x.CommonTableExpr.ctename]));
    const inner = new Map([...scope, ...local]);
    const prior = new Map(scope);
    const ctes = w.ctes.map(({ CommonTableExpr: c }: SqlNode) => {
      const query = walk(c.ctequery, w.recursive ? inner : prior);
      prior.set(c.ctename, local.get(c.ctename)!);
      return { CommonTableExpr: { ...c, ctename: local.get(c.ctename), ctequery: query } };
    });
    return { ...Object.fromEntries(Object.entries(n).filter(([k]) => k !== "withClause").map(([k, c]) => [k, walk(c, inner)])), withClause: { ...w, ctes } };
  };
  const out = walk(v);
  if (definitions.length) out.SelectStmt.withClause = { ...out.SelectStmt.withClause, ctes: [...definitions, ...(out.SelectStmt.withClause?.ctes ?? [])] };
  return out;
}

/** Drop what only diagnostics need. */
function stripLocations(v: unknown): SqlNode[] {
  return JSON.parse(JSON.stringify(v), (k, c) => (k === "location" || k === "rexpr_list_start" || k === "rexpr_list_end" ? undefined : c));
}

/**
 * Compile one SQL source (a View's `sql`, or a Procedure's statements) to a plan, or say why not.
 * The first refusal is returned: the compiler stops at the first thing it cannot accept.
 */
export async function compileSql(sql: string, ctx: SqlContext, dialect: SqlDialect = d1): Promise<CompileSqlResult> {
  try {
    const parsed = await parsePgSql(sql);
    const tagged = tagRelations(parsed.stmts) as SqlNode[];
    refuseForEveryDialect(tagged, ctx, parsed.locations);
    const stmts = expandViews(tagged, ctx.views ?? {}) as SqlNode[];
    dialect.accepts(stmts, { ...ctx, source: sql }, parsed.locations);
    return { ok: true, plan: { grammar: PG_GRAMMAR, stmts: stripLocations(stmts) }, ...(ctx.kind === "view" ? { reference: stripLocations(tagged)[0]!.SelectStmt } : {}) };
  } catch (e) {
    if (e instanceof SqlRefusal) return { ok: false, diagnostic: toDiagnostic(e, sql) };
    throw e;
  }
}
