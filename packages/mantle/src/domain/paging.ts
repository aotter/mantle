/** Build-time proofs for the compiler's keyset keys. No AST reaches a generated operation. */
import { NATIVE_NOT_NULL, notNullColumns, type LoweredPage, type RuntimePlan, type PlanSchema, type SqlNode } from "../build/compiler.js";
import { declaredType } from "./columns.js";

type Field = { schema: PlanSchema; name: string; type: string; notNull: boolean; source: object };
type Relation = { fields: Map<string, Field>; names: ReadonlySet<string>; single: boolean; unique: boolean; fixed: Set<string>; sets: Set<string> };
export type PagingProof = { types: string[]; single: boolean; reason?: string };
const fieldName = (n: SqlNode) => n.ColumnRef?.fields?.at(-1)?.String?.sval;
const scalar = (n: SqlNode): boolean => !!(n.ParamRef || n.A_Const || n.TypeCast && scalar(n.TypeCast.arg));
const aggregate = (n: SqlNode): boolean => !!n && !n.SubLink && !n.SelectStmt && (n.FuncCall && !n.FuncCall.over && ["count", "sum", "min", "max", "avg"].includes(n.FuncCall.funcname?.at(-1)?.String?.sval) || Object.values(n).some(v => v && typeof v === "object" && (Array.isArray(v) ? v.some(aggregate) : aggregate(v))));

/** Only complete grouped tuples, base ids and non-fanning singleton joins are proved. */
export function provePaging(plan: RuntimePlan, ast: SqlNode): PagingProof | undefined {
  let reason: string | undefined;
  const fail = (message: string) => { reason = message; return undefined; };
  const select = (s: SqlNode, inherited: ReadonlyMap<string, Relation | undefined> = new Map()): { relation: Relation; keys: Field[] } | undefined => {
    if (!s || s.distinctClause || s.op && s.op !== "SETOP_NONE") return;
    const ctes = new Map(inherited);
    for (const c of s.withClause?.ctes ?? []) {
      const n = c.CommonTableExpr;
      ctes.set(n.ctename, undefined);
      ctes.set(n.ctename, n.aliascolnames?.length ? undefined : select(n.ctequery.SelectStmt, ctes)?.relation);
    }
    reason = undefined;
    const aliases = new Map<string, Relation>();
    const reduced = !!s.groupClause?.length || (s.targetList ?? []).some((t: SqlNode) => aggregate(t.ResTarget.val));
    const relation = (n: SqlNode): Relation | undefined => {
      if (n.JoinExpr) {
        const left = relation(n.JoinExpr.larg), before = new Set(aliases.keys()), right = relation(n.JoinExpr.rarg);
        if (!left || !right) return;
        const column = (v: SqlNode): Field | undefined => v?.ColumnRef?.fields?.length === 2 ? aliases.get(v.ColumnRef.fields[0].String?.sval)?.fields.get(fieldName(v)!) : undefined;
        const lookup = (side: Relation, other: Relation, term: SqlNode): boolean => {
          if (term?.BoolExpr?.boolop === "AND_EXPR") return term.BoolExpr.args.some((x: SqlNode) => lookup(side, other, x));
          const e = term?.A_Expr, id = side.fields.get("id"), otherId = other.fields.get("id");
          if (!side.unique || !id || !otherId || e?.kind !== "AEXPR_OP" || e.name?.[0]?.String?.sval !== "=") return false;
          const a = column(e.lexpr), b = column(e.rexpr);
          const unique = (f: Field | undefined, value: Field | undefined) => f && value && f.source === id.source && value.source === otherId.source &&
            (f.name === id.name || (!f.schema.userScopes?.length && !f.schema.scope && f.schema.unique?.some(index => index.length === 1 && index[0] === f.name)));
          return !!(unique(a, b) || unique(b, a));
        };
        const rightSingle = right.single || lookup(right, left, n.JoinExpr.quals);
        const leftSingle = left.single || lookup(left, right, n.JoinExpr.quals);
        if (!rightSingle && (!leftSingle || n.JoinExpr.jointype === "JOIN_LEFT") && !reduced) return fail(`Fanning join '${[...aliases.keys()].filter(alias => !before.has(alias)).join(", ")}': join on the joined Schema's id or a single-field unique key, or reduce it to one row.`);
        if (n.JoinExpr.jointype === "JOIN_FULL" || n.JoinExpr.jointype === "JOIN_RIGHT") return;
        // The right side of LEFT JOIN may be absent: its fields cannot become NOT NULL cursor keys.
        if (n.JoinExpr.jointype === "JOIN_LEFT") for (const [alias, r] of aliases) if (!before.has(alias)) r.fields = new Map([...r.fields].map(([k, f]) => [k, { ...f, notNull: false }]));
        return rightSingle ? left : leftSingle ? right : { ...left, unique: false };
      }
      const r = n.RangeVar, sub = n.RangeSubselect;
      let fact: Relation | undefined;
      if (r && r.mantle !== "cte" && plan.schemas[r.relname]) {
        const schema = plan.schemas[r.relname]!, notNull = notNullColumns(schema), source = {};
        const fields = new Map<string, Field>();
        for (const name of [...Object.keys(schema.fields), "id", "version", "created_at", "updated_at", "author_id", "status"]) {
          const type = declaredType(schema.fields, name) ?? (name === "version" ? "integer" : "text");
          fields.set(name, { schema, name, type, notNull: NATIVE_NOT_NULL.has(name) || notNull.has(name), source });
        }
        fact = { fields, names: new Set(fields.keys()), single: false, unique: true, fixed: new Set(), sets: new Set() };
      } else if (r?.mantle === "cte") fact = ctes.get(r.relname);
      else if (sub) fact = select(sub.subquery.SelectStmt, ctes)?.relation;
      if (fact) {
        // Two aliases of one Schema/CTE are distinct row sources, including a singleton joined to many rows.
        const sources = new Map<object, object>();
        fact = { ...fact, fields: new Map([...fact.fields].map(([name, f]) => {
          if (!sources.has(f.source)) sources.set(f.source, {});
          return [name, { ...f, source: sources.get(f.source)! }];
        })), fixed: new Set(fact.fixed), sets: new Set(fact.sets) };
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
    base ??= { fields: new Map(), names: new Set(), single: true, unique: false, fixed: new Set(), sets: new Set() };
    const targets = new Map<string, SqlNode>((s.targetList ?? []).map((t: SqlNode) => [t.ResTarget.name ?? fieldName(t.ResTarget.val), t.ResTarget.val]));
    const resolve = (n: SqlNode, output = true): Field | undefined => {
      const fields = n?.ColumnRef?.fields;
      if (fields?.every((f: SqlNode) => f.String) && fields.length <= 2) {
        const name = fieldName(n)!;
        if (fields.length === 2) return aliases.get(fields[0].String.sval)?.fields.get(name);
        if (output && targets.has(name)) return resolve(targets.get(name)!, false);
        const matches = [...aliases.values()].filter(r => r.names.has(name));
        return matches.length === 1 ? matches[0]!.fields.get(name) : undefined;
      }
      const f = n?.FuncCall;
      if (f && !f.over && !f.agg_filter && ["min", "max"].includes(f.funcname?.at(-1)?.String?.sval) && f.args?.length === 1 && s.groupClause?.length) return resolve(f.args[0], false);
      const pos = n?.A_Const?.ival?.ival;
      if (output && pos > 0) return resolve(s.targetList[pos - 1]?.ResTarget.val, false);
      return;
    };
    const fixed = (n: SqlNode): void => {
      if (n?.BoolExpr?.boolop === "AND_EXPR") n.BoolExpr.args.forEach(fixed);
      // `col IN auth.user(field)` (a scope or restrict) never fixes a prefix (#1644): the plan is prepared for a set, so
      // native ORDER BY after it reads and sorts all the caller's rows. It is only remembered for the refusal's guidance.
      // `{ all: true }`'s `kept OR 1 = 1` only drops IN terms, so this caller proof bounds that variant too.
      // A scope prints `/*s:field*/ kept /*|*/ kept OR 1 = 1 /*;*/`; `kept` is the dialect's anyOf lowering,
      // `(col) IN (SELECT value FROM json_each((?)))` or `(col) = ANY(CAST(...(?)...))`.
      const raw = n?.Raw?.parts;
      if (raw && typeof raw[0] === "string" && raw[0].startsWith("/*s:")) return fixed(raw[1]);
      if (raw?.length === 8 && raw[1]?.ColumnRef && raw[5]?.ParamRef && /^ (IN \(SELECT value FROM json_each\(|= ANY\()/.test(raw[3])) {
        const col = resolve(raw[1], false);
        if (col && col.source === base!.fields.get("id")?.source) base!.sets.add(col.name);
        return;
      }
      const e = n?.A_Expr;
      if (e?.kind !== "AEXPR_OP" || e.name?.[0]?.String?.sval !== "=") return;
      const col = scalar(e.rexpr) ? resolve(e.lexpr, false) : scalar(e.lexpr) ? resolve(e.rexpr, false) : undefined;
      if (col && col.source === base!.fields.get("id")?.source) base!.fixed.add(col.name);
    };
    fixed(s.whereClause);
    const fields = new Map<string, Field>();
    for (const [name, expr] of targets) { const field = resolve(expr, false); if (field && name) fields.set(name, field); }
    const group: SqlNode[] = s.groupClause ?? [], sorts: SqlNode[] = s.sortClause ?? [];
    const keys = sorts.map(k => resolve(k.SortBy.node));
    if (keys.some(k => k && !k.notNull)) return fail(`Nullable ORDER BY key '${keys.find(k => k && !k.notNull)!.name}': make the operational Schema field required and non-null, and order by the preserved side of a LEFT JOIN.`);
    if (keys.some(k => !k?.notNull || !["text", "bool", "integer", "int4", "int8", "real", "float8", "date", "timestamptz"].includes(k.type) && !/^numeric\(/.test(k.type))) return;
    const same = (a: Field | undefined, b: Field | undefined) => a && b && a.name === b.name && a.source === b.source;
    if (sorts.length) {
      if (group.length) {
        // Full GROUP BY keys, not an id from an arbitrary row in the group, make the result unique.
        if (!group.every(g => {
          // GROUP BY prefers an input column over a colliding output alias; ORDER BY does the reverse.
          const source = g.ColumnRef?.fields?.length === 1 ? [...aliases.values()].filter(r => r.names.has(fieldName(g)!)) : [];
          const f = source.length ? source.length === 1 ? source[0]!.fields.get(fieldName(g)!) : undefined : resolve(g);
          return f?.notNull && keys.some(k => same(k, f));
        })) return;
      } else {
        if (!base.unique || !keys.some(k => same(k, base.fields.get("id")))) return fail("Incomplete ORDER BY key tuple: include the base Schema's id as a tiebreak and preserve its row identity.");
        const order = keys.filter(k => k!.name !== "id") as Field[];
        if (order.length) {
          const schema = order[0]!.schema;
          if (order.some(f => f.source !== base!.fields.get("id")?.source)) return;
          const serving = (prefix: ReadonlySet<string>) => [...(schema.indexes ?? []), ...(schema.unique ?? [])].find(index => {
            let i = 0;
            while (i < index.length && prefix.has(index[i]!) && index[i] !== order[0]!.name) i++;
            return order.every((f, n) => index[i + n] === f.name);
          });
          if (!serving(base.fixed)) {
            const index = serving(new Set([...base.fixed, ...base.sets])), named = (c: string) => schema.names?.[c] ?? c, columns = order.map(f => named(f.name)).join(", ");
            if (!index) return fail(`Missing index for ORDER BY (${order.map(f => f.name).join(", ")}): declare a Schema index with these ordered columns after any fixed equality prefix.`);
            const prefix = index.slice(0, index.indexOf(order[0]!.name)), set = prefix.filter(c => !base!.fixed.has(c)).map(named);
            // The suggested order is the index from its first set-bound column: an equality-fixed column between stays in it.
            const lead = prefix.slice(prefix.findIndex(c => !base!.fixed.has(c))).map(named);
            const dir = (f: Field) => sorts[keys.indexOf(f)]!.SortBy.sortby_dir === "SORTBY_DESC" ? " DESC" : "";
            const sorted = [...lead.map(c => c + dir(order[0]!)), ...order.map(f => named(f.name) + dir(f))].join(", ");
            const desc = order.some(f => dir(f)) ? ", read backwards; on PostgreSQL confirm with EXPLAIN that no Sort remains" : "";
            return fail(`ORDER BY (${columns}) is served by index [${index.map(named).join(", ")}] only after ${set.map(c => `'${c}'`).join(", ")}, which a user-field scope or restrict fixes to a set of values, not one value: every page would read and sort all of the caller's rows. Bounded ways: ORDER BY ${sorted} (served by the same index${desc}); a View input bound with equality, e.g. WHERE ${set.map(c => `${c} = input.${c}`).join(" AND ")}, which fixes the prefix (the scope or restrict still applies); or, for Views read by { all: true } callers, an index on the ORDER BY columns alone, e.g. [${columns}] (not bounded for scoped callers).`);
          }
        }
      }
    }
    const single = base.single || !group.length && (s.targetList ?? []).some((t: SqlNode) => aggregate(t.ResTarget.val)) || s.limitCount?.A_Const?.ival?.ival === 1 || base.unique && base.fixed.has("id");
    return { relation: { fields, names: new Set(targets.keys()), single, unique: !group.length && base.unique && !!same(fields.get("id"), base.fields.get("id")), fixed: base.fixed, sets: base.sets }, keys: keys as Field[] };
  };
  const result = select(ast.SelectStmt);
  return result ? { types: result.keys.map(f => f.type), single: result.relation.single } : reason ? { types: [], single: false, reason } : undefined;
}

/** Cast only cursor ParamRefs in the outer predicate, never authored literals or bare projections. */
export function castCursor(ast: SqlNode, sources: LoweredPage["sources"], types: readonly string[], postgres: boolean): SqlNode {
  const typeOf = (source: typeof sources[number] | undefined) => source && "cursor" in source ? types[source.cursor] : undefined;
  const typed = (type: string | undefined) => type && (postgres ? ["timestamptz", "date"] : ["integer", "int4", "int8"]).includes(type);
  if (!sources.some(source => typed(typeOf(source)))) return ast;
  const where = structuredClone(ast.SelectStmt.whereClause), base = ast.SelectStmt.limitCount.ParamRef.number - sources.length, pending = [where];
  while (pending.length) {
    const node = pending.pop(); if (!node || typeof node !== "object") continue;
    if (node.ParamRef) {
      const number = node.ParamRef.number, type = typeOf(sources[number - base - 1]);
      if (typed(type)) {
        delete node.ParamRef; node.Raw = { parts: postgres ? ["CAST(CAST(", { ParamRef: { number } }, ` AS text) AS ${type})`] : ["CAST(", { ParamRef: { number } }, " AS INTEGER)"] };
      }
    } else pending.push(...Object.values(node));
  }
  return { ...ast, SelectStmt: { ...ast.SelectStmt, whereClause: where } };
}
