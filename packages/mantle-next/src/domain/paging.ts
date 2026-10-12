/** Build-time proofs for the compiler's keyset keys. No AST reaches a generated operation. */
import { NATIVE_NOT_NULL, notNullColumns, type RuntimePlan, type PlanSchema, type SqlNode } from "@aotter/mantle/spec";
import { declaredType } from "./columns.js";

type Field = { schema: PlanSchema; name: string; type: string; notNull: boolean };
type Relation = { fields: Map<string, Field>; single: boolean; unique: boolean; fixed: Set<string> };
export type PagingProof = { types: string[]; single: boolean };
const fieldName = (n: SqlNode) => n.ColumnRef?.fields?.at(-1)?.String?.sval;
const scalar = (n: SqlNode): boolean => !!(n.ParamRef || n.A_Const || n.TypeCast && scalar(n.TypeCast.arg));
const aggregate = (n: SqlNode): boolean => !!n && !n.SubLink && !n.SelectStmt && (n.FuncCall && !n.FuncCall.over && ["count", "sum", "min", "max", "avg"].includes(n.FuncCall.funcname?.at(-1)?.String?.sval) || Object.values(n).some(v => v && typeof v === "object" && (Array.isArray(v) ? v.some(aggregate) : aggregate(v))));

/** Only complete grouped tuples, base ids and non-fanning singleton joins are proved. */
export function provePaging(plan: RuntimePlan, ast: SqlNode): PagingProof | undefined {
  const ctes = new Map<string, Relation | undefined>();
  const select = (s: SqlNode): { relation: Relation; keys: Field[] } | undefined => {
    if (!s || s.distinctClause || s.op && s.op !== "SETOP_NONE") return;
    for (const c of s.withClause?.ctes ?? []) {
      const n = c.CommonTableExpr;
      ctes.set(n.ctename, undefined);
      ctes.set(n.ctename, select(n.ctequery.SelectStmt)?.relation);
    }
    const aliases = new Map<string, Relation>();
    const reduced = !!s.groupClause?.length || (s.targetList ?? []).some((t: SqlNode) => aggregate(t.ResTarget.val));
    const relation = (n: SqlNode): Relation | undefined => {
      if (n.JoinExpr) {
        const left = relation(n.JoinExpr.larg), right = relation(n.JoinExpr.rarg);
        if (!left || !right || !left.single && !right.single && !reduced) return;
        if (n.JoinExpr.jointype === "JOIN_FULL" || n.JoinExpr.jointype === "JOIN_RIGHT") return;
        // The right side of LEFT JOIN may be absent: its fields cannot become NOT NULL cursor keys.
        if (n.JoinExpr.jointype === "JOIN_LEFT") for (const r of aliases.values()) if (r === right) r.fields = new Map([...r.fields].map(([k, f]) => [k, { ...f, notNull: false }]));
        return !left.single && !right.single ? { ...left, unique: false } : left.single ? right : left;
      }
      const r = n.RangeVar, sub = n.RangeSubselect;
      let fact: Relation | undefined;
      if (r && plan.schemas[r.relname]) {
        const schema = plan.schemas[r.relname]!, notNull = notNullColumns(schema);
        const fields = new Map<string, Field>();
        for (const name of [...Object.keys(schema.fields), "id", "version", "created_at", "updated_at", "author_id", "status"]) {
          const type = declaredType(schema.fields, name) ?? (name === "version" ? "integer" : "text");
          fields.set(name, { schema, name, type, notNull: NATIVE_NOT_NULL.has(name) || notNull.has(name) });
        }
        fact = { fields, single: false, unique: true, fixed: new Set(schema.scope ? [schema.scope] : []) };
      } else if (r) fact = ctes.get(r.relname);
      else if (sub) fact = select(sub.subquery.SelectStmt)?.relation;
      if (fact) {
        fact = { ...fact, fields: new Map(fact.fields), fixed: new Set(fact.fixed) };
        aliases.set(r?.alias?.aliasname ?? r?.relname ?? sub.alias.aliasname, fact);
      }
      return fact;
    };
    const from = s.fromClause ?? [];
    let base: Relation | undefined;
    for (const n of from) {
      const r = relation(n);
      if (!r || base && !base.single && !r.single) return;
      if (!base || !r.single) base = r;
    }
    base ??= { fields: new Map(), single: true, unique: false, fixed: new Set() };
    const targets = new Map<string, SqlNode>((s.targetList ?? []).map((t: SqlNode) => [t.ResTarget.name ?? fieldName(t.ResTarget.val), t.ResTarget.val]));
    const resolve = (n: SqlNode, output = true): Field | undefined => {
      const fields = n?.ColumnRef?.fields;
      if (fields?.every((f: SqlNode) => f.String) && fields.length <= 2) {
        const name = fieldName(n)!;
        if (fields.length === 2) return aliases.get(fields[0].String.sval)?.fields.get(name);
        if (output && targets.has(name)) return resolve(targets.get(name)!, false);
        const matches = [...aliases.values()].map(r => r.fields.get(name)).filter(Boolean);
        return matches.length === 1 ? matches[0] : undefined;
      }
      const f = n?.FuncCall;
      if (f && ["min", "max"].includes(f.funcname?.at(-1)?.String?.sval) && f.args?.length === 1 && s.groupClause?.length) return resolve(f.args[0], false);
      const pos = n?.A_Const?.ival?.ival;
      if (output && pos > 0) return resolve(s.targetList[pos - 1]?.ResTarget.val, false);
      return;
    };
    const fixed = (n: SqlNode): void => {
      if (n?.BoolExpr?.boolop === "AND_EXPR") n.BoolExpr.args.forEach(fixed);
      const e = n?.A_Expr;
      if (e?.name?.[0]?.String?.sval !== "=") return;
      const col = scalar(e.rexpr) ? resolve(e.lexpr, false) : scalar(e.lexpr) ? resolve(e.rexpr, false) : undefined;
      if (col && [...base!.fields.values()].some(f => f.name === col.name && f.schema.name === col.schema.name)) base!.fixed.add(col.name);
    };
    fixed(s.whereClause);
    const fields = new Map<string, Field>();
    for (const [name, expr] of targets) { const field = resolve(expr, false); if (field && name) fields.set(name, field); }
    const group: SqlNode[] = s.groupClause ?? [], sorts: SqlNode[] = s.sortClause ?? [];
    const keys = sorts.map(k => resolve(k.SortBy.node));
    if (keys.some(k => !k?.notNull || !["text", "bool", "integer", "int4", "int8", "real", "float8", "date", "timestamptz"].includes(k.type) && !/^numeric\(/.test(k.type))) return;
    const same = (a: Field | undefined, b: Field | undefined) => a && b && a.name === b.name && a.schema.name === b.schema.name;
    if (sorts.length) {
      if (group.length) {
        // Full GROUP BY keys, not an id from an arbitrary row in the group, make the result unique.
        if (!group.every(g => { const f = resolve(g); return f?.notNull && keys.some(k => same(k, f)); })) return;
      } else {
        if (!base.unique || !keys.some(k => same(k, base.fields.get("id")))) return;
        const order = keys.filter(k => k!.name !== "id") as Field[];
        if (order.length) {
          const schema = order[0]!.schema;
          if (order.some(f => f.schema.name !== schema.name)) return;
          const indexed = [...(schema.indexes ?? []), ...(schema.unique ?? [])].some(index => {
            let i = 0;
            while (i < index.length && base!.fixed.has(index[i]!)) i++;
            return order.every((f, n) => index[i + n] === f.name);
          });
          if (!indexed) return;
        }
      }
    }
    const single = base.single || !group.length && (s.targetList ?? []).some((t: SqlNode) => aggregate(t.ResTarget.val)) || s.limitCount?.A_Const?.ival?.ival === 1 || base.unique && base.fixed.has("id");
    return { relation: { fields, single, unique: !group.length && base.unique && !!same(fields.get("id"), base.fields.get("id")), fixed: base.fixed }, keys: keys as Field[] };
  };
  const result = select(ast.SelectStmt);
  return result && { types: result.keys.map(f => f.type), single: result.relation.single };
}
