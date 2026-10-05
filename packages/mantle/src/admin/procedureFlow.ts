/** A static projection of authored SQL IR. CASE chooses values; WHERE filters rows, not control flow. */
import { classify, type JsonSchema, type SqlNode } from '../spec/domain/index.js';

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
      logic: sqlLogic(stmt),
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

/** A syntax/data dependency tree, never a promise of SQL evaluation order or short-circuit execution. */
export interface SqlLogicNode {
  kind: string; label: string; children: SqlLogicNode[];
  column?: { name: string; relation?: string };
  relation?: { name: string; alias?: string };
}
const branch = (kind: string, label: string, children: SqlLogicNode[] = []): SqlLogicNode => ({ kind, label, children });
export function sqlLogic(node: SqlNode): SqlLogicNode {
  const list = (items: SqlNode[] = []) => items.map(sqlLogic);
  const clause = (label: string, value: SqlNode | undefined) => value ? [branch('clause', label, [sqlLogic(value)])] : [];
  const group = (label: string, values: SqlNode[] | undefined) => values?.length ? [branch('clause', label, list(values))] : [];
  if (node.ColumnRef) {
    const names = node.ColumnRef.fields.map((f: SqlNode) => f.String?.sval);
    const result = branch('value', sql(node));
    if (names.every((n: unknown) => typeof n === 'string') && names.length <= 2) result.column = { name: names.at(-1)!, ...(names.length === 2 ? { relation: names[0] } : {}) };
    return result;
  }
  if (node.BoolExpr) { const b = node.BoolExpr; return branch('predicate', b.boolop === 'AND_EXPR' ? 'AND · all conditions' : b.boolop === 'OR_EXPR' ? 'OR · any condition' : 'NOT', list(b.args)); }
  if (node.A_Expr) {
    const e = node.A_Expr;
    const names: Record<string, string> = { AEXPR_OP_ANY: `${e.name?.[0]?.String?.sval} ANY`, AEXPR_OP_ALL: `${e.name?.[0]?.String?.sval} ALL`, AEXPR_BETWEEN_SYM: 'BETWEEN SYMMETRIC', AEXPR_NOT_BETWEEN_SYM: 'NOT BETWEEN SYMMETRIC', AEXPR_IN: e.name?.[0]?.String?.sval === '<>' ? 'NOT IN' : 'IN', AEXPR_BETWEEN: 'BETWEEN', AEXPR_NOT_BETWEEN: 'NOT BETWEEN', AEXPR_DISTINCT: 'IS DISTINCT FROM', AEXPR_NOT_DISTINCT: 'IS NOT DISTINCT FROM', AEXPR_LIKE: e.name?.[0]?.String?.sval === '!~~' ? 'NOT LIKE' : 'LIKE', AEXPR_ILIKE: e.name?.[0]?.String?.sval === '!~~*' ? 'NOT ILIKE' : 'ILIKE', AEXPR_NULLIF: 'NULLIF' };
    return branch('expression', names[e.kind] ?? e.name?.map((n: SqlNode) => n.String.sval).join('.') ?? e.kind, [e.lexpr, e.rexpr].filter(Boolean).map(sqlLogic));
  }
  if (node.NullTest) return branch('predicate', node.NullTest.nulltesttype === 'IS_NOT_NULL' ? 'IS NOT NULL' : 'IS NULL', [sqlLogic(node.NullTest.arg)]);
  if (node.BooleanTest) return branch('predicate', node.BooleanTest.booltesttype.replaceAll('_', ' '), [sqlLogic(node.BooleanTest.arg)]);
  if (node.CaseExpr) {
    const c = node.CaseExpr;
    return branch('case', c.arg ? 'CASE · match value' : 'CASE · first TRUE condition', [...clause('Value', c.arg), ...(c.args ?? []).map((w: SqlNode, i: number) => branch('when', `WHEN ${i + 1}`, [branch('predicate', 'Condition', [sqlLogic(w.CaseWhen.expr)]), branch('value', 'THEN', [sqlLogic(w.CaseWhen.result)])])), branch('value', 'ELSE', [c.defresult ? sqlLogic(c.defresult) : branch('value', 'NULL')])]);
  }
  if (node.SubLink) { const s = node.SubLink; return branch('subquery', s.subLinkType === 'ANY_SUBLINK' ? 'IN' : s.subLinkType.replace('_SUBLINK', ''), [...clause('Compared value', s.testexpr), sqlLogic(s.subselect)]); }
  if (node.FuncCall) {
    const f = node.FuncCall;
    return branch('function', f.funcname.map((n: SqlNode) => n.String.sval).join('.') + (f.agg_distinct ? ' · DISTINCT' : '') + (f.agg_star ? '(*)' : ''), [...list(f.args), ...group('Aggregate ORDER BY', f.agg_order), ...clause('FILTER', f.agg_filter), ...clause('OVER', f.over ? { WindowDef: f.over } : undefined)]);
  }
  if (node.CoalesceExpr) return branch('function', 'COALESCE · first non-NULL value', list(node.CoalesceExpr.args));
  if (node.MinMaxExpr) return branch('function', node.MinMaxExpr.op === 'IS_GREATEST' ? 'GREATEST' : 'LEAST', list(node.MinMaxExpr.args));
  if (node.TypeCast) { const t = node.TypeCast; return branch('cast', `CAST → ${t.typeName.names.map((n: SqlNode) => n.String.sval).join('.')}${t.typeName.typmods?.length ? t.typeName.names.at(-1)?.String?.sval === 'numeric' ? `(${t.typeName.typmods.map(sql).join(', ')})` : ' · type modifiers: see authored SQL' : ''}`, [sqlLogic(t.arg)]); }
  if (node.List) return branch('list', 'Values', list(node.List.items));
  if (node.ResTarget) return branch('output', node.ResTarget.name ?? 'Output', node.ResTarget.val ? [sqlLogic(node.ResTarget.val)] : []);
  if (node.SortBy) return branch('order', `${(node.SortBy.sortby_dir ?? 'SORTBY_DEFAULT').replace('SORTBY_', '')} · ${(node.SortBy.sortby_nulls ?? 'SORTBY_NULLS_DEFAULT').replace('SORTBY_', '')}`, [sqlLogic(node.SortBy.node)]);
  if (node.RangeVar) return { ...branch('table', node.RangeVar.relname + (node.RangeVar.alias ? ` AS ${node.RangeVar.alias.aliasname}` : '')), relation: { name: node.RangeVar.relname, ...(node.RangeVar.alias ? { alias: node.RangeVar.alias.aliasname } : {}) } };
  if (node.RangeSubselect) return branch('subquery', `${node.RangeSubselect.lateral ? 'LATERAL ' : ''}${node.RangeSubselect.alias?.aliasname ?? 'Subquery'}`, [sqlLogic(node.RangeSubselect.subquery)]);
  if (node.JoinExpr) { const j = node.JoinExpr; return branch('join', `${j.jointype.replace('JOIN_', '')} JOIN`, [sqlLogic(j.larg), sqlLogic(j.rarg), ...clause('ON', j.quals), ...group('USING', j.usingClause)]); }
  if (node.WindowDef) { const w = node.WindowDef; return branch('window', `Window${w.name ? ` ${w.name}` : ''} · ${w.frameOptions & 4 ? 'ROWS' : 'RANGE'} frame (see authored SQL)`, [...group('PARTITION BY', w.partitionClause), ...group('ORDER BY', w.orderClause), ...clause('Frame start', w.startOffset), ...clause('Frame end', w.endOffset)]); }
  if (node.CommonTableExpr) return branch('cte', node.CommonTableExpr.ctename, [sqlLogic(node.CommonTableExpr.ctequery)]);
  const key = ['SelectStmt', 'UpdateStmt', 'InsertStmt', 'DeleteStmt'].find((k) => node[k]);
  if (key) {
    const b = node[key];
    const children = [...group(b.withClause?.recursive ? 'WITH RECURSIVE' : 'WITH', b.withClause?.ctes), ...(b.relation ? [branch('target', 'Target', [sqlLogic({ RangeVar: b.relation })])] : []), ...group(key === 'UpdateStmt' ? 'SET' : 'SELECT', b.targetList), ...group('FROM', b.fromClause ?? b.usingClause), ...clause('WHERE · keep TRUE rows', b.whereClause), ...group('GROUP BY', b.groupClause), ...clause('HAVING · keep TRUE groups', b.havingClause), ...group('ORDER BY', b.sortClause), ...clause('LIMIT', b.limitCount), ...group('VALUES', b.valuesLists), ...group('Columns', b.cols), ...clause('Source SELECT', b.selectStmt), ...group('RETURNING', b.returningClause?.exprs)];
    if (b.distinctClause) children.push(branch('clause', b.distinctClause.some((n: SqlNode) => n && Object.keys(n).length) ? 'DISTINCT ON' : 'DISTINCT', list(b.distinctClause.filter((n: SqlNode) => n && Object.keys(n).length))));
    if (b.op && b.op !== 'SETOP_NONE') children.push(branch('set', b.op.replace('SETOP_', '') + (b.all ? ' ALL' : ''), [sqlLogic({ SelectStmt: b.larg }), sqlLogic({ SelectStmt: b.rarg })]));
    if (b.onConflictClause) { const c = b.onConflictClause; children.push(branch('conflict', `ON CONFLICT · ${c.action.replace('ONCONFLICT_', '')}`, [...group('Conflict columns', c.infer?.indexElems), ...group('SET', c.targetList), ...clause('WHERE', c.whereClause)])); }
    return branch('statement', key.replace('Stmt', '').toUpperCase(), children);
  }
  if (node.String) return branch('value', node.String.sval);
  if (node.IndexElem) return branch('column', node.IndexElem.name);
  const rendered = sql(node);
  return branch(rendered.startsWith('[SQL') ? 'opaque' : 'value', rendered.startsWith('[SQL') ? `${Object.keys(node)[0]} · see authored SQL` : rendered);
}

/** Necessary enum predicates for a declared row target; a display hint, never authorization. */
export function requiredEnumStates(stmts: readonly SqlNode[], target: string, schema: JsonSchema): Array<{ field: string; value: string }> {
  const writes = procedureFlow(stmts).filter((s) => s.table?.toLowerCase() === target.toLowerCase() && s.operation === 'UPDATE');
  if (writes.length !== 1 || writes[0]!.mode !== 'row') return [];
  const tree = writes[0]!.logic;
  const relation = tree.children.find((c) => c.label === 'Target')?.children[0]?.relation;
  const filter = tree.children.find((c) => c.label.startsWith('WHERE'))?.children[0];
  const required = (n: SqlLogicNode): SqlLogicNode[] => n.kind === 'predicate' && n.label.startsWith('AND ·') ? n.children.flatMap(required) : [n];
  return (filter ? required(filter) : []).flatMap((n) => {
    if (n.kind !== 'expression' || n.label !== '=' || n.children.length !== 2) return [];
    const match = (column: SqlLogicNode, literal: SqlLogicNode) => {
      const ref = column.column;
      if (!ref || ref.relation && ref.relation.toLowerCase() !== (relation?.alias ?? target).toLowerCase() || literal.column || literal.kind !== 'value' || !/^'.*'$/.test(literal.label)) return [];
      const field = Object.keys(schema.properties ?? {}).find((k) => k.toLowerCase() === ref.name.toLowerCase());
      if (!field) return [];
      const value = literal.label.slice(1, -1).replace(/''/g, "'");
      const property = schema.properties![field];
      const options = property.enum ?? property.oneOf?.map((o: { const?: unknown }) => o.const);
      return Array.isArray(options) && options.includes(value) ? [{ field, value }] : [];
    };
    return [...match(n.children[0]!, n.children[1]!), ...match(n.children[1]!, n.children[0]!)];
  });
}
