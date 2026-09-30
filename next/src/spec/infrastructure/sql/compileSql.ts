/**
 * The shared front end (ADR-0035 decision 4): SQL text to IR. The parser reads the text and every relation is tagged;
 * the dialect's `accepts` runs on the raw AST (so a refusal has a source offset); then locations are stripped.
 * The one dialect is D1 until `mantle.config.json` names one (ADR-0035 decision 5). Nothing in a Worker imports this module.
 */
import type { SqlContext, SqlDiagnostic, SqlNode, SqlPlan } from "../../domain/model/SqlIr.js";
import { PG_GRAMMAR } from "../../domain/model/SqlIr.js";
import { SqlRefusal } from "../../domain/service/SqlRefusal.js";
import { accepts } from "../../../d1/compile/index.js";
import { parsePgSql } from "./PgQueryParser.js";

export type CompileSqlResult = { readonly ok: true; readonly plan: SqlPlan } | { readonly ok: false; readonly diagnostic: SqlDiagnostic };

/** UTF-8 byte offset (what libpg-query reports) to offset, 1-based line and column, and the token there. */
export function locate(source: string, byteOffset: number): Pick<SqlDiagnostic, "offset" | "line" | "column" | "token"> {
  const prefix = Buffer.from(source, "utf8").subarray(0, byteOffset).toString("utf8");
  const lines = prefix.split("\n");
  const rest = source.slice(prefix.length);
  const token = /^("[^"]*"|'[^']*'|[\w.$]+|\S)/.exec(rest)?.[0];
  return { offset: prefix.length, line: lines.length, column: lines[lines.length - 1]!.length + 1, ...(token ? { token } : {}) };
}

function toDiagnostic(e: SqlRefusal, source: string): SqlDiagnostic {
  // a clause the AST gives no position: point at its keyword, never at a quoted string or identifier
  // that spells it (literals are blanked to the same length, so indexes still match the source)
  const at = e.keyword?.exec(source.replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"/g, (m) => " ".repeat(m.length)));
  if (at) return { code: e.code, message: e.message, ...locate(source, Buffer.byteLength(source.slice(0, at.index))), token: at[0] };
  return { code: e.code, message: e.message, ...(e.offset === undefined ? {} : locate(source, e.offset)) };
}

/** Tag every RangeVar. The parser cannot tell a table from a CTE; with no CTE syntax every relation is a table. */
function tagRelations(v: any): any {
  if (Array.isArray(v)) return v.map(tagRelations);
  if (!v || typeof v !== "object") return v;
  const out: SqlNode = {};
  for (const [k, c] of Object.entries(v)) out[k] = tagRelations(c);
  if ("relname" in out && !("mantle" in out)) out.mantle = "table";
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
export async function compileSql(sql: string, ctx: SqlContext): Promise<CompileSqlResult> {
  try {
    const parsed = await parsePgSql(sql);
    const tagged = tagRelations(parsed.stmts) as SqlNode[];
    accepts(tagged, { ...ctx, source: sql }, parsed.locations);
    return { ok: true, plan: { grammar: PG_GRAMMAR, stmts: stripLocations(tagged) } };
  } catch (e) {
    if (e instanceof SqlRefusal) return { ok: false, diagnostic: toDiagnostic(e, sql) };
    throw e;
  }
}
