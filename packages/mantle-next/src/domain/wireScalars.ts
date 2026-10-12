import type { RuntimePlan, SqlNode } from "@aotter/mantle/spec";
import type { Dialect } from "../kernel/dialect/common.js";
import { declaredType } from "./columns.js";

const raw = (...parts: (string | SqlNode)[]): SqlNode => ({ Raw: { parts } });

/** A declared timestamp or date in its wire form, spelled by the dialect and formatted by the database. */
const wire = (type: string | undefined, d: Pick<Dialect, "wireTimestamp" | "wireDate">, v: SqlNode): SqlNode | undefined =>
  type === "timestamptz" ? raw(...d.wireTimestamp(v)) : type === "date" ? raw(...d.wireDate(v)) : undefined;

/**
 * Wraps the declared timestamp and date outputs of a View's top-level SELECT (each branch of a set operation), keeping
 * their names. An ORDER BY that resolves to the output column still sorts correctly: these strings sort as their values.
 * Returns a refusal when the outputs cannot be matched to SELECT items by position.
 */
export function wireScalars(ast: SqlNode, keys: readonly string[], types: readonly (string | undefined)[], d: Pick<Dialect, "wireTimestamp" | "wireDate">): SqlNode | string {
  if (!types.some(type => type === "timestamptz" || type === "date") || !ast.SelectStmt) return ast;
  const select = (s: SqlNode): SqlNode | string => {
    if (s.op && s.op !== "SETOP_NONE") {
      const larg = select(s.larg), rarg = select(s.rarg);
      return typeof larg === "string" ? larg : typeof rarg === "string" ? rarg : { ...s, larg, rarg };
    }
    if (s.targetList?.length !== keys.length || s.targetList.some((t: SqlNode) => !t.ResTarget || t.ResTarget.val?.ColumnRef?.fields?.at(-1)?.A_Star)) return "Declared timestamp and date outputs need one SELECT item per output. Expand the SELECT list explicitly.";
    return { ...s, targetList: s.targetList.map((t: SqlNode, i: number) => {
      const val = wire(types[i], d, t.ResTarget.val);
      return val ? { ResTarget: { ...t.ResTarget, name: keys[i], val } } : t;
    }) };
  };
  const out = select(ast.SelectStmt);
  return typeof out === "string" ? out : { ...ast, SelectStmt: out };
}

/** The same wire form for a write's RETURNING list (Core has already expanded `*`): a column of the written table is wrapped by its declared type. */
export function wireReturning(ast: SqlNode, schemas: RuntimePlan["schemas"], d: Pick<Dialect, "wireTimestamp" | "wireDate">): SqlNode {
  const [kind, stmt] = Object.entries(ast)[0] ?? [];
  const list = stmt?.returningClause?.exprs;
  if (!list?.length || !["InsertStmt", "UpdateStmt", "DeleteStmt"].includes(kind!)) return ast;
  const schema = schemas[stmt.relation?.relname];
  if (!schema) return ast;
  let changed = false;
  const exprs = [];
  for (const t of list) {
    const fields = t.ResTarget?.val?.ColumnRef?.fields;
    const col = fields?.at(-1)?.String?.sval;
    const val = col === undefined ? undefined : wire(declaredType(schema.fields, col), d, t.ResTarget.val);
    if (val) changed = true;
    exprs.push(val ? { ResTarget: { ...t.ResTarget, name: t.ResTarget.name ?? col, val } } : t);
  }
  return changed ? { [kind!]: { ...stmt, returningClause: { ...stmt.returningClause, exprs } } } : ast;
}
