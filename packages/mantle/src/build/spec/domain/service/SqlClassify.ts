/**
 * Row op or set op, on the compiled statement (ADR-0034 decision 4). Pure over IR, so the CLI infers a Procedure's `target` with
 * the very rule the runtime uses to decide how a write is checked.
 */
import type { SqlNode as N } from "../model/SqlIr.js";

const conjuncts = (w: N | undefined): N[] => (w?.BoolExpr?.boolop === "AND_EXPR" ? w.BoolExpr.args.flatMap(conjuncts) : w ? [w] : []);
const isInput = (n: N) => n.ColumnRef?.fields?.length === 2 && n.ColumnRef.fields[0].String?.sval === "input";
const isScalar = (n: N) => !!n.A_Const || isInput(n);

/** The entry's own `id` column (`id` or `alias.id`), never `input.id`: an input that happens to be named id is a value, not the target. */
export const isIdCol = (n: N): boolean => {
  const f = n.ColumnRef?.fields;
  return !!f && f.at(-1)?.String?.sval === "id" && (f.length === 1 || (f.length === 2 && f[0].String?.sval !== "input"));
};

/** `WHERE ... id = <scalar>` or a one-row INSERT is a row op; every other write is a set op. */
export function classify(stmt: N): "read" | "row" | "set" {
  if (stmt.SelectStmt) return "read";
  // ON CONFLICT is a set op: a DO NOTHING that hits the conflict must not fail with CONFLICT
  if (stmt.InsertStmt) return stmt.InsertStmt.selectStmt?.SelectStmt?.valuesLists?.length === 1 && !stmt.InsertStmt.onConflictClause ? "row" : "set";
  const eqs = conjuncts((stmt.UpdateStmt ?? stmt.DeleteStmt).whereClause).filter((x) => x.A_Expr?.kind === "AEXPR_OP" && x.A_Expr.name[0].String.sval === "=");
  return eqs.some((x) => (isIdCol(x.A_Expr.lexpr) && isScalar(x.A_Expr.rexpr)) || (isIdCol(x.A_Expr.rexpr) && isScalar(x.A_Expr.lexpr))) ? "row" : "set";
}

/**
 * What an update or delete pins: the Schema, the input that carries the id, and the input that carries the version when the
 * statement is locked (`version = input.x`, ADR-0022). Undefined when the id is pinned to a literal or not at all.
 */
export function pinnedTarget(stmt: N): { schema: string; id: string; version?: string } | undefined {
  const body = stmt.UpdateStmt ?? stmt.DeleteStmt;
  if (!body || classify(stmt) !== "row") return undefined;
  const eqs = conjuncts(body.whereClause).filter((x) => x.A_Expr?.kind === "AEXPR_OP" && x.A_Expr.name[0].String.sval === "=");
  const name = (n: N) => n.ColumnRef.fields[1].String.sval as string;
  const idEq = eqs.find((x) => (isIdCol(x.A_Expr.lexpr) && isInput(x.A_Expr.rexpr)) || (isIdCol(x.A_Expr.rexpr) && isInput(x.A_Expr.lexpr)));
  if (!idEq) return undefined;
  const verEq = eqs.find((x) => {
    const col = (n: N) => n.ColumnRef?.fields?.at(-1)?.String?.sval === "version" && !isInput(n);
    return (col(x.A_Expr.lexpr) && isInput(x.A_Expr.rexpr)) || (col(x.A_Expr.rexpr) && isInput(x.A_Expr.lexpr));
  });
  return {
    schema: body.relation.relname,
    id: name(isInput(idEq.A_Expr.rexpr) ? idEq.A_Expr.rexpr : idEq.A_Expr.lexpr),
    ...(verEq ? { version: name(isInput(verEq.A_Expr.rexpr) ? verEq.A_Expr.rexpr : verEq.A_Expr.lexpr) } : {}),
  };
}
