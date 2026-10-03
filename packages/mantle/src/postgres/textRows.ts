/** Result description for transports without RowDescription (Bun.SQL).
 * PostgreSQL describes an unexecuted query through CREATE TEMP TABLE AS ... WITH NO DATA.
 * It owns OIDs/typmods, including CASE, COALESCE, CTEs and planner-folded expressions.
 */
import type { SqlNode as N } from '../spec/domain/index.js';
import { print } from './print.js';
/** PostgreSQL parse_target.c FigureColname rules for the closed Mantle expression grammar. */
function outputName(n: N | undefined): [string, number] {
  if (!n) return ['?column?', 0];
  if (n.ColumnRef) return [n.ColumnRef.fields.filter((f: N) => f.String).at(-1)?.String.sval ?? '?column?', 2];
  if (n.FuncCall) return [n.FuncCall.funcname.at(-1).String.sval, 2];
  if (n.CoalesceExpr) return ['coalesce', 2];
  if (n.MinMaxExpr) return [n.MinMaxExpr.op === 'IS_GREATEST' ? 'greatest' : 'least', 2];
  if (n.A_Expr?.kind === 'AEXPR_NULLIF') return ['nullif', 2];
  if (n.TypeCast) { const inner = outputName(n.TypeCast.arg); return inner[1] > 1 ? inner : [n.TypeCast.typeName.names.at(-1).String.sval, 1]; }
  if (n.CaseExpr) { const inner = outputName(n.CaseExpr.defresult); return inner[1] > 1 ? inner : ['case', 1]; }
  if (n.SubLink?.subLinkType === 'EXISTS_SUBLINK') return ['exists', 2];
  if (n.SubLink?.subLinkType === 'EXPR_SUBLINK') { const t = n.SubLink.subselect?.SelectStmt?.targetList?.[0]?.ResTarget; return t?.name ? [t.name, 2] : outputName(t?.val); }
  return ['?column?', 0];
}
export function describeResult(ast: N): { query: string; names: string[] | undefined } | undefined {
  const body = ast.SelectStmt ?? ast.InsertStmt ?? ast.UpdateStmt ?? ast.DeleteStmt;
  const targets: N[] | undefined = ast.SelectStmt ? body.targetList : body?.returningClause?.exprs;
  if (!targets?.length) return undefined;
  // `*` and `t.*` expand to columns only PostgreSQL knows: name none, so each column keeps its own name
  const star = targets.some((t) => t.ResTarget.val?.ColumnRef?.fields?.at(-1)?.A_Star);
  return {
    query: ast.SelectStmt ? print(ast) : `WITH _mantle_result AS (${print(ast)}) SELECT * FROM _mantle_result`,
    names: star ? undefined : targets.map((t) => t.ResTarget.name ?? outputName(t.ResTarget.val)[0]),
  };
}
