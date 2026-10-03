/** Builders for the IR nodes Core writes itself (policy fills, Store's JSON converter, the runner's pre-reads, the TTL sweep). */
import type { SqlNode as N } from "../../spec/domain/index.js";

export const S = (s: string) => ({ String: { sval: s } });
/** `ref("t", "id")` is `t.id`. */
export const ref = (...f: string[]): N => ({ ColumnRef: { fields: f.map(S) } });
export const op = (o: string, l: N, r: N): N => ({ A_Expr: { kind: "AEXPR_OP", name: [S(o)], lexpr: l, rexpr: r } });
/** Integers past int32 must be `fval` in libpg-query's shape; 0 must keep its `ival` key. */
export const num = (n: number): N => (Number.isSafeInteger(n) && Math.abs(n) < 2 ** 31 ? { A_Const: { ival: { ival: n } } } : { A_Const: { fval: { fval: String(n) } } });
export const target = (val: N, name?: string): N => ({ ResTarget: name ? { name, val } : { val } });
/** A relation as the CLI tags it: a Schema `table`, or `system` for Core's own (never reachable from author IR). */
export const table = (relname: string, mantle: "table" | "system" = "table"): N => ({ relname, inh: true, relpersistence: "p", mantle });

/** Nodes that print as one unit on both engines; anything else is an expression a printer must parenthesize as an operand. */
const ATOMIC = new Set(["ColumnRef", "A_Const", "ParamRef", "FuncCall", "TypeCast", "CaseExpr", "CoalesceExpr", "MinMaxExpr", "Raw"]);
const atomic = (x: N | undefined) => !x || typeof x !== "object" || Object.keys(x).some((k) => ATOMIC.has(k)) ||
  (x.SubLink && ["EXPR_SUBLINK", "ARRAY_SUBLINK"].includes(x.SubLink.subLinkType));
/** `x` in parentheses: the printers' `Raw` prints its parts inside `( )`. */
export const paren = (x: N | undefined) => (atomic(x) ? x : { Raw: { parts: [x] } });

/**
 * An operator, test or `IN (subquery)` with each non-atomic operand in parentheses. pgsql-deparser prints the operands of BETWEEN,
 * LIKE, IN and IS as written, so a nested condition there would read as another expression (SQLite groups `a BETWEEN 0 AND b IN
 * (...)` left to right) or not parse (PostgreSQL). Both printers pass every A_Expr, NullTest, BooleanTest and SubLink through it.
 */
export function parenthesized(key: "A_Expr" | "NullTest" | "BooleanTest" | "SubLink", n: N): N {
  if (key === "NullTest" || key === "BooleanTest") return { ...n, arg: paren(n.arg) };
  if (key === "SubLink") return n.testexpr ? { ...n, testexpr: paren(n.testexpr) } : n;
  const r = n.rexpr;
  const rexpr = r?.List ? { List: { ...r.List, items: r.List.items.map(paren) } }
    : r?.FuncCall && r.FuncCall.funcname?.at(-1)?.String?.sval === "like_escape" ? { FuncCall: { ...r.FuncCall, args: r.FuncCall.args?.map(paren) } }
    : paren(r);
  return { ...n, ...(n.lexpr ? { lexpr: paren(n.lexpr) } : {}), ...(r ? { rexpr } : {}) };
}
