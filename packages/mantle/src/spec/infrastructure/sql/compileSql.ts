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

/**
 * The relation names a source reads, less every name it defines as a CTE, or none when it does not parse: the compiler
 * orders Views by them. ponytail: a CTE named like a View hides that View for the whole source, not only in the CTE's scope.
 */
export async function relationNames(sql: string): Promise<Set<string>> {
  const names = new Set<string>(), ctes = new Set<string>();
  const walk = (v: any): void => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (!v || typeof v !== "object") return;
    if (typeof v.relname === "string") names.add(v.relname);
    if (typeof v.ctename === "string") ctes.add(v.ctename);
    Object.values(v).forEach(walk);
  };
  try { walk((await parsePgSql(sql)).stmts); } catch { /* compileSql reports it */ }
  return new Set([...names].filter((n) => !ctes.has(n)));
}

export type CompileSqlResult = { readonly ok: true; readonly plan: SqlPlan } | { readonly ok: false; readonly diagnostic: SqlDiagnostic };

/** UTF-8 byte offset (what libpg-query reports) to offset, 1-based line and column, and the token there. */
export function locate(source: string, byteOffset: number): Pick<SqlDiagnostic, "offset" | "line" | "column" | "token"> {
  const prefix = new TextDecoder("utf-8", { ignoreBOM: true }).decode(new TextEncoder().encode(source).subarray(0, byteOffset));
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

/** Every relation tagged `view` becomes its View's compiled SELECT, as a FROM subquery under the name it was read by. */
function inlineViews(v: any, views: SqlContext["views"]): any {
  if (Array.isArray(v)) return v.map((x) => inlineViews(x, views));
  if (!v || typeof v !== "object") return v;
  const rv = v.RangeVar;
  if (rv?.mantle === "view") return { RangeSubselect: { subquery: { SelectStmt: structuredClone(views![rv.relname]!.select) }, alias: { aliasname: rv.alias?.aliasname ?? rv.relname } } };
  return Object.fromEntries(Object.entries(v).map(([k, c]) => [k, inlineViews(c, views)]));
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
    const stmts = ctx.views ? (inlineViews(tagged, ctx.views) as SqlNode[]) : tagged;
    dialect.accepts(stmts, { ...ctx, source: sql }, parsed.locations);
    return { ok: true, plan: { grammar: PG_GRAMMAR, stmts: stripLocations(stmts) } };
  } catch (e) {
    if (e instanceof SqlRefusal) return { ok: false, diagnostic: toDiagnostic(e, sql) };
    throw e;
  }
}
