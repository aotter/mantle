/** A static projection of authored SQL IR. CASE chooses values; WHERE filters rows, not control flow. */
import { classify, type SqlNode } from '../spec/domain/index.js';

/** Display only constructs we can spell exactly. Other expressions stay explicitly opaque beside the authored SQL. */
function expression(node: SqlNode | undefined): string {
  if (!node) return 'NULL';
  if (node.ColumnRef) return node.ColumnRef.fields.map((f: SqlNode) => f.String ? f.String.sval : '*').join('.');
  const c = node.A_Const;
  if (c) {
    if (c.isnull) return 'NULL';
    if (c.sval) return `'${c.sval.sval.replace(/'/g, "''")}'`;
    if (c.ival) return String(c.ival.ival ?? 0);
    if (c.fval) return c.fval.fval;
    if (c.boolval) return c.boolval.boolval ? 'TRUE' : 'FALSE';
  }
  const e = node.A_Expr;
  if (e?.kind === 'AEXPR_OP' && e.name?.length === 1) {
    const operand = (v: SqlNode) => v.A_Expr || v.BoolExpr ? `(${expression(v)})` : expression(v);
    const op = e.name[0].String.sval;
    if (!e.lexpr && e.rexpr) return `${op}(${expression(e.rexpr)})`;
    if (e.lexpr && e.rexpr) return `${operand(e.lexpr)} ${op} ${operand(e.rexpr)}`;
  }
  if (node.BoolExpr) {
    const b = node.BoolExpr;
    if (b.boolop === 'NOT_EXPR') return `NOT (${expression(b.args[0])})`;
    return b.args.map((a: SqlNode) => `(${expression(a)})`).join(b.boolop === 'AND_EXPR' ? ' AND ' : ' OR ');
  }
  throw new Error('opaque');
}
const sql = (node: SqlNode | undefined): string => {
  try { return expression(node); } catch { return '[SQL expression — see authored SQL]'; }
};

export function procedureFlow(stmts: readonly SqlNode[], relations?: (stmts: readonly SqlNode[]) => { reads: Set<string>; writes: Set<string> }) {
  return stmts.map((stmt, index) => {
    const [operation, body] = Object.entries(stmt)[0]!;
    const assignments = operation === 'UpdateStmt' ? body.targetList ?? [] : [];
    const dependencies = relations?.([stmt]);
    return {
      index,
      operation: operation.replace('Stmt', '').toUpperCase(),
      table: body.relation?.relname ?? null,
      mode: operation === 'MergeStmt' ? 'set' : classify(stmt),
      reads: [...(dependencies?.reads ?? [])].sort(),
      writes: [...(dependencies?.writes ?? [])].sort(),
      filter: body.whereClause ? sql(body.whereClause) : body.selectStmt?.SelectStmt?.whereClause ? sql(body.selectStmt.SelectStmt.whereClause) : null,
      returns: (body.returningClause?.exprs ?? []).map((t: SqlNode) => sql(t.ResTarget.val)),
      cases: assignments.flatMap(({ ResTarget: target }: SqlNode) => {
        const c = target.val?.CaseExpr;
        if (!c) return [];
        return [{
          field: target.name,
          branches: (c.args ?? []).map(({ CaseWhen: w }: SqlNode) => ({ condition: c.arg ? `(${sql(c.arg)}) = (${sql(w.expr)})` : sql(w.expr), value: sql(w.result) })),
          otherwise: sql(c.defresult),
        }];
      }),
    };
  });
}
