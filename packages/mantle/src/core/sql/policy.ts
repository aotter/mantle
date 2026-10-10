// The policy rewriter (ADR-0034 decision 8, ADR-0035 decision 3): validated IR -> physical AST with visibility, scope,
// system columns and deterministic order injected. A dialect whose policy is "inject" supplies a PolicyLowering for what
// only it can spell (casts, Mantle's functions, generated ids). The result is still libpg-query's shape.
import { SqlRefusal as Refused, type SqlNode as N } from '../../spec/domain/index.js';
import type { RelationPosition } from './positions.js';
import type { StorageSchema as SchemaDef } from '../dialect.js';
import { classify } from '../../spec/domain/index.js';
import { S, num, op, ref as col, target as res } from './ast.js';

type Schemas = Record<string, SchemaDef>;

/** A bind a dialect's lowering adds; the dialect resolves it (`MantleDialect.bind`). */
export type DialectBind = { readonly k: 'dialect'; readonly [key: string]: unknown };
export type BindSpec =
  | { k: 'uid' } | { k: 'now' } | { k: 'role' } | { k: 'cutoff'; seconds: number } | { k: 'const'; value: unknown }
  | { k: 'input'; name: string; type: string }
  | DialectBind
  | { k: 'version' }
  | { k: 'cursor'; i: number };

/** The prefix of the columns that carry an after hook's row; the runner strips them from the result. */
export const HOOK_PREFIX = '_mantle_h_';
export type Mode = 'caller' | 'public' | 'trusted';
export type PolicyOpts = {
  /** `MantleDialect.nativeOrder`: the id tiebreak follows the last sort key's direction */
  nativeOrder?: boolean;
  schemas: Schemas;
  inputs: Record<string, string>;
  mode?: Mode;
  /** add `AND version = ?` (the version checked by the publishing lifecycle) to a row op's WHERE */
  lockVersion?: boolean;
  /** the status an update moves the entry to (the lifecycle decided it is legal); SQL cannot write `status` */
  status?: string;
  /** Schema + semantic verb keys (`posts.publish`, `items.update`) whose after hooks need whole rows. */
  returning?: ReadonlySet<string>;
  /** NEGATIVE CONTROL ONLY: print no visibility predicate, so a probe that cannot fail is caught */
  unsafeNoVisibility?: boolean;
  /** records every relation position the pass printed a wrapper for (the probe checks it is complete) */
  seen?: Set<RelationPosition>;
  /** what the dialect spells itself */
  lower: PolicyLowering;
};

/** What a lowering reads of the statement being rewritten. */
export interface LoweringScope {
  readonly inputs: Readonly<Record<string, string>>;
  /** a bind, numbered once per distinct spec */
  param(spec: BindSpec): N;
  /** rewrite a sub-tree (policy and lowering apply inside it) */
  tx(node: N | undefined): N;
  /** the Schema an alias in scope reads, and the query of its `mantle.search(alias, q)` in the same select */
  alias(name: string): { schema: string; def: SchemaDef; searchQuery?: N };
  /** record a relation position the lowering reaches (the position probe checks the list is complete) */
  seen(position: RelationPosition): void;
}

/** The pieces of a physical statement only the dialect can spell. Each takes the node already rewritten by Core, except where noted. */
export interface PolicyLowering {
  /** `input.<name>`: the bind, as the engine reads a value of this Mantle type */
  input(param: N, type: string): N;
  /** A function call, before rewriting (`f` is its name without `pg_catalog.`): its lowering, or undefined to keep it a call. */
  func(f: string, n: N, scope: LoweringScope): N | undefined;
  /** A call that is kept, with its arguments rewritten. */
  call(out: N): N;
  /** A cast, before rewriting. */
  cast(n: N, scope: LoweringScope): N;
  /** A subquery link, with its subquery rewritten. */
  sublink(out: N): N;
  /** A new entry id, for an insert that names none. */
  newId(): N;
  /** Extra columns a Schema's read wrapper exposes (the dialect's own index joins). */
  columns(s: SchemaDef): N[];
  /** `now()`'s bind, for an engine that cannot infer a parameter's type from `$n - interval '1 hour'` (absent: the bare bind). */
  system?(param: N, type: "timestamptz"): N;
}
export type Compiled = {
  ast: N;
  binds: BindSpec[];
  kind: 'read' | 'row' | 'set';
  schema?: string;
  verb?: 'insert' | 'update' | 'delete';
  /** an after hook exists for the target: RETURNING carries the row in `HOOK_PREFIX` columns the runner splits off */
  hooked: boolean;
  /** the update publishes the entry: publish hooks fire instead of update hooks */
  publish: boolean;
};


// ---- AST builders -------------------------------------------------------------------------------
const param = (n: number): N => ({ ParamRef: { number: n } });
const and = (...args: (N | undefined | false)[]): N | undefined => {
  const a = args.filter(Boolean) as N[];
  return a.length === 0 ? undefined : a.length === 1 ? a[0] : { BoolExpr: { boolop: 'AND_EXPR', args: a } };
};
const or = (...a: N[]): N => ({ BoolExpr: { boolop: 'OR_EXPR', args: a } });
const bump = (): N => res(op('+', col('version'), num(1)), 'version');
const touch = (c: C): N => res(param$(c, { k: 'now' }), 'updated_at');
const sort = (node: N, dir = 'SORTBY_DEFAULT'): N => ({ SortBy: { node, sortby_dir: dir, sortby_nulls: 'SORTBY_NULLS_DEFAULT' } });

// ---- Schema helpers -------------------------------------------------------------------------------
// the scope column is never read back, not even by `SELECT *`: it is the caller's own subject key
const declaredCols = (s: SchemaDef) => Object.entries(s.fields).filter(([f]) => f !== s.scope).flatMap(([f, t]) => (t === 'geo' ? [`${f}_lat`, `${f}_lng`] : [f]));
/** what the wrapper exposes: the declared fields plus the columns policy and hooks read */
const readable = (s: SchemaDef) => ['id', 'version', 'created_at', 'updated_at', 'author_id', ...(s.publishing ? ['status'] : []), ...declaredCols(s)];
/** what `SELECT *` and `RETURNING *` expand to: declared fields only, never scope or system columns */
const starCols = (s: SchemaDef) => declaredCols(s);

// ---- policy ---------------------------------------------------------------------------------------
type SelInfo = { container: RelationPosition; hasWindow: boolean; hasJsonEach: boolean; scope: Map<string, string>; searchQ: Map<string, N> };
type C = PolicyOpts & {
  hooked: boolean;
  binds: BindSpec[];
  keys: Map<string, number>;
  edge: string;
  embed: 'top' | 'sublink' | 'from-subquery' | 'insert-select' | 'cte' | 'setop.left' | 'setop.right';
  sel: SelInfo[];
  /** the CTEs in scope, innermost last: a reference reads its body's outputs (ordering needs its id) */
  ctes: Map<string, N>[];
  dml?: { alias: string; schema: string };
};

function param$(c: C, spec: BindSpec): N {
  const key = JSON.stringify(spec);
  let n = c.keys.get(key);
  if (!n) {
    c.binds.push(spec);
    n = c.binds.length;
    c.keys.set(key, n);
  }
  return param(n);
}

/** The ONE place a Schema's visibility rule is spelled. `a` is the alias (or table) the predicate reads through. */
function visible(s: SchemaDef, a: string, c: C): N | undefined {
  const mode = c.mode ?? 'caller';
  if (c.unsafeNoVisibility) return undefined;
  return and(
    mode !== 'trusted' && !!s.scope && op('=', col(a, s.scope), param$(c, { k: 'uid' })),
    !!s.ttl && or({ NullTest: { arg: col(a, s.ttl), nulltesttype: 'IS_NULL' } }, op('>', col(a, s.ttl), param$(c, { k: 'cutoff', seconds: s.ttlSeconds! }))),
    mode === 'public' && s.publishing && op('=', col(a, 'status'), { A_Const: { sval: { sval: 'published' } } }),
  );
}

function positionOf(c: C): RelationPosition {
  switch (c.edge) {
    case 'JoinExpr.larg': return 'join.left';
    case 'JoinExpr.rarg': return 'join.right';
    case 'SelectStmt.fromClause': {
      const i = c.sel.at(-1)!;
      return i.hasWindow ? 'window' : i.hasJsonEach ? 'json_each' : i.container;
    }
  }
  throw new Refused('SQL_RELATION', `internal: a relation reached through ${c.edge}, which has no position: refused (fail closed)`);
}

/** The ONE function that prints a Schema reference in a read position. */
function wrap(rv: N, c: C): N {
  // a CTE's body is rewritten where it is defined (position `cte`); its name is not a Schema
  if (rv.mantle === 'cte') {
    if (!c.ctes.some((m) => m.has(rv.relname))) throw new Refused('SQL_RELATION', `${rv.relname}: a cte reference is not defined in scope`);
    return { RangeVar: rv };
  }
  const s = c.schemas[String(rv.relname).toLowerCase()];
  if (!s) throw new Refused('SQL_RELATION', `${rv.relname} is not a declared Schema`);
  if (rv.mantle === 'system') return { RangeVar: rv };
  if (rv.mantle !== 'table') throw new Refused('SQL_RELATION', `${rv.relname}: a relation that is neither a Schema nor a CTE`);
  const position = positionOf(c); // computed even when nothing records it: an unclassified edge must fail closed
  c.seen?.add(position);
  const a = rv.alias?.aliasname ?? rv.relname;
  const targets = readable(s).map((f) => res(col(f)));
  targets.push(...c.lower.columns(s));
  return {
    RangeSubselect: {
      alias: { aliasname: a },
      subquery: { SelectStmt: { targetList: targets, fromClause: [{ RangeVar: { relname: rv.relname, inh: true, relpersistence: 'p', mantle: 'system' } }], whereClause: visible(s, rv.relname, c), limitOption: 'LIMIT_OPTION_DEFAULT', op: 'SETOP_NONE' } },
    },
  };
}

function relsOf(f: N | undefined, out: N[] = []): N[] {
  if (!f) return out;
  if (f.JoinExpr) { relsOf(f.JoinExpr.larg, out); relsOf(f.JoinExpr.rarg, out); } else out.push(f);
  return out;
}
const hasFunc = (v: any, pred: (name: string, n: N) => boolean): boolean => {
  if (Array.isArray(v)) return v.some((x) => hasFunc(x, pred));
  if (!v || typeof v !== 'object') return false;
  if (v.FuncCall && pred(v.FuncCall.funcname.map((x: N) => x.String.sval).join('.').replace(/^pg_catalog\./, ''), v.FuncCall)) return true;
  if (v.SubLink) return false; // a window or aggregate inside a subquery belongs to that subquery
  return Object.values(v).some((x) => hasFunc(x, pred));
};

// ---- lowering: Core's own functions, then the dialect's -------------------------------------------------
function lookupAlias(c: C, alias: string): { schema: string; def: SchemaDef; searchQuery?: N } {
  for (const info of [...c.sel].reverse()) {
    const name = info.scope.get(alias);
    if (name) return { schema: name, def: c.schemas[name]!, searchQuery: info.searchQ.get(alias) };
  }
  throw new Refused('SQL_FUNCTION', `${alias} is not a Schema in scope: mantle.search() and mantle.near() take a Schema alias`);
}
const scopeOf = (c: C): LoweringScope => ({
  inputs: c.inputs, param: (spec) => param$(c, spec), tx: (node) => tx(node, c), alias: (name) => lookupAlias(c, name), seen: (p) => c.seen?.add(p),
});

function lowerFunc(n: N, c: C): N {
  const f = n.funcname.map((x: N) => x.String.sval).join('.').replace(/^pg_catalog\./, '');
  switch (f) {
    case 'auth.uid': return param$(c, { k: 'uid' });
    case 'auth.role': return param$(c, { k: 'role' });
    case 'now': { const p = param$(c, { k: 'now' }); return c.lower.system?.(p, 'timestamptz') ?? p; }
  }
  return c.lower.func(f, n, scopeOf(c)) ?? c.lower.call(deep(n, c, 'FuncCall'));
}

// ---- traversal --------------------------------------------------------------------------------------
const H: Record<string, (n: N, c: C) => N> = {
  ColumnRef: (n, c) => {
    const f = n.fields.map((x: N) => x.String?.sval);
    if (f[0] !== 'input' || f.length !== 2) return { ColumnRef: n };
    const type = c.inputs[f[1]]!;
    return c.lower.input(param$(c, { k: 'input', name: f[1], type }), type);
  },
  FuncCall: (n, c) => lowerFunc(n, c),
  SubLink: (n, c) => c.lower.sublink(deep(n, c, 'SubLink')),
  TypeCast: (n, c) => c.lower.cast(n, scopeOf(c)),
  RangeVar: (n, c) => wrap(n, c),
  SelectStmt: (n, c) => select(n, c),
  UpdateStmt: (n, c) => update(n, c),
  DeleteStmt: (n, c) => del(n, c),
  InsertStmt: (n, c) => insert(n, c),
};
function deep(n: N, c: C, type: string): N {
  const out: N = {};
  for (const [k, v] of Object.entries(n)) {
    if (k === 'relation') { out[k] = v; continue; } // a write target is handled by its statement
    const saved = { edge: c.edge, embed: c.embed };
    c.edge = `${type}.${k}`;
    if (c.edge === 'SubLink.subselect') c.embed = 'sublink';
    else if (c.edge === 'RangeSubselect.subquery') c.embed = 'from-subquery';
    else if (c.edge === 'InsertStmt.selectStmt') c.embed = 'insert-select';
    else if (c.edge === 'CommonTableExpr.ctequery') c.embed = 'cte';
    // a set operation's branches are SELECT bodies without their type key: each is a select of its own
    if (c.edge === 'SelectStmt.larg' || c.edge === 'SelectStmt.rarg') {
      c.embed = c.edge === 'SelectStmt.larg' ? 'setop.left' : 'setop.right';
      out[k] = select(v, c).SelectStmt;
    } else out[k] = tx(v, c);
    c.edge = saved.edge;
    c.embed = saved.embed;
  }
  return out;
}
export function tx(v: any, c: C): any {
  if (Array.isArray(v)) return v.map((x) => tx(x, c));
  if (!v || typeof v !== 'object') return v;
  const ks = Object.keys(v);
  const k0 = ks[0]!;
  if (ks.length === 1 && H[k0]) return H[k0]!(v[k0], c);
  // `{ NodeType: body }` is a node (node types are capitalized); anything else (WindowDef's body, `{ items }`, `{ ival }`) is a bare body
  if (ks.length === 1 && /^[A-Z]/.test(k0)) {
    const body = v[k0];
    return { [k0]: body && typeof body === 'object' && !Array.isArray(body) ? deep(body, c, k0) : body };
  }
  return deep(v, c, 'bare');
}

/** A SELECT's output names; a set operation's are its first branch's. */
const outputsOf = (sel: N): string[] => (sel.op && sel.op !== 'SETOP_NONE' ? outputsOf(sel.larg) : (sel.targetList ?? []).map((t: N) => t.ResTarget.name ?? t.ResTarget.val?.ColumnRef?.fields?.at(-1)?.String?.sval));
/** A CTE's: its column list renames its body's. */
const cteOutputs = (cte: N): string[] => (cte.aliascolnames?.length ? cte.aliascolnames.map((x: N) => x.String.sval) : outputsOf(cte.ctequery.SelectStmt));

/**
 * PostgreSQL's CTE scope, which the front end tags by and the allowlist checks: a CTE body sees the CTEs of the statements
 * around it and its earlier siblings (every sibling under RECURSIVE); the SELECT's own body sees all of them. A name outside
 * that scope is never passed through: PostgreSQL would read it as the table (or the catalog view) of that name.
 */
function select(n: N, c: C): N {
  const w = n.withClause;
  const defs: N[] = (w?.ctes ?? []).map((x: N) => x.CommonTableExpr);
  const scope = (list: N[]) => new Map<string, N>(list.map((d) => [d.ctename, d]));
  const within = <T>(m: Map<string, N>, f: () => T): T => { c.ctes.push(m); try { return f(); } finally { c.ctes.pop(); } };
  const withClause = w && { ...w, ctes: defs.map((d, j) => within(scope(w.recursive ? defs : defs.slice(0, j)), () => tx({ CommonTableExpr: d }, c))) };
  return within(scope(defs), () => {
    const out = selectIn(w ? { ...n, withClause: undefined } : n, c);
    if (withClause) out.SelectStmt.withClause = withClause;
    return out;
  });
}
function selectIn(n: N, c: C): N {
  const rels = relsOf(n.fromClause?.[0]);
  const info: SelInfo = {
    container: c.embed === 'top' ? 'from' : c.embed,
    hasWindow: hasFunc(n.targetList, (_f, fc) => !!fc.over),
    hasJsonEach: (n.fromClause ?? []).some((f: N) => f.RangeFunction),
    scope: new Map(rels.filter((r) => r.RangeVar).map((r) => [r.RangeVar.alias?.aliasname ?? r.RangeVar.relname, r.RangeVar.relname])),
    searchQ: new Map(),
  };
  // mantle.search_rank(t) reads the query of the mantle.search(t, q) in the same select
  const findSearch = (v: any) => {
    if (Array.isArray(v)) return v.forEach(findSearch);
    if (!v || typeof v !== 'object') return;
    const f = v.FuncCall;
    if (f && f.funcname.map((x: N) => x.String.sval).join('.') === 'mantle.search') info.searchQ.set(f.args[0].ColumnRef.fields[0].String.sval, f.args[1]);
    Object.values(v).forEach(findSearch);
  };
  findSearch(n.whereClause);
  c.sel.push(info);
  const saved = c.embed;
  const out = deep(expandStar(n, info, c), c, 'SelectStmt');
  c.embed = saved;
  c.sel.pop();

  // deterministic order: append the tiebreak (ADR-0034 decision 2, "Order and paging")
  const first = rels[0];
  const firstAlias = first?.RangeVar ? (first.RangeVar.alias?.aliasname ?? first.RangeVar.relname) : first?.RangeSubselect?.alias?.aliasname;
  const aggregate = !n.groupClause && hasFunc(n.targetList, (f, fc) => AGGREGATES.has(f) && !fc.over);
  if (out.sortClause && !aggregate) {
    // on a native-order dialect the tiebreak runs the way the last key does, so one index scan (forward or backward) serves the whole ORDER BY
    const dir = c.nativeOrder && out.sortClause.at(-1)?.SortBy.sortby_dir === 'SORTBY_DESC' ? 'SORTBY_DESC' : 'SORTBY_DEFAULT';
    const have = new Set(out.sortClause.map((k: N) => JSON.stringify(k.SortBy.node)));
    if (n.groupClause) out.sortClause = [...out.sortClause, ...tx(n.groupClause, c).filter((g: N) => !have.has(JSON.stringify(g))).map((g: N) => sort(g, dir))];
    else if (firstAlias || first?.RangeFunction) {
      if (first!.RangeSubselect && !outputsOf(first!.RangeSubselect.subquery.SelectStmt).includes('id'))
        throw new Refused('SQL_SHAPE', `ordering ${firstAlias}, a subquery in FROM, needs the subquery to output id`);
      const cte = first!.RangeVar?.mantle === 'cte' ? [...c.ctes].reverse().find((m) => m.has(first!.RangeVar.relname))?.get(first!.RangeVar.relname) : undefined;
      if (cte && !cteOutputs(cte).includes('id')) throw new Refused('SQL_SHAPE', `ordering ${firstAlias}, a CTE, needs the CTE to output id`);
      // a row source first in FROM has no table's id before it: its own key orders it (#1402)
      const extra = firstAlias ? [col(firstAlias, 'id')] : [];
      // A JOIN can repeat the first relation's id, including inside a subquery or CTE.
      // Authors must supply a unique full sort order for fanout; this does not prove its uniqueness.
      for (const f of n.fromClause ?? []) for (const r of relsOf(f)) {
        const je = r.RangeFunction;
        if (!je) continue;
        const fname = je.functions[0]?.List?.items?.[0]?.FuncCall?.funcname?.at(-1)?.String?.sval;
        // json_each's own `id` orders its elements; PostgreSQL's row sources have none, so a paged one is keyed by its ordinality
        // Qualify even a bare json_each's native key so an output alias named id cannot shadow it.
        if (fname === 'json_each') { if (je.alias) extra.push(col(je.alias.aliasname, 'id')); else if (r === first && rels.length === 1 && n.fromClause.length === 1) extra.push(col('json_each', 'id')); continue; }
        if (!je.alias || !je.ordinality) throw new Refused('SQL_SHAPE', `ordering a row source (${fname}) needs an alias and WITH ORDINALITY: write ${fname}(...) WITH ORDINALITY AS j(value, n)`);
        // the ordinality column is named by the list's extra entry after the function's own columns (one, or two for jsonb_each*), else `ordinality`
        const own = String(fname).startsWith('jsonb_each') ? 2 : 1;
        const names: N[] = je.alias.colnames ?? [];
        extra.push(col(je.alias.aliasname, names.length > own ? names.at(-1)!.String.sval : 'ordinality'));
      }
      out.sortClause = [...out.sortClause, ...extra.filter((e) => !have.has(JSON.stringify(e))).map((e) => sort(e, dir))];
    }
  }
  // ADR-0034 says every window's ORDER BY gets the id key. The spike found that wrong for anything but
  // row_number(): an appended key makes peers distinct, so rank() stops tying and a running sum stops
  // including its peers, which is not what PostgreSQL returns. Only row_number() is made deterministic.
  if (firstAlias && !n.groupClause) for (const t of out.targetList ?? []) {
    const fc = t.ResTarget.val?.FuncCall;
    if (fc?.over && fc.funcname.at(-1).String.sval === 'row_number') fc.over.orderClause = [...(fc.over.orderClause ?? []), sort(col(firstAlias, 'id'))];
  }
  return { SelectStmt: out };
}

/** `SELECT *` and `alias.*` expand to declared fields (never scope or system columns). */
function expandStar(n: N, info: SelInfo, c: C): N {
  if (!n.targetList?.some((t: N) => t.ResTarget.val?.ColumnRef?.fields?.at(-1)?.A_Star)) return n;
  const list = n.targetList.flatMap((t: N) => {
    const f = t.ResTarget.val?.ColumnRef?.fields;
    if (!f?.at(-1)?.A_Star) return [t];
    // a bare `*` over anything but Schemas (a FROM subquery, json_each, a CTE) has no declared columns to expand to: refused, not emptied
    if (f.length !== 2 && (n.fromClause ?? []).some((x: N) => relsOf(x).some((r) => !r.RangeVar || !c.schemas[String(r.RangeVar.relname).toLowerCase()] || r.RangeVar.mantle !== 'table')))
      throw new Refused('SQL_SHAPE', 'SELECT * reads a subquery, json_each or a CTE: name the columns');
    const aliases = f.length === 2 ? [f[0].String.sval] : [...info.scope.keys()];
    return aliases.flatMap((a) => {
      const sc = info.scope.get(a);
      if (!sc || !c.schemas[sc]) throw new Refused('SQL_SHAPE', `${a}.* needs a Schema alias`);
      return starCols(c.schemas[sc]!).map((cn) => res(col(a, cn)));
    });
  });
  return { ...n, targetList: list };
}

const AGGREGATES = new Set(['count', 'sum', 'min', 'max', 'avg', 'json_group_array', 'json_group_object', 'string_agg', 'jsonb_agg', 'jsonb_object_agg']);
const alias$ = (rel: N) => rel.alias?.aliasname ?? rel.relname;
function returning(rc: N | undefined, s: SchemaDef, c: C, target: string): N | undefined {
  // `*` and `<target>.*` are the target's declared columns, as in a SELECT; any other star is left for PostgreSQL to refuse
  const own = (f: N[] | undefined) => !!f?.at(-1)?.A_Star && (f.length === 1 || f[0]?.String?.sval === target);
  const exprs = (rc?.exprs ?? []).flatMap((e: N) => (own(e.ResTarget.val?.ColumnRef?.fields) ? starCols(s).map((f) => res(col(f))) : [e]));
  // an after hook gets the whole row whatever the author returns: its own columns, which the result never carries (ADR-0032 decision 3)
  if (c.hooked) exprs.push(...readable(s).map((f) => res(col(f), `${HOOK_PREFIX}${f}`)));
  return exprs.length ? { exprs } : undefined;
}
function dmlScope(rel: N, c: C) {
  c.sel.push({ container: 'from', hasWindow: false, hasJsonEach: false, scope: new Map([[alias$(rel), rel.relname]]), searchQ: new Map() });
}

function update(n: N, c: C): N {
  const s = c.schemas[String(n.relation.relname).toLowerCase()]!, a = alias$(n.relation);
  c.seen?.add('update-target');
  dmlScope(n.relation, c);
  const out = deep(n, c, 'UpdateStmt');
  c.sel.pop();
  out.targetList.push(bump(), touch(c), ...(c.status ? [res(param$(c, { k: 'const', value: c.status }), 'status')] : []));
  out.whereClause = and(out.whereClause, visible(s, a, c), c.lockVersion && op('=', col(a, 'version'), param$(c, { k: 'version' })));
  out.returningClause = returning(out.returningClause, s, c, alias$(n.relation));
  return { UpdateStmt: out };
}
function del(n: N, c: C): N {
  const s = c.schemas[String(n.relation.relname).toLowerCase()]!, a = alias$(n.relation);
  c.seen?.add('delete-target');
  dmlScope(n.relation, c);
  const out = deep(n, c, 'DeleteStmt');
  c.sel.pop();
  out.whereClause = and(out.whereClause, visible(s, a, c), c.lockVersion && op('=', col(a, 'version'), param$(c, { k: 'version' })));
  out.returningClause = returning(out.returningClause, s, c, alias$(n.relation));
  return { DeleteStmt: out };
}
function insert(n: N, c: C): N {
  const s = c.schemas[String(n.relation.relname).toLowerCase()]!;
  c.seen?.add('insert-target');
  const out = deep(n, c, 'InsertStmt');
  const named = (x: string) => n.cols.some((r: N) => r.ResTarget.name === x);
  const fill: [string, N][] = [
    ...(s.scope ? [[s.scope, param$(c, { k: 'uid' })] as [string, N]] : []),
    ['created_at', param$(c, { k: 'now' })],
    ['updated_at', param$(c, { k: 'now' })],
    ['author_id', param$(c, { k: 'uid' })],
    // a scoped Schema always gets a generated id: a caller-chosen id would collide with (and reveal) another owner's row
    ...(named('id') && !s.scope ? [] : [['id', c.lower.newId()] as [string, N]]),
  ];
  out.cols = [...out.cols, ...fill.map(([name]) => ({ ResTarget: { name } }))];
  // The user's VALUES/SELECT becomes a derived table so the fills never interact with its DISTINCT or
  // GROUP BY; `WHERE true` is SQLite's disambiguator for INSERT ... SELECT ... ON CONFLICT.
  // an insert that names no column (a new draft) is the fills alone: there is no VALUES row to select from
  const empty = !n.cols.length;
  out.selectStmt = { SelectStmt: {
    targetList: [...(empty ? [] : [res({ ColumnRef: { fields: [S('_v'), { A_Star: {} }] } })]), ...fill.map(([, v]) => res(v))],
    ...(empty ? {} : { fromClause: [{ RangeSubselect: { subquery: out.selectStmt, alias: { aliasname: '_v' } } }] }),
    whereClause: { A_Const: { boolval: { boolval: true } } }, limitOption: 'LIMIT_OPTION_DEFAULT', op: 'SETOP_NONE' } };
  const oc = out.onConflictClause;
  if (oc) {
    // every unique index of a scoped Schema leads with the scope field: an author may name it in the target or leave it out
    const named = (oc.infer?.indexElems ?? []).some((e: N) => String(e.IndexElem?.name ?? '').toLowerCase() === s.scope);
    if (s.scope && oc.infer && !named) oc.infer.indexElems.unshift({ IndexElem: { name: s.scope, ordering: 'SORTBY_DEFAULT', nulls_ordering: 'SORTBY_NULLS_DEFAULT' } });
    if (oc.action === 'ONCONFLICT_UPDATE') {
      c.seen?.add('conflict-update');
      oc.targetList.push(bump(), touch(c));
      oc.whereClause = and(oc.whereClause, visible(s, n.relation.relname, c)); // scope and TTL: a conflict cannot overwrite another owner's row or revive an expired one
    }
  }
  out.returningClause = returning(out.returningClause, s, c, alias$(n.relation));
  return { InsertStmt: out };
}

// ---- entry point -------------------------------------------------------------------------------------
export function applyPolicy(stmt: N, opts: PolicyOpts): Compiled {
  const t = Object.keys(stmt)[0]!;
  const verb = t === 'InsertStmt' ? 'insert' : t === 'UpdateStmt' ? 'update' : t === 'DeleteStmt' ? 'delete' : undefined;
  // the Schema as hooks, publishing and the context key it: SQL folds the name (the allowlist admits only a lower-case one)
  const schema = verb ? String(stmt[t].relation.relname).toLowerCase() : undefined;
  const publish = opts.status === 'published';
  const hooked = !!schema && !!opts.returning?.has(`${schema}.${publish ? 'publish' : verb}`);
  const c: C = { ...opts, hooked, binds: [], keys: new Map(), edge: '', embed: 'top', sel: [], ctes: [] };
  const ast = tx(stmt, c);
  return { ast, binds: c.binds, kind: classify(stmt), schema, verb, hooked, publish };
}
