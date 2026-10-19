/** One column/operator/value condition, spelled by the dialect. The Store and the Better Auth adapter both build theirs here. */
import type { Dialect } from "./dialect/common.js";

/** @internal */
export type Operator = "eq" | "ne" | "gt" | "gte" | "lt" | "lte" | "in" | "notIn" | "like";
const COMPARE = { gt: ">", gte: ">=", lt: "<", lte: "<=" } as const;

/**
 * `column` is already quoted. `bind` registers one parameter and returns its placeholder. `insensitive` folds both sides of
 * eq/ne/in/notIn with LOWER (text only) and picks the dialect's case-insensitive LIKE. A null eq/ne is IS [NOT] NULL.
 * `like` takes a finished pattern (`escapeLike` the literal parts).
 * @internal
 */
export function condition(d: Pick<Dialect, "like" | "likeEscape">, column: string, operator: Operator, value: unknown, bind: (value: unknown) => string, insensitive = false): string {
  const lhs = insensitive ? `LOWER(${column})` : column;
  const rhs = (v: unknown) => insensitive ? `LOWER(${bind(v)})` : bind(v);
  switch (operator) {
    case "in": case "notIn": {
      const list = Array.isArray(value) ? value : [value];
      if (!list.length) return operator === "in" ? "1 = 0" : "1 = 1";
      return `${lhs} ${operator === "in" ? "IN" : "NOT IN"} (${list.map(rhs).join(", ")})`;
    }
    case "like": return `${column} ${d.like(insensitive)} ${bind(value)}${d.likeEscape}`;
    case "eq": case "ne":
      if (value === null) return `${column} IS ${operator === "eq" ? "" : "NOT "}NULL`;
      return `${lhs} ${operator === "eq" ? "=" : "<>"} ${rhs(value)}`;
    default: return `${column} ${COMPARE[operator]} ${bind(value)}`;
  }
}
