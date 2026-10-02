/**
 * What the PostgreSQL dialect accepts: ADR-0034's portable subset (D1's allowlist), less what it cannot give PostgreSQL's
 * result for. So a manifest that compiles for PostgreSQL also compiles for D1, and moving engines is a recompile.
 * Pure JavaScript, like D1's validator: the runtime imports it.
 */
import type { SqlContext, SqlDiagnostic, SqlNode as N, SqlPlan } from "../spec/domain/model/SqlIr.js";
import { SqlRefusal } from "../spec/domain/service/SqlRefusal.js";
import { validateIr as d1Ir, validateProgram as d1Program } from "../d1/validator.js";

/** SQLite's own functions, which PostgreSQL has no faithful spelling of. */
const REFUSED: Record<string, string> = {
  typeof: "typeof() is SQLite's; PostgreSQL has pg_typeof() with other names",
  hex: "hex() is SQLite's",
  json_extract: "json_extract() is SQLite's: write x ->> '$.path'",
  json_set: "json_set() is SQLite's", json_insert: "json_insert() is SQLite's", json_remove: "json_remove() is SQLite's",
};

function refuse(stmts: N[]): void {
  const walk = (v: any): void => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (!v || typeof v !== "object") return;
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

/** The compile side: D1's checks, then PostgreSQL's refusals, each with its source offset. */
export function validateProgram(stmts: N[], ctx: SqlContext & { source?: string }, locs: (number | undefined)[] = []): void {
  d1Program(stmts, ctx, locs);
  refuse(stmts);
}

/** The runtime's check of every program's IR. */
export function validateIr(plan: SqlPlan, ctx: SqlContext): readonly SqlDiagnostic[] {
  const d = d1Ir(plan, ctx);
  if (d.length) return d;
  try {
    refuse(plan.stmts as N[]);
    return [];
  } catch (e) {
    return [{ code: (e as SqlRefusal).code ?? "SQL_UNSUPPORTED", message: (e as Error).message }];
  }
}
