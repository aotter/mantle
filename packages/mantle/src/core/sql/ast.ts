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
