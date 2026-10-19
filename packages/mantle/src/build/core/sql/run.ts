/** Build-time keyset paging over compiler-authorized SQL. */
import { DiagnosticError, runtimeDiagnostic } from "../../spec/kernel/diagnostic.js";
import type { SqlNode as N } from "../../spec/domain/model/SqlIr.js";
import type { MantleDialect, StorageSchema } from "../dialect.js";
import { S, op, ref } from "./ast.js";
import type { Compiled } from "./policy.js";

export interface Program {
  readonly inputs: Readonly<Record<string, string>>;
  readonly ir: readonly N[];
}
export interface RunEnv {
  readonly dialect: MantleDialect;
  readonly schemas: Readonly<Record<string, StorageSchema>>;
}

const refuse = (message: string) => new DiagnosticError(runtimeDiagnostic({ code: "INPUT_VALIDATION_FAILED", severity: "error", path: "store", message }));

// ---- Views and cursors --------------------------------------------------------------------------------
const refuseOutput = (name: string): never => { throw refuse(`SQL_SHAPE: the View has no output named '${name}'`); };
/** The name a View output has on the row: its alias, or the column it reads. */
export const outName = (t: N) => t.ResTarget.name ?? t.ResTarget.val?.ColumnRef?.fields?.at(-1)?.String?.sval;

/**
 * Conditions on a paged View's outputs (ADR-0032 decision 5): Admin's `searchFields` become one `LIKE` per output, ORed, and
 * `filterFields` one `=` each. Values are bound; the output names come from the plan's uiSchema, never from the request.
 */
export interface ViewMatch {
  readonly search?: { readonly columns: readonly string[]; readonly text: string };
  readonly eq?: readonly { readonly column: string; readonly value: unknown }[];
}

// ---- the row-comparison cursor ------------------------------------------------------------------------
/**
 * Columns every Schema's table declares NOT NULL (`postgres/storage.ts` createTable): the native ones, the scope column, and `status` when publishing.
 * The scope branch is the table's truth but does not fire today: a View's readable projection never exposes the scope column to sort by.
 */
const nativeNotNull = (s: { scope?: string; publishing?: boolean }, column: string) =>
  column === "id" || column === "version" || column === "created_at" || column === "updated_at" || column === s.scope || (!!s.publishing && column === "status");

/** The FROM items of a select, each with whether an outer join can null-extend it. */
function fromItems(items: readonly N[] | undefined, nullable = false): { node: N; nullable: boolean }[] {
  return (items ?? []).flatMap((n): { node: N; nullable: boolean }[] => {
    const j = n.JoinExpr;
    if (!j) return [{ node: n, nullable }];
    return [...fromItems([j.larg], nullable || j.jointype === "JOIN_RIGHT" || j.jointype === "JOIN_FULL"), ...fromItems([j.rarg], nullable || j.jointype === "JOIN_LEFT" || j.jointype === "JOIN_FULL")];
  });
}

/**
 * Whether `qual.name` (or `name`, when the select reads one source) of `sel` can never be NULL: a native column of a Schema's own table
 * (not null-extended by an outer join), or a bare pass-through of one by a subquery. Anything else (an expression, a declared field,
 * a CTE, a row source, an ambiguous name) is unknown, and unknown means nullable.
 * ponytail: declared required fields are nullable in the table (storage.ts adds NOT NULL to native columns only), so they count as nullable here;
 * the upgrade is a NOT NULL for them, which needs a storage migration.
 */
function notNullIn(schemas: RunEnv["schemas"], sel: N, qual: string | undefined, name: string): boolean {
  if (!sel || sel.op !== "SETOP_NONE" || sel.withClause) return false;
  const items = fromItems(sel.fromClause);
  const alias = (n: N) => n.RangeVar ? n.RangeVar.alias?.aliasname ?? n.RangeVar.relname : n.RangeSubselect?.alias?.aliasname ?? n.RangeFunction?.alias?.aliasname;
  const hit = qual === undefined ? items : items.filter((i) => alias(i.node) === qual);
  if (hit.length !== 1 || (qual === undefined && items.length !== 1) || hit[0]!.nullable) return false;
  const { node } = hit[0]!;
  if (node.RangeVar) {
    const schema = node.RangeVar.mantle === "system" ? schemas[node.RangeVar.relname] : undefined;
    return !!schema && nativeNotNull(schema, name);
  }
  const sub = node.RangeSubselect;
  if (!sub || sub.alias?.colnames?.length || sub.lateral) return false;
  const outs = (sub.subquery.SelectStmt?.targetList ?? []).filter((t: N) => (t.ResTarget.name ?? t.ResTarget.val?.ColumnRef?.fields?.at(-1)?.String?.sval) === name);
  const f = outs.length === 1 ? outs[0].ResTarget.val?.ColumnRef?.fields : undefined;
  if (!f || f.length > 2 || f.some((x: N) => !x.String)) return false;
  return notNullIn(schemas, sub.subquery.SelectStmt, f.length === 2 ? f[0].String.sval : undefined, f.at(-1).String.sval);
}

/**
 * PostgreSQL only: whether the cursor can be one row comparison `(k0, k1, ...) > ($1, $2, ...)`. That needs every key (the appended
 * tiebreaks included) NOT NULL, all in one direction, and no NULLS clause other than PostgreSQL's own default.
 */
function rowComparable(env: Pick<RunEnv, "dialect">, keys: readonly N[], notNull: readonly boolean[]): boolean {
  if (!env.dialect.nativeOrder || !keys.length) return false;
  const desc = keys[0]!.SortBy.sortby_dir === "SORTBY_DESC";
  return keys.every((k, i) => {
    const d = k.SortBy.sortby_dir;
    if (d !== "SORTBY_DEFAULT" && d !== "SORTBY_ASC" && d !== "SORTBY_DESC") return false;
    if ((d === "SORTBY_DESC") !== desc) return false;
    // an explicit NULLS clause is the author's: only PostgreSQL's own default (LAST ascending, FIRST descending) leaves the order the index has
    const nulls = k.SortBy.sortby_nulls;
    if (nulls && nulls !== "SORTBY_NULLS_DEFAULT" && nulls !== (desc ? "SORTBY_NULLS_FIRST" : "SORTBY_NULLS_LAST")) return false;
    return notNull[i]!;
  });
}

/**
 * Keyset pagination over a View. The sort keys (the author's plus the compiler's appended id or group key)
 * become hidden `_k<i>` columns; the cursor is the last row's keys and the next page filters on them. A NULL key
 * sorts by the dialect's own NULLS rule (stated on every key, so the cursor and the order agree).
 *
 * A View's own LIMIT bounds every page together. A View without ORDER BY (a DISTINCT, a GROUP BY or an aggregate) cannot
 * be paged: it returns its rows when they fit one page and is refused when they do not.
 */
/** Where a paged statement's extra bind comes from on a later request: a cursor key, the search pattern, an equality value, or the page size + 1 (the LIMIT is a bind, so one statement serves every page size). */
export type Source = { readonly cursor: number } | { readonly search: true } | { readonly eq: number } | { readonly limit: true };
/** The paged form of one View under one request shape: its AST is built once, and `sources` say how to bind it. */
export interface Paged { readonly ast: N; readonly sources: readonly Source[]; readonly flat: boolean; readonly names: readonly string[]; readonly nkeys: number; }
// keyed by the compiled View, so it lives and dies with the compile cache's entry; the shapes per View are capped (a cursor's
// length and its NULL pattern come off the wire)

/**
 * Everything a paged statement's text depends on besides the compiled View: which cursor keys are NULL or missing and how many there
 * are (the row comparison needs all of them, non-null), and the search and equality columns. Values, and the page size, are binds, not text.
 * Only the first `nkeys` elements and whether the length is exactly `nkeys` reach the AST, so the key's size is bounded by the View, not the wire.
 */
export function pageShape(nkeys: number, cursor: readonly unknown[] | undefined, match: ViewMatch | undefined): string {
  const cursorShape = cursor ? `${Array.from({ length: nkeys }, (_x, i) => { const v = cursor[i]; return v === null ? "n" : v === undefined ? "u" : "v"; }).join("")}${cursor.length === nkeys ? "=" : "!"}` : "-";
  const search = match?.search?.text ? match.search : undefined;
  return JSON.stringify([cursorShape, search?.columns ?? null, (match?.eq ?? []).map((e) => e.column)]);
}

/** The paged statement for one request shape (see `runView`): the View wrapped with its cursor condition, search and equality filters. */
export function pagedOf(env: Pick<RunEnv, "schemas" | "dialect">, c: Compiled, cursor: readonly unknown[] | undefined, match: ViewMatch | undefined): Paged {
  const opts = { cursor, match };
  const sel = structuredClone(c.ast.SelectStmt) as N;
  const keys: N[] = sel.sortClause ?? [];
  if (opts.cursor && !keys.length) throw refuse("SQL_SHAPE: this View has no ORDER BY, so it is one page and takes no cursor");
  const visible: (string | undefined)[] = sel.targetList.map(outName);
  if (!keys.length && !opts.match?.search?.text && !opts.match?.eq?.length) {
    // nothing to wrap: the View's own statement, one row past the page to tell whether it fits
    return { ast: { SelectStmt: { ...sel, limitCount: { ParamRef: { number: c.binds.length + 1 } }, limitOption: "LIMIT_OPTION_COUNT" } }, sources: [{ limit: true }], flat: true, names: [], nkeys: 0 };
  }
  if (visible.some((n) => !n)) throw refuse("SQL_SHAPE: a paged View names every output column");
  const names = visible as string[];
  const aliasVal = new Map<string, N>(sel.targetList.map((t: N) => [outName(t), t.ResTarget.val]));
  const hidden = keys.map((k, i) => {
    const node = k.SortBy.node;
    const f = node.ColumnRef?.fields;
    const position = node.A_Const?.ival ? Number(node.A_Const.ival.ival) : undefined;
    // an ORDER BY alias or position is its select-list expression; a bare constant would sort nothing
    const val = position !== undefined ? sel.targetList[position - 1]?.ResTarget.val ?? refuseOutput(String(position))
      : f?.length === 1 && aliasVal.has(f[0].String.sval) ? aliasVal.get(f[0].String.sval)! : node;
    return { ResTarget: { name: `_k${i}`, val } };
  });
  // the dialect's own rule, stated: SQLite puts NULL first ascending and last descending; a native-order dialect (PostgreSQL) the reverse
  const desc = (k: N) => k.SortBy.sortby_dir === "SORTBY_DESC";
  const nullsFirst = (k: N) => (k.SortBy.sortby_nulls === "SORTBY_NULLS_FIRST" ? true : k.SortBy.sortby_nulls === "SORTBY_NULLS_LAST" ? false : desc(k) === !!env.dialect.nativeOrder);
  // an authored LIMIT bounds the whole result: the View's own ORDER BY and LIMIT pick its rows, and the pages run through those
  const inner: N = sel.limitCount
    ? { ...sel, targetList: [...sel.targetList, ...hidden] }
    : { ...sel, targetList: [...sel.targetList, ...hidden], sortClause: undefined, limitCount: undefined, limitOption: "LIMIT_OPTION_DEFAULT" };
  const base = c.binds.length;
  const sources: Source[] = [];
  const param = (source: Source): N => (sources.push(source), { ParamRef: { number: base + sources.length } });
  const col = (n: string): N => ref("_p", n);
  const isNull = (n: N, t: "IS_NULL" | "IS_NOT_NULL"): N => ({ NullTest: { arg: n, nulltesttype: t } });
  const conditions: N[] = [];
  if (opts.cursor) {
    const cur = opts.cursor;
    const notNull = hidden.map((h) => {
      const f = h.ResTarget.val?.ColumnRef?.fields;
      return !!f && f.length <= 2 && f.every((x: N) => x.String)
        && notNullIn(env.schemas, sel, f.length === 2 ? f[0].String.sval : undefined, f.at(-1).String.sval);
    });
    const same = (j: number) => (cur[j] === null ? isNull(col(`_k${j}`), "IS_NULL") : op("=", col(`_k${j}`), param({ cursor: j })));
    // the rows after the cursor's key i: past a NULL comes every value when NULL sorts first, nothing when it sorts last
    const past = (k: N, i: number): N | undefined => {
      const at = col(`_k${i}`);
      if (cur[i] === null) return nullsFirst(k) ? isNull(at, "IS_NOT_NULL") : undefined;
      const beyond = op(desc(k) ? "<" : ">", at, param({ cursor: i }));
      return notNull[i] || nullsFirst(k) ? beyond : { BoolExpr: { boolop: "OR_EXPR", args: [beyond, isNull(at, "IS_NULL")] } };
    };
    if (rowComparable(env, keys, notNull) && cur.length === keys.length && cur.every((v) => v !== null && v !== undefined)) {
      // every key is NOT NULL and they share one direction: one row comparison, which a btree range-scans however deep the page
      const row = (args: N[]): N => ({ RowExpr: { args, row_format: "COERCE_IMPLICIT_CAST" } });
      conditions.push(op(desc(keys[0]!) ? "<" : ">", row(keys.map((_k, i) => col(`_k${i}`))), row(cur.map((_v, i) => param({ cursor: i })))));
    } else {
      // A leading range lets the native planner seek. Keep equal keys for later tiebreaks, and never cut off a NULL tail.
      // Large tie groups can still scan many rows; the author owns the index and unique complete ordering.
      if (cur[0] !== null && cur[0] !== undefined && (notNull[0] || nullsFirst(keys[0]!)))
        conditions.push(op(desc(keys[0]!) ? "<=" : ">=", col("_k0"), param({ cursor: 0 })));
      const args = keys.flatMap((k, i) => {
        const last = past(k, i);
        return last ? [{ BoolExpr: { boolop: "AND_EXPR", args: [...keys.slice(0, i).map((_x, j) => same(j)), last] } }] : [];
      });
      conditions.push(args.length ? { BoolExpr: { boolop: "OR_EXPR", args } } : { A_Const: { boolval: { boolval: false } } });
    }
  }
  // an output by the name SQL gave it: an unquoted alias or column folds to lower case
  const output = (name: string) => names.find((n) => n === name) ?? names.find((n) => n === name.toLowerCase()) ?? refuseOutput(name);
  const search = opts.match?.search;
  if (search?.text) {
    conditions.push({ BoolExpr: { boolop: "OR_EXPR", args: search.columns.map((c) => ({ A_Expr: { kind: "AEXPR_LIKE", name: [{ String: { sval: "~~" } }], lexpr: col(output(c)),
      rexpr: { FuncCall: { funcname: [{ String: { sval: "like_escape" } }], args: [param({ search: true }), { A_Const: { sval: { sval: "\\" } } }], funcformat: "COERCE_EXPLICIT_CALL" } } } })) } });
  }
  (opts.match?.eq ?? []).forEach(({ column }, k) => conditions.push(op("=", col(output(column)), param({ eq: k }))));
  const limitCount = param({ limit: true }); // last, so it follows every other extra bind
  const outer: N = { SelectStmt: {
    targetList: [...names.map((n) => ({ ResTarget: { val: col(n), name: n } })), ...keys.map((_k, i) => ({ ResTarget: { val: col(`_k${i}`), name: `_k${i}` } }))],
    fromClause: [{ RangeSubselect: { subquery: { SelectStmt: inner }, alias: { aliasname: "_p" } } }],
    whereClause: conditions.length > 1 ? { BoolExpr: { boolop: "AND_EXPR", args: conditions } } : conditions[0],
    sortClause: keys.map((k, i) => ({ SortBy: { node: col(`_k${i}`), sortby_dir: k.SortBy.sortby_dir, sortby_nulls: nullsFirst(k) ? "SORTBY_NULLS_FIRST" : "SORTBY_NULLS_LAST" } })),
    limitCount, limitOption: "LIMIT_OPTION_COUNT", op: "SETOP_NONE" } };
  return { ast: outer, sources, flat: false, names, nkeys: keys.length };
}
