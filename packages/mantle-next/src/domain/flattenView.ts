import type { SqlNode } from "@aotter/mantle/spec";

/** Flatten only the canonical, identity-projecting policy wrapper at a View's root. */
export function flattenView(ast: SqlNode, schemas: Readonly<Record<string, { readonly fields: Readonly<Record<string, unknown>>; readonly scope?: string }>>): SqlNode {
  const root = ast.SelectStmt;
  const wrapper = root?.fromClause?.length === 1 && root.fromClause[0]?.RangeSubselect;
  const inner = wrapper?.subquery?.SelectStmt;
  const relation = inner?.fromClause?.length === 1 && inner.fromClause[0]?.RangeVar;
  const alias = wrapper?.alias?.aliasname;
  if (!root || !inner || !relation || !alias || root.withClause || root.lockingClause || root.larg || root.rarg || (root.op && root.op !== "SETOP_NONE") || wrapper.lateral || wrapper.alias.colnames ||
      relation.mantle !== "system" || !Object.hasOwn(schemas, relation.relname) || relation.alias || relation.schemaname) return ast;
  const allowedInner = new Set(["targetList", "fromClause", "whereClause", "limitOption", "op", "location"]);
  if (Object.keys(inner).some(k => !allowedInner.has(k)) ||
      (inner.op && inner.op !== "SETOP_NONE") ||
      (inner.limitOption && inner.limitOption !== "LIMIT_OPTION_DEFAULT") || !inner.targetList?.length) return ast;
  const exposed = new Set<string>();
  const schema = schemas[relation.relname]!;
  for (const target of inner.targetList) {
    const t = target.ResTarget;
    const fields = t?.val?.ColumnRef?.fields;
    const name = fields?.length === 1 && fields[0]?.String?.sval;
    if (!name || (t.name && t.name !== name) || exposed.has(name)) return ast;
    exposed.add(name);
  }
  const physicalColumns = new Set([...exposed, ...(schema.scope ? [schema.scope] : [])]);
  let safe = true;
  const inspect = (value: any, physical: boolean): void => {
    if (Array.isArray(value)) { value.forEach(v => inspect(v, physical)); return; }
    if (!value || typeof value !== "object") return;
    if (value.SelectStmt || value.SubLink || value.WithClause || value.CommonTableExpr || value.Raw || value.RangeVar || value.RangeSubselect || value.A_Star) { safe = false; return; }
    if (value.ColumnRef) {
      const f = value.ColumnRef.fields;
      if (f?.length !== 2 || f[0]?.String?.sval !== (physical ? relation.relname : alias) || !f[1]?.String?.sval || !(physical ? physicalColumns : exposed).has(f[1].String.sval)) safe = false;
      return;
    }
    Object.values(value).forEach(v => inspect(v, physical));
  };
  const { fromClause: _from, ...outer } = root;
  inspect(outer, false);
  inspect(inner.whereClause, true);
  if (!safe) return ast;
  const rename = (value: any): any => {
    if (Array.isArray(value)) return value.map(rename);
    if (!value || typeof value !== "object") return value;
    if (value.ColumnRef) return { ...value, ColumnRef: { ...value.ColumnRef, fields: [{ String: { sval: alias } }, value.ColumnRef.fields[1]] } };
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rename(v)]));
  };
  const policy = rename(inner.whereClause);
  const whereClause = root.whereClause && policy ? { BoolExpr: { boolop: "AND_EXPR", args: [root.whereClause, policy] } } : root.whereClause ?? policy;
  return { ...ast, SelectStmt: { ...root, fromClause: [{ RangeVar: { ...relation, alias: { aliasname: alias } } }], ...(whereClause ? { whereClause } : {}) } };
}
