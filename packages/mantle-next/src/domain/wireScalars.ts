import type { RuntimePlan, SqlNode } from "@aotter/mantle/compiler";
import type { Dialect } from "../kernel/dialect/common.js";
import { declaredType } from "./columns.js";

const raw = (...parts: (string | SqlNode)[]): SqlNode => ({ Raw: { parts } });

type WireDialect = Pick<Dialect, "wireTimestamp" | "wireDate" | "wireInteger">;
/** A declared scalar in its wire form, formatted before a native driver can lose precision. */
const wire = (type: string | undefined, d: WireDialect, v: SqlNode): SqlNode | undefined =>
  type === "timestamptz" ? raw(...d.wireTimestamp(v)) : type === "date" ? raw(...d.wireDate(v)) : type && ["integer", "int4", "int8"].includes(type) ? raw(...d.wireInteger(v)) : undefined;

/**
 * Wraps declared outputs of a View's top-level SELECT, keeping their names and original numeric sort expressions.
 * Returns a refusal when the outputs cannot be matched to SELECT items by position.
 */
export function wireScalars(ast: SqlNode, keys: readonly string[], types: readonly (string | undefined)[], d: WireDialect): SqlNode | string {
  if (!types.some(type => type && ["timestamptz", "date", "integer", "int4", "int8"].includes(type)) || !ast.SelectStmt) return ast;
  const select = (s: SqlNode): SqlNode | string => {
    if (s.op && s.op !== "SETOP_NONE") {
      const larg = select(s.larg), rarg = select(s.rarg);
      return typeof larg === "string" ? larg : typeof rarg === "string" ? rarg : { ...s, larg, rarg };
    }
    if (s.targetList?.length !== keys.length || s.targetList.some((t: SqlNode) => !t.ResTarget || t.ResTarget.val?.ColumnRef?.fields?.at(-1)?.A_Star)) return "Declared scalar outputs need one SELECT item per output. Expand the SELECT list explicitly.";
    const targetList = s.targetList.map((t: SqlNode, i: number) => {
      const val = wire(types[i], d, t.ResTarget.val);
      return val ? { ResTarget: { ...t.ResTarget, name: keys[i], val } } : t;
    });
    const sortClause = s.sortClause?.map((t: SqlNode) => {
      const node = t.SortBy.node, fields = node.ColumnRef?.fields;
      const index = fields?.length === 1 ? keys.indexOf(fields[0].String?.sval) : node.A_Const?.ival ? node.A_Const.ival.ival - 1 : -1;
      if (index < 0 || targetList[index] === s.targetList[index]) return t;
      let value = s.targetList[index].ResTarget.val;
      const from = s.fromClause?.[0], alias = from?.RangeVar?.alias?.aliasname ?? from?.RangeVar?.relname ?? from?.RangeSubselect?.alias?.aliasname;
      // A bare column in ORDER BY still resolves to an output alias: qualify the original input column.
      if (value.ColumnRef?.fields?.length === 1 && alias) value = { ColumnRef: { fields: [{ String: { sval: alias } }, ...value.ColumnRef.fields] } };
      return { SortBy: { ...t.SortBy, node: value } };
    });
    return { ...s, targetList, ...(sortClause ? { sortClause } : {}) };
  };
  const out = select(ast.SelectStmt);
  return typeof out === "string" ? out : { ...ast, SelectStmt: out };
}

/** The same wire form for a write's RETURNING list (Core has already expanded `*`): a column of the written table is wrapped by its declared type. */
export function wireReturning(ast: SqlNode, schemas: RuntimePlan["schemas"], d: WireDialect): SqlNode {
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
