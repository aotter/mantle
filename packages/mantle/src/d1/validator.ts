/**
 * The D1 dialect's allowlist: Mantle SQL's base profile (ADR-0037 decision 1). A construct only the reference profile accepts
 * is refused as needing the PostgreSQL dialect, so an author can tell an engine limit from a mistake.
 */
import type { SqlContext, SqlDiagnostic, SqlNode as N, SqlPlan } from "../spec/domain/model/SqlIr.js";
import { SqlRefusal } from "../spec/domain/service/SqlRefusal.js";
import { PROFILES, validateIr as check, validateProgram as accept } from "../core/sql/allowlist.js";

const POSTGRES_ONLY = "needs the PostgreSQL dialect; D1 runs Mantle SQL's base subset (ADR-0037)";

/** Would the reference profile accept what base refused? */
function postgresOnly(stmts: N[], ctx: SqlContext): boolean {
  try { accept(stmts, ctx, [], PROFILES.reference); return true; } catch { return false; }
}

export function validateProgram(stmts: N[], ctx: SqlContext & { source?: string }, locs: (number | undefined)[] = []): void {
  try {
    accept(stmts, ctx, locs, PROFILES.base);
  } catch (e) {
    if (e instanceof SqlRefusal && postgresOnly(stmts, ctx)) e.message = `${e.message}: ${POSTGRES_ONLY}`;
    throw e;
  }
}

export function validateIr(plan: SqlPlan, ctx: SqlContext): readonly SqlDiagnostic[] {
  const d = check(plan, ctx, PROFILES.base);
  return d.length && plan?.stmts && postgresOnly(plan.stmts as N[], ctx) ? [{ ...d[0]!, message: `${d[0]!.message}: ${POSTGRES_ONLY}` }] : d;
}
