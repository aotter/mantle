/**
 * The printer: pgsql-deparser as it is, plus `Raw` (the lowering's text templates) and one pass over the physical AST that
 * gives PostgreSQL the types SQLite's affinity never needed (`typed`):
 * - a value written to a column is cast to the column's type (`j.value ->> 'reps'` is text; the column is int8);
 * - `a || b` concatenates text, as it does on D1 (`2 * 3 || 4` is '64'; PostgreSQL has no int || int);
 * - `x ->> k` is `_mantle_jget(x, k)`, which takes a json(b) or a JSON text, a key, an index or a `$` path, as SQLite does;
 * - an ORDER BY key without NULLS FIRST/LAST states the rule Core pages every View by (run.ts): NULL first ascending, last
 *   descending, so a LIMIT picks the same rows on both engines (PostgreSQL's own default is the reverse).
 */
import { Deparser } from "pgsql-deparser";
import type { SqlNode as N } from "../spec/domain/index.js";
import type { StorageSchema } from "../core/dialect.js";
import { S } from "../core/sql/ast.js";
import { cast } from "./lower.js";

export interface RawExpr { readonly parts: readonly (string | N)[] }

class PgDeparser extends Deparser {
  /** Mantle's own lowerings are written as PostgreSQL text with sub-ASTs spliced in (see `sql` in lower.ts). */
  Raw(n: RawExpr, ctx: any) {
    return `(${n.parts.map((p) => (typeof p === "string" ? p : this.visit(p as never, ctx))).join("")})`;
  }
}

export function print(ast: N): string {
  return new PgDeparser([ast] as any, { pretty: false }).deparseQuery();
}

/** A column's Mantle type: the native columns, then the Schema's fields (a geo field is its two float columns). */
export function columnType(s: StorageSchema, col: string): string | undefined {
  switch (col) {
    case "id": case "author_id": case "status": return "text";
    case "version": return "integer";
    case "created_at": case "updated_at": return "timestamptz";
  }
  if (col === s.scope) return "text";
  const geo = /^(.+)_(lat|lng)$/.exec(col);
  if (geo && s.fields[geo[1]!] === "geo") return "real";
  const t = s.fields[col];
  return t === "geo" ? undefined : t;
}

const name = (op: N) => op.name?.at(-1)?.String?.sval;
const textOf = (x: N): N => ({ TypeCast: { arg: x, typeName: { names: [S("text")], typemod: -1 } } });

/** The physical AST with PostgreSQL's types made explicit (see the module comment). */
export function typed(ast: N, schemas: Readonly<Record<string, StorageSchema>>): N {
  const walk = (v: any): any => {
    if (Array.isArray(v)) return v.map(walk);
    if (!v || typeof v !== "object") return v;
    const out: any = Object.fromEntries(Object.entries(v).map(([k, c]) => [k, walk(c)]));
    const e = out.A_Expr;
    if (e?.kind === "AEXPR_OP" && name(e) === "->>") return { FuncCall: { funcname: [S("_mantle_jget")], args: [e.lexpr, e.rexpr], funcformat: "COERCE_EXPLICIT_CALL" } };
    if (e?.kind === "AEXPR_OP" && name(e) === "||") return { A_Expr: { ...e, lexpr: textOf(e.lexpr), rexpr: textOf(e.rexpr) } };
    if (out.SortBy?.sortby_nulls === "SORTBY_NULLS_DEFAULT") out.SortBy.sortby_nulls = out.SortBy.sortby_dir === "SORTBY_DESC" ? "SORTBY_NULLS_LAST" : "SORTBY_NULLS_FIRST";
    if (out.InsertStmt) insert(out.InsertStmt);
    if (out.UpdateStmt) assign(out.UpdateStmt.relation.relname, out.UpdateStmt.targetList);
    return out;
  };
  const typeOf = (table: string, col: string) => (schemas[table] ? columnType(schemas[table]!, col.toLowerCase()) : undefined);
  const to = (table: string, col: string, val: N) => { const t = typeOf(table, col); return t ? cast(val, t) : val; };
  const assign = (table: string, targets: N[] | undefined) => {
    for (const t of targets ?? []) if (t.ResTarget?.name && t.ResTarget.val) t.ResTarget.val = to(table, t.ResTarget.name, t.ResTarget.val);
  };
  const insert = (n: N) => {
    const table = n.relation.relname as string;
    const cols: string[] = (n.cols ?? []).map((c: N) => c.ResTarget.name);
    const sel = n.selectStmt?.SelectStmt;
    const list: N[] = sel?.targetList ?? [];
    const star = list[0]?.ResTarget?.val?.ColumnRef?.fields;
    const from = sel?.fromClause?.[0]?.RangeSubselect;
    // Core's insert shape (policy.ts): `SELECT _v.*, <fills> FROM (<the author's VALUES or SELECT>) _v`
    const k = cols.length - (list.length - 1);
    const inner = from?.subquery?.SelectStmt;
    const width = inner?.valuesLists?.[0]?.List?.items?.length ?? inner?.targetList?.length;
    // a source wider or narrower than its columns is left as written, so PostgreSQL refuses it as SQLite does
    if (star?.length === 2 && star[1].A_Star && from?.alias?.aliasname === star[0].String?.sval && width === k) {
      from.alias.colnames = Array.from({ length: k }, (_x, i) => S(`c${i}`));
      const authored = Array.from({ length: k }, (_x, i) => ({ ResTarget: { val: to(table, cols[i]!, { ColumnRef: { fields: [S(from.alias.aliasname), S(`c${i}`)] } }) } }));
      sel.targetList = [...authored, ...list.slice(1).map((t, j) => ({ ResTarget: { ...t.ResTarget, val: to(table, cols[k + j]!, t.ResTarget.val) } }))];
    } else if (sel?.targetList && !sel.valuesLists) sel.targetList = list.map((t, i) => (cols[i] ? { ResTarget: { ...t.ResTarget, val: to(table, cols[i], t.ResTarget.val) } } : t));
    // in DO UPDATE a bare column could be the row or `excluded`; SQLite reads it as the row, so it is qualified with the target
    const target = n.relation.alias?.aliasname ?? table;
    const qualify = (v: any): any => {
      if (Array.isArray(v)) return v.map(qualify);
      if (!v || typeof v !== "object" || v.SubLink) return v;
      if (v.ColumnRef?.fields?.length === 1 && v.ColumnRef.fields[0].String) return { ColumnRef: { fields: [S(target), v.ColumnRef.fields[0]] } };
      return Object.fromEntries(Object.entries(v).map(([k, c]) => [k, qualify(c)]));
    };
    for (const t of n.onConflictClause?.targetList ?? []) t.ResTarget.val = qualify(t.ResTarget.val);
    if (n.onConflictClause?.whereClause) n.onConflictClause.whereClause = qualify(n.onConflictClause.whereClause);
    assign(table, n.onConflictClause?.targetList);
  };
  return walk(ast);
}
