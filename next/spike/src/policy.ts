// Runtime side (ADR-0034 decision 8): validated IR -> physical AST with policy injected and Mantle's
// SQL functions lowered to plain SQLite. The result is still libpg-query's shape, so pgsql-deparser
// prints it. Runs in the tenant Worker: no parser, only AST -> AST (the `sql()` templates are parsed
// once by libpg-query's sync build here in the spike; production would ship them pre-parsed).
import { loadModule, parseSync } from 'libpg-query';
import type { N, Schemas, SchemaDef } from './types.ts';
import { Refused } from './types.ts';
import { encodeDate, encodeNumeric, encodeTimestamptz, intervalMicros, parseNumeric, sqliteType } from './codec.ts';
import type { RelationPosition } from './positions.ts';
import { KEYS } from './validate.ts';

await loadModule();

export type Arg = { input: string; type: string } | { const: number };
export type BindSpec =
  | { k: 'uid' } | { k: 'now' } | { k: 'role' }
  | { k: 'input'; name: string; type: string }
  | { k: 'box'; which: 'minLat' | 'maxLat' | 'minLng' | 'maxLng'; lat: Arg; lng: Arg; meters: number }
  | { k: 'version' }
  | { k: 'cursor'; i: number };

export const HIDDEN_ID = '_mantle_id';
export const HIDDEN_VERSION = '_mantle_version';
export type Mode = 'caller' | 'public' | 'trusted';
export type PolicyOpts = {
  schemas: Schemas;
  inputs: Record<string, string>;
  mode?: Mode;
  /** add `AND version = ?` (the version the before hook saw) to a row op's WHERE */
  lockVersion?: boolean;
  /** schemas that have an after hook: their writes get RETURNING */
  returning?: Set<string>;
  /** records every relation position the pass printed a wrapper for (the probe checks it is complete) */
  seen?: Set<RelationPosition>;
};
export type Compiled = {
  ast: N;
  binds: BindSpec[];
  kind: 'read' | 'row' | 'set';
  schema?: string;
  verb?: 'insert' | 'update' | 'delete';
  returns: boolean;
  /** an after hook exists for the target: RETURNING carries id and version in hidden columns the executor splits off */
  hooked: boolean;
  /** the rowid of a row op's target is not needed; kept for hooks: does the statement return rows to the hook? */
};

/** where the PostgreSQL parse tree has a construct SQLite lacks: rewritten in the AST, so the printer stays stock */
export const PG_ONLY_REWRITES = [
  'FuncCall: strip pg_catalog., print SQL-syntax calls (TRIM(BOTH FROM x), EXTRACT(.. FROM ..)) as plain calls',
  'FuncCall: btrim(x) (how PostgreSQL parses trim(x)) -> trim(x)',
  'SubLink: x = ANY (subquery) -> x IN (subquery)',
  'TypeCast: type names to SQLite storage classes (int4/int8 -> integer, float8 -> real, bool -> x <> 0, text -> text)',
];
/** Mantle's own SQL constructs, lowered to SQLite expressions */
export const MANTLE_LOWERINGS = [
  'input.<name> -> CAST(?n AS <declared type>), auth.uid()/auth.role()/now() -> numbered binds',
  "interval 'N second|minute|hour' -> a microsecond integer constant; calendar units refused",
  "timestamptz / date / numeric(p, s) literal casts -> their integer encodings, folded at compile time",
  'date_trunc(unit, ts) and extract(field FROM ts) -> arithmetic and strftime over the _mantle_tz offset table',
  'search(t, q) / search_rank(t) -> FTS5 trigram MATCH on a quoted phrase, LIKE under three characters, bm25',
  'near(t.f, lat, lng, m) / distance(...) -> R*Tree bounding box plus haversine',
  'a Schema reference -> (SELECT <declared columns> FROM t WHERE scope AND ttl AND published) AS alias',
];

// ---- AST builders -------------------------------------------------------------------------------
const S = (s: string) => ({ String: { sval: s } });
const col = (...p: string[]): N => ({ ColumnRef: { fields: p.map(S) } });
const param = (n: number): N => ({ ParamRef: { number: n } });
const op = (o: string, l: N, r: N): N => ({ A_Expr: { kind: 'AEXPR_OP', name: [S(o)], lexpr: l, rexpr: r } });
const and = (...args: (N | undefined | false)[]): N | undefined => {
  const a = args.filter(Boolean) as N[];
  return a.length === 0 ? undefined : a.length === 1 ? a[0] : { BoolExpr: { boolop: 'AND_EXPR', args: a } };
};
const or = (...a: N[]): N => ({ BoolExpr: { boolop: 'OR_EXPR', args: a } });
const fn = (f: string, ...args: N[]): N => ({ FuncCall: { funcname: [S(f)], args, funcformat: 'COERCE_EXPLICIT_CALL' } });
const cast = (x: N, t: string): N => ({ TypeCast: { arg: x, typeName: { names: [S(t)], typemod: -1 } } });
const res = (val: N, name?: string): N => ({ ResTarget: name ? { name, val } : { val } });
/** integers past int32 must be `fval` in libpg-query's shape; 0 must keep its `ival` key */
const num = (n: number): N => (Number.isSafeInteger(n) && Math.abs(n) < 2 ** 31 ? { A_Const: { ival: { ival: n } } } : { A_Const: { fval: { fval: String(n) } } });
const bump = (): N => res(op('+', col('version'), num(1)), 'version');
const sort = (node: N): N => ({ SortBy: { node, sortby_dir: 'SORTBY_DEFAULT', sortby_nulls: 'SORTBY_NULLS_DEFAULT' } });
const newId = (): N => fn('lower', fn('hex', fn('randomblob', num(16))));
const clone = <T,>(x: T): T => structuredClone(x);

/** Parse an SQL expression template once; `subst` replaces ColumnRefs named `__x` with (clones of) AST nodes. */
function sql(text: string, subst: Record<string, N> = {}): N {
  const tree: any = parseSync(`SELECT ${text}`);
  const go = (v: any): any => {
    if (Array.isArray(v)) return v.map(go);
    if (!v || typeof v !== 'object') return v;
    const f = v.ColumnRef?.fields;
    if (f?.length === 1 && f[0].String?.sval in subst) return clone(subst[f[0].String.sval]);
    if ('relname' in v) v = { ...v, mantle: v.relname.startsWith('_mantle') ? 'system' : 'table' };
    return Object.fromEntries(Object.entries(v).filter(([k]) => k !== 'location').map(([k, c]) => [k, go(c)]));
  };
  return go(tree.stmts[0].stmt.SelectStmt.targetList[0].ResTarget.val);
}
const q = (id: string) => `"${id.replace(/"/g, '""')}"`;

// ---- Schema helpers -------------------------------------------------------------------------------
const geoFields = (s: SchemaDef) => Object.entries(s.fields).filter(([, t]) => t === 'geo').map(([f]) => f);
const declaredCols = (s: SchemaDef) => Object.entries(s.fields).flatMap(([f, t]) => (t === 'geo' ? [`${f}_lat`, `${f}_lng`] : [f]));
/** what the wrapper exposes: the declared fields plus the columns policy and hooks read */
const readable = (s: SchemaDef) => ['id', 'version', 'created_at', ...(s.publishing ? ['status'] : []), ...declaredCols(s)];
/** what `SELECT *` and `RETURNING *` expand to: declared fields only, never scope or system columns */
const starCols = (s: SchemaDef) => declaredCols(s);
const needsRid = (s: SchemaDef) => !!s.search?.length || geoFields(s).length > 0;

// ---- policy ---------------------------------------------------------------------------------------
type SelInfo = { container: RelationPosition; hasWindow: boolean; hasJsonEach: boolean; scope: Map<string, string>; searchQ: Map<string, N> };
type C = PolicyOpts & {
  binds: BindSpec[];
  keys: Map<string, number>;
  edge: string;
  embed: 'top' | 'sublink' | 'from-subquery' | 'insert-select';
  sel: SelInfo[];
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
  return and(
    mode !== 'trusted' && s.scope && op('=', col(a, s.scope), param$(c, { k: 'uid' })),
    s.ttl && or({ NullTest: { arg: col(a, s.ttl), nulltesttype: 'IS_NULL' } }, op('>', col(a, s.ttl), param$(c, { k: 'now' }))),
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
  const s = c.schemas[rv.relname];
  if (!s) throw new Refused('SQL_RELATION', `${rv.relname} is not a declared Schema`);
  if (rv.mantle === 'system') return { RangeVar: rv };
  if (rv.mantle !== 'table') throw new Refused('SQL_RELATION', `${rv.relname}: a cte reference is not defined in scope`);
  c.seen?.add(positionOf(c));
  const a = rv.alias?.aliasname ?? rv.relname;
  const targets = readable(s).map((f) => res(col(f)));
  if (needsRid(s)) targets.push(res(col('rowid'), '_rid'));
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

// ---- expression lowering (Mantle SQL -> SQLite) -----------------------------------------------------
const OFF = (x: string) => `coalesce((SELECT offset_us FROM _mantle_tz WHERE from_us <= ${x} ORDER BY from_us DESC LIMIT 1), 0)`;
const FD = (a: string, b: number) => `((${a} - ((${a} % ${b}) + ${b}) % ${b}) / ${b})`; // exact integer floor division
/** A function that survives lowering prints as a plain call: no `pg_catalog.` prefix, no SQL-syntax form (TRIM(BOTH FROM x)). */
function plainCall(n: N, c: C): N {
  const out = deep(n, c, 'FuncCall');
  if (out.funcname[0].String.sval === 'pg_catalog') out.funcname = out.funcname.slice(1);
  if (out.funcname.length === 1 && out.funcname[0].String.sval === 'btrim') out.funcname = [S('trim')]; // PostgreSQL's spelling of trim(x)
  out.funcformat = 'COERCE_EXPLICIT_CALL';
  return { FuncCall: out };
}
const LOCAL = `(__ts + ${OFF('__ts')})`; // wall-clock microseconds in the site time zone, read as if UTC
const DAY = 86_400_000_000;
const TRUNC: Record<string, string> = {
  hour: `(${FD(LOCAL, 3_600_000_000)} * 3600000000)`,
  day: `(${FD(LOCAL, DAY)} * ${DAY})`,
  week: `((${FD(LOCAL, DAY)} - (((${FD(LOCAL, DAY)} + 3) % 7 + 7) % 7)) * ${DAY})`, // 1970-01-01 is a Thursday; ISO weeks start on Monday
  month: `(unixepoch(strftime('%Y-%m-01 00:00:00', ${FD(LOCAL, 1_000_000)}, 'unixepoch')) * 1000000)`,
  year: `(unixepoch(strftime('%Y-01-01 00:00:00', ${FD(LOCAL, 1_000_000)}, 'unixepoch')) * 1000000)`,
};
const EXTRACT: Record<string, string> = { year: '%Y', month: '%m', day: '%d', hour: '%H', dow: '%w' };
const HAV = (lat1: string, lng1: string) =>
  `(2 * 6371008.8 * asin(min(1.0, sqrt(sin(radians(__lat - ${lat1}) / 2) * sin(radians(__lat - ${lat1}) / 2) + cos(radians(${lat1})) * cos(radians(__lat)) * sin(radians(__lng - ${lng1}) / 2) * sin(radians(__lng - ${lng1}) / 2)))))`;

const strConst = (n: N) => n?.A_Const?.sval?.sval as string | undefined;
const argOf = (n: N, c: C): Arg => {
  const k = n.ColumnRef?.fields?.length === 2 ? n.ColumnRef.fields[1].String.sval : undefined;
  if (k) return { input: k, type: c.inputs[k] };
  return { const: Number(n.A_Const?.ival?.ival ?? n.A_Const?.fval?.fval) };
};

function lookupAlias(c: C, alias: string): { schema: string; def: SchemaDef; info: SelInfo } {
  for (const info of [...c.sel].reverse()) {
    const name = info.scope.get(alias);
    if (name) return { schema: name, def: c.schemas[name], info };
  }
  throw new Refused('SQL_FUNCTION', `${alias} is not a Schema in scope: search() and near() take a Schema alias`);
}

function lowerFunc(n: N, c: C): N | undefined {
  const f = n.funcname.map((x: N) => x.String.sval).join('.').replace(/^pg_catalog\./, '');
  const args: N[] = n.args ?? [];
  switch (f) {
    case 'auth.uid': return param$(c, { k: 'uid' });
    case 'auth.role': return param$(c, { k: 'role' });
    case 'now': return param$(c, { k: 'now' });
    case 'date_trunc': {
      const ts = tx(args[1], c);
      return sql(`(${TRUNC[strConst(args[0])!]}) - ${OFF(`(${TRUNC[strConst(args[0])!]}) - ${OFF('__ts')}`)}`, { __ts: ts });
    }
    case 'extract': {
      const ts = tx(args[1], c);
      return sql(`CAST(strftime('${EXTRACT[strConst(args[0])!]}', ${FD(LOCAL, 1_000_000)}, 'unixepoch') AS INTEGER)`, { __ts: ts });
    }
    case 'search': case 'search_rank': {
      const alias = args[0].ColumnRef.fields[0].String.sval;
      const { schema, def, info } = lookupAlias(c, alias);
      if (!def.search?.length) throw new Refused('SQL_FUNCTION', `${schema} declares no search fields`);
      c.seen?.add('search');
      const fts = q(`_mantle_fts_${schema}`), a = q(alias);
      const query = tx(f === 'search' ? args[1] : info.searchQ.get(alias) ?? (() => { throw new Refused('SQL_FUNCTION', `search_rank(${alias}) needs a search(${alias}, ...) in the same query`); })(), c);
      const phrase = `'"' || replace(__q, '"', '""') || '"'`; // a quoted phrase: FTS5 operators in the query are literal
      if (f === 'search_rank') return sql(`coalesce((SELECT bm25(${fts}) FROM ${fts} WHERE ${fts} MATCH ${phrase} AND rowid = ${a}._rid), 0)`, { __q: query });
      const like = def.search.map((fld) => `${a}.${q(fld)} LIKE '%' || replace(replace(replace(__q, '!', '!!'), '%', '!%'), '_', '!_') || '%' ESCAPE '!'`).join(' OR ');
      // trigram cannot match under three characters: fall back to LIKE over the same fields
      return sql(`CASE WHEN length(__q) >= 3 THEN ${a}._rid IN (SELECT rowid FROM ${fts} WHERE ${fts} MATCH ${phrase}) ELSE (${like}) END`, { __q: query });
    }
    case 'near': case 'distance': {
      const [ref, latN, lngN] = args;
      const alias = ref.ColumnRef.fields[0].String.sval, fld = ref.ColumnRef.fields[1].String.sval;
      const { schema, def } = lookupAlias(c, alias);
      if (def.fields[fld] !== 'geo') throw new Refused('SQL_FUNCTION', `${schema}.${fld} is not a geo field`);
      const a = q(alias);
      const dist = HAV(`${a}.${q(fld + '_lat')}`, `${a}.${q(fld + '_lng')}`);
      const sub = { __lat: tx(latN, c), __lng: tx(lngN, c) };
      if (f === 'distance') return sql(dist, sub);
      c.seen?.add('near');
      const meters = Number(args[3].A_Const.ival?.ival ?? args[3].A_Const.fval?.fval);
      const b = (which: 'minLat' | 'maxLat' | 'minLng' | 'maxLng') => param$(c, { k: 'box', which, lat: argOf(latN, c), lng: argOf(lngN, c), meters });
      const geo = q(`_mantle_geo_${schema}`);
      return sql(`(${a}._rid IN (SELECT id FROM ${geo} WHERE minLat >= __b0 AND maxLat <= __b1 AND minLng >= __b2 AND maxLng <= __b3) AND ${dist} <= ${meters})`,
        { ...sub, __b0: b('minLat'), __b1: b('maxLat'), __b2: b('minLng'), __b3: b('maxLng') });
    }
  }
  return undefined;
}

function lowerCast(n: N, c: C): N {
  const t = n.typeName.names.at(-1).String.sval as string;
  const lit = n.arg?.A_Const;
  const litStr = lit?.sval?.sval ?? lit?.fval?.fval ?? (lit?.ival?.ival !== undefined ? String(lit.ival.ival) : undefined);
  if (t === 'interval') return num(intervalMicros(lit.sval.sval, n.typeName.typmods?.[0]?.A_Const?.ival?.ival));
  if (t === 'timestamptz') return num(encodeTimestamptz(litStr!));
  if (t === 'date') return num(encodeDate(litStr!));
  if (t === 'numeric') {
    const [p, s] = n.typeName.typmods.map((m: N) => m.A_Const.ival.ival);
    parseNumeric(`numeric(${p}, ${s})`);
    return num(encodeNumeric(litStr!, p, s));
  }
  if (t === 'bool') return op('<>', tx(n.arg, c), num(0)); // PostgreSQL: any non-zero is true, NULL stays NULL
  const target = t === 'int4' || t === 'int8' ? 'integer' : t === 'float8' ? 'real' : 'text';
  return cast(tx(n.arg, c), target);
}

// ---- traversal --------------------------------------------------------------------------------------
const H: Record<string, (n: N, c: C) => N> = {
  ColumnRef: (n, c) => {
    const f = n.fields.map((x: N) => x.String?.sval);
    if (f[0] !== 'input' || f.length !== 2) return { ColumnRef: n };
    const type = c.inputs[f[1]];
    return cast(param$(c, { k: 'input', name: f[1], type }), sqliteType(type)); // decision 5: every bind is CAST to its declared type
  },
  FuncCall: (n, c) => lowerFunc(n, c) ?? plainCall(n, c),
  SubLink: (n, c) => {
    const out = deep(n, c, 'SubLink');
    if (out.subLinkType === 'ANY_SUBLINK') delete out.operName; // `x = ANY (subquery)` is `x IN (subquery)`; SQLite has no ANY
    return { SubLink: out };
  },
  TypeCast: (n, c) => lowerCast(n, c),
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
    out[k] = tx(v, c);
    c.edge = saved.edge;
    c.embed = saved.embed;
  }
  return out;
}
export function tx(v: any, c: C): any {
  if (Array.isArray(v)) return v.map((x) => tx(x, c));
  if (!v || typeof v !== 'object') return v;
  const ks = Object.keys(v);
  if (ks.length === 1 && H[ks[0]]) return H[ks[0]](v[ks[0]], c);
  // `{ NodeType: body }` is a node; anything else (WindowDef's body, `{ items }`, `{ ival }`) is a bare body
  if (ks.length === 1 && KEYS[ks[0]]) {
    const body = v[ks[0]];
    return { [ks[0]]: body && typeof body === 'object' && !Array.isArray(body) ? deep(body, c, ks[0]) : body };
  }
  return deep(v, c, 'bare');
}

function select(n: N, c: C): N {
  const rels = relsOf(n.fromClause?.[0]);
  const info: SelInfo = {
    container: c.embed === 'top' ? 'from' : c.embed,
    hasWindow: hasFunc(n.targetList, (_f, fc) => !!fc.over),
    hasJsonEach: (n.fromClause ?? []).some((f: N) => f.RangeFunction),
    scope: new Map(rels.filter((r) => r.RangeVar).map((r) => [r.RangeVar.alias?.aliasname ?? r.RangeVar.relname, r.RangeVar.relname])),
    searchQ: new Map(),
  };
  // search_rank(t) reads the query of the search(t, q) in the same select
  const findSearch = (v: any) => {
    if (Array.isArray(v)) return v.forEach(findSearch);
    if (!v || typeof v !== 'object') return;
    const f = v.FuncCall;
    if (f && f.funcname.at(-1).String.sval === 'search') info.searchQ.set(f.args[0].ColumnRef.fields[0].String.sval, f.args[1]);
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
  const aggregate = !n.groupClause && hasFunc(n.targetList, (f, fc) => ['count', 'sum', 'min', 'max', 'avg', 'json_group_array', 'json_group_object'].includes(f) && !fc.over);
  if (out.sortClause && !aggregate) {
    const have = new Set(out.sortClause.map((k: N) => JSON.stringify(k.SortBy.node)));
    if (n.groupClause) out.sortClause = [...out.sortClause, ...tx(n.groupClause, c).filter((g: N) => !have.has(JSON.stringify(g))).map(sort)];
    else if (firstAlias) {
      if (first.RangeSubselect && !first.RangeSubselect.subquery.SelectStmt.targetList.some((t: N) => (t.ResTarget.name ?? t.ResTarget.val?.ColumnRef?.fields?.at(-1)?.String?.sval) === 'id'))
        throw new Refused('SQL_SHAPE', `ordering ${firstAlias}, a subquery in FROM, needs the subquery to output id`);
      const extra = [col(firstAlias, 'id')];
      const je = (n.fromClause ?? []).find((f: N) => f.RangeFunction);
      if (je?.RangeFunction.alias) extra.push(col(je.RangeFunction.alias.aliasname, 'id'));
      out.sortClause = [...out.sortClause, ...extra.filter((e) => !have.has(JSON.stringify(e))).map(sort)];
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
    const aliases = f.length === 2 ? [f[0].String.sval] : [...info.scope.keys()];
    return aliases.flatMap((a) => {
      const sc = info.scope.get(a);
      if (!sc) throw new Refused('SQL_SHAPE', `${a}.* needs a Schema alias`);
      return starCols(c.schemas[sc]).map((cn) => res(col(a, cn)));
    });
  });
  return { ...n, targetList: list };
}

const alias$ = (rel: N) => rel.alias?.aliasname ?? rel.relname;
function returning(rc: N | undefined, s: SchemaDef, schema: string, c: C): N | undefined {
  if (!rc && c.returning?.has(schema)) return { exprs: readable(s).map((f) => res(col(f))) };
  if (!rc) return undefined;
  const exprs = rc.exprs.flatMap((e: N) => (e.ResTarget.val?.ColumnRef?.fields?.[0]?.A_Star ? starCols(s).map((f) => res(col(f))) : [e]));
  // `RETURNING *` and most column lists leave out id and version, but an after hook needs them: carry them in hidden columns
  if (c.returning?.has(schema)) exprs.push(res(col('id'), HIDDEN_ID), res(col('version'), HIDDEN_VERSION));
  return { exprs };
}
function dmlScope(rel: N, c: C) {
  c.sel.push({ container: 'from', hasWindow: false, hasJsonEach: false, scope: new Map([[alias$(rel), rel.relname]]), searchQ: new Map() });
}

function update(n: N, c: C): N {
  const s = c.schemas[n.relation.relname], a = alias$(n.relation);
  c.seen?.add('update-target');
  dmlScope(n.relation, c);
  const out = deep(n, c, 'UpdateStmt');
  c.sel.pop();
  out.targetList.push(bump());
  out.whereClause = and(out.whereClause, visible(s, a, c), c.lockVersion && op('=', col(a, 'version'), param$(c, { k: 'version' })));
  out.returningClause = returning(out.returningClause, s, n.relation.relname, c);
  return { UpdateStmt: out };
}
function del(n: N, c: C): N {
  const s = c.schemas[n.relation.relname], a = alias$(n.relation);
  c.seen?.add('delete-target');
  dmlScope(n.relation, c);
  const out = deep(n, c, 'DeleteStmt');
  c.sel.pop();
  out.whereClause = and(out.whereClause, visible(s, a, c), c.lockVersion && op('=', col(a, 'version'), param$(c, { k: 'version' })));
  out.returningClause = returning(out.returningClause, s, n.relation.relname, c);
  return { DeleteStmt: out };
}
function insert(n: N, c: C): N {
  const s = c.schemas[n.relation.relname];
  c.seen?.add('insert-target');
  const out = deep(n, c, 'InsertStmt');
  const named = (x: string) => n.cols.some((r: N) => r.ResTarget.name === x);
  const fill: [string, N][] = [
    ...(s.scope ? [[s.scope, param$(c, { k: 'uid' })] as [string, N]] : []),
    ['created_at', param$(c, { k: 'now' })],
    // a scoped Schema always gets a generated id: a caller-chosen id would collide with (and reveal) another owner's row
    ...(named('id') && !s.scope ? [] : [['id', newId()] as [string, N]]),
  ];
  out.cols = [...out.cols, ...fill.map(([name]) => ({ ResTarget: { name } }))];
  // The user's VALUES/SELECT becomes a derived table so the fills never interact with its DISTINCT or
  // GROUP BY; `WHERE true` is SQLite's disambiguator for INSERT ... SELECT ... ON CONFLICT.
  out.selectStmt = { SelectStmt: {
    targetList: [res({ ColumnRef: { fields: [S('_v'), { A_Star: {} }] } }), ...fill.map(([, v]) => res(v))],
    fromClause: [{ RangeSubselect: { subquery: out.selectStmt, alias: { aliasname: '_v' } } }],
    whereClause: { A_Const: { boolval: { boolval: true } } }, limitOption: 'LIMIT_OPTION_DEFAULT', op: 'SETOP_NONE' } };
  const oc = out.onConflictClause;
  if (oc) {
    if (s.scope && oc.infer) oc.infer.indexElems.unshift({ IndexElem: { name: s.scope, ordering: 'SORTBY_DEFAULT', nulls_ordering: 'SORTBY_NULLS_DEFAULT' } });
    if (oc.action === 'ONCONFLICT_UPDATE') {
      c.seen?.add('conflict-update');
      oc.targetList.push(bump());
      oc.whereClause = and(oc.whereClause, visible(s, n.relation.relname, c)); // scope and TTL: a conflict cannot overwrite another owner's row or revive an expired one
    }
  }
  out.returningClause = returning(out.returningClause, s, n.relation.relname, c);
  return { InsertStmt: out };
}

// ---- classification and entry point -----------------------------------------------------------------
const conjuncts = (w: N | undefined): N[] => (w?.BoolExpr?.boolop === 'AND_EXPR' ? w.BoolExpr.args.flatMap(conjuncts) : w ? [w] : []);
const isScalar = (n: N) => !!n.A_Const || (n.ColumnRef?.fields?.length === 2 && n.ColumnRef.fields[0].String?.sval === 'input');
const isIdCol = (n: N) => n.ColumnRef && n.ColumnRef.fields.at(-1)?.String?.sval === 'id';
/** ADR-0034 decision 4: `WHERE ... id = <scalar>` or a one-row INSERT is a row op; every other write is a set op. */
export function classify(stmt: N): 'read' | 'row' | 'set' {
  if (stmt.SelectStmt) return 'read';
  if (stmt.InsertStmt) return stmt.InsertStmt.selectStmt?.SelectStmt?.valuesLists?.length === 1 && !stmt.InsertStmt.onConflictClause ? 'row' : 'set'; // ON CONFLICT is a set op (ADR-0034 decision 2)
  const w = (stmt.UpdateStmt ?? stmt.DeleteStmt).whereClause;
  const row = conjuncts(w).some((x) => x.A_Expr?.kind === 'AEXPR_OP' && x.A_Expr.name[0].String.sval === '=' &&
    ((isIdCol(x.A_Expr.lexpr) && isScalar(x.A_Expr.rexpr)) || (isIdCol(x.A_Expr.rexpr) && isScalar(x.A_Expr.lexpr))));
  return row ? 'row' : 'set';
}

export function applyPolicy(stmt: N, opts: PolicyOpts): Compiled {
  const c: C = { ...opts, binds: [], keys: new Map(), edge: '', embed: 'top', sel: [] };
  const ast = tx(stmt, c);
  const t = Object.keys(stmt)[0];
  const verb = t === 'InsertStmt' ? 'insert' : t === 'UpdateStmt' ? 'update' : t === 'DeleteStmt' ? 'delete' : undefined;
  const schema = verb ? stmt[t].relation.relname : undefined;
  return { ast, binds: c.binds, kind: classify(stmt), schema, verb, returns: t === 'SelectStmt' || !!ast[t].returningClause, hooked: !!schema && !!opts.returning?.has(schema) };
}
