/**
 * What the PostgreSQL dialect accepts: Mantle SQL's reference profile (ADR-0037 decision 1), less SQLite's own vocabulary,
 * which the base profile carries for D1 (ADR-0039): a construct that means something else here is refused with its position and
 * the PostgreSQL spelling to use. Pure JavaScript: the runtime imports it.
 */
import type { SqlContext, SqlDiagnostic, SqlNode as N, SqlPlan } from "../spec/domain/model/SqlIr.js";
import { SqlRefusal } from "../spec/domain/service/SqlRefusal.js";
import { PROFILES, validateIr as referenceIr, validateProgram as referenceProgram } from "../core/sql/allowlist.js";

/** SQLite's own functions, and the PostgreSQL spelling of each where there is one. */
const REFUSED: Record<string, string> = {
  typeof: "typeof() is SQLite's; PostgreSQL has pg_typeof() with other names",
  hex: "hex() is SQLite's; PostgreSQL's encode() is not on the allowlist",
  json_each: "json_each() is SQLite's: use jsonb_array_elements_text(x) AS j(value) for an array, or jsonb_each_text(x) AS j(key, value) for an object, in FROM",
  json_extract: "json_extract() is SQLite's: use x ->> 'key', x ->> 0 or x #>> '{a,b}'",
  json_set: "json_set() is SQLite's: build the value with jsonb_build_object() or jsonb_build_array()", json_insert: "json_insert() is SQLite's: build the value with jsonb_build_object() or jsonb_build_array()", json_remove: "json_remove() is SQLite's: use x - 'key' to drop a key",
};
/** A `$` path as ->>'s key: SQLite reads it as a path, PostgreSQL as a key named `$.a`, silently NULL. */
const DOLLAR_PATH = /^\$(?:[.[]|$)/;

function refuse(stmts: N[]): void {
  const walk = (v: any): void => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (!v || typeof v !== "object") return;
    const a = v.A_Expr;
    const key = a?.rexpr?.A_Const?.sval?.sval;
    if (a?.kind === "AEXPR_OP" && ["->>", "->"].includes(a.name?.at(-1)?.String?.sval) && typeof key === "string" && DOLLAR_PATH.test(key))
      throw new SqlRefusal("SQL_UNSUPPORTED", `'${key}' is a SQLite JSON path: PostgreSQL reads it as a key named ${key}. Use x ->> 'key', x ->> 0 or x #>> '{a,b}'`, a.rexpr.A_Const.location ?? a.location);
    const f = v.FuncCall;
    if (f) {
      const name = f.funcname.map((x: N) => x.String?.sval).join(".").replace(/^pg_catalog\./, "");
      if (REFUSED[name]) throw new SqlRefusal("SQL_FUNCTION", REFUSED[name], f.location);
      if (name === "json_array_length" && f.args?.length !== 1) throw new SqlRefusal("SQL_FUNCTION", "json_array_length() takes one argument on PostgreSQL", f.location);
    }
    Object.values(v).forEach(walk);
  };
  walk(stmts);
}

/** The compile side: PostgreSQL's refusals first, so a SQLite spelling is answered with its PostgreSQL one, then the reference profile. */
export function validateProgram(stmts: N[], ctx: SqlContext & { source?: string }, locs: (number | undefined)[] = []): void {
  refuse(stmts);
  referenceProgram(stmts, ctx, locs, PROFILES.reference);
}

/** The runtime's check of every program's IR. */
export function validateIr(plan: SqlPlan, ctx: SqlContext): readonly SqlDiagnostic[] {
  const d = referenceIr(plan, ctx, PROFILES.reference);
  if (d.length) return d;
  try {
    refuse(plan.stmts as N[]);
    return [];
  } catch (e) {
    return [{ code: (e as SqlRefusal).code ?? "SQL_UNSUPPORTED", message: (e as Error).message }];
  }
}
