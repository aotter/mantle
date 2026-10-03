/**
 * Mantle SQL's allowlist (ADR-0034 decisions 2 and 3, ADR-0037 decision 1): one walker and two profiles. `base` is what every
 * dialect runs (D1 runs exactly this); `reference` is base plus ADR-0037 decision 2, and the PostgreSQL dialect runs it.
 * Shared by the CLI (run on the raw AST, so a refusal carries a source offset) and by the runtime (run on the stripped IR of
 * every program). An unknown node type, key or enum value is refused, never skipped: a printer that skipped keys would
 * silently drop OFFSET or FOR UPDATE.
 *
 * Pure JavaScript. This file must never import the parser: the runtime imports it, and the parser
 * declares a 128 MiB WASM memory, which is a Worker's whole isolate limit.
 */
import type { SqlContext, SqlDiagnostic, SqlDiagnosticCode, SqlNode as N, SqlPlan, SqlSchemaDef } from "../../spec/domain/model/SqlIr.js";
import { PG_GRAMMAR } from "../../spec/domain/model/SqlIr.js";
import { SqlRefusal } from "../../spec/domain/service/SqlRefusal.js";
import { intervalMicros, parseNumeric } from "../../spec/domain/service/SqlTypes.js";

type Code = SqlDiagnosticCode;
/** `scope`: the CTE names in scope, innermost last, by PostgreSQL's rule (see `withScope`) */
type Ctx = SqlContext & { source?: string; known?: Set<string>; p: Profile; scope: Set<string>[] };

/** node type -> the keys it may carry */
export const KEYS_SRC: Record<string, string> = {
  SelectStmt: 'targetList fromClause whereClause groupClause havingClause sortClause limitCount distinctClause valuesLists limitOption op',
  InsertStmt: 'relation cols selectStmt onConflictClause returningClause override',
  UpdateStmt: 'relation targetList whereClause returningClause',
  DeleteStmt: 'relation whereClause returningClause',
  ReturningClause: 'exprs', ResTarget: 'name val', ColumnRef: 'fields', String: 'sval', A_Star: '',
  A_Const: 'ival fval sval boolval isnull', A_Expr: 'kind name lexpr rexpr',
  BoolExpr: 'boolop args', NullTest: 'arg nulltesttype', CaseExpr: 'arg args defresult', CaseWhen: 'expr result',
  CoalesceExpr: 'args', TypeCast: 'arg typeName', TypeName: 'names typemod typmods',
  FuncCall: 'funcname args agg_star agg_distinct over funcformat', WindowDef: 'partitionClause orderClause frameOptions',
  SubLink: 'subLinkType testexpr subselect operName', SortBy: 'node sortby_dir sortby_nulls',
  RangeVar: 'relname alias inh relpersistence mantle', Alias: 'aliasname', RangeSubselect: 'subquery alias',
  RangeFunction: 'functions alias', JoinExpr: 'jointype larg rarg quals', List: 'items',
  OnConflictClause: 'action infer targetList whereClause', InferClause: 'indexElems', IndexElem: 'name ordering nulls_ordering',
};
export const KEYS = Object.fromEntries(Object.entries(KEYS_SRC).map(([k, v]) => [k, new Set(v.split(' ').filter(Boolean))]));

/** keys (or `Type.key`) whose value is one node with the type key omitted (libpg-query prints nothing for it) */
export const BARE: Record<string, string> = { alias: 'Alias', typeName: 'TypeName', infer: 'InferClause', returningClause: 'ReturningClause', relation: 'RangeVar', over: 'WindowDef', onConflictClause: 'OnConflictClause', withClause: 'WithClause', 'SelectStmt.larg': 'SelectStmt', 'SelectStmt.rarg': 'SelectStmt' };

export const ENUM: Record<string, (string | number | boolean)[]> = {
  'SelectStmt.op': ['SETOP_NONE'], 'SelectStmt.limitOption': ['LIMIT_OPTION_DEFAULT', 'LIMIT_OPTION_COUNT'],
  'InsertStmt.override': ['OVERRIDING_NOT_SET'], 'RangeVar.inh': [true], 'RangeVar.relpersistence': ['p'], 'RangeVar.mantle': ['table', 'cte'],
  'A_Expr.kind': ['AEXPR_OP', 'AEXPR_IN', 'AEXPR_LIKE', 'AEXPR_BETWEEN', 'AEXPR_NOT_BETWEEN', 'AEXPR_DISTINCT', 'AEXPR_NOT_DISTINCT', 'AEXPR_NULLIF'],
  'BoolExpr.boolop': ['AND_EXPR', 'OR_EXPR', 'NOT_EXPR'], 'NullTest.nulltesttype': ['IS_NULL', 'IS_NOT_NULL'],
  'SubLink.subLinkType': ['EXISTS_SUBLINK', 'EXPR_SUBLINK', 'ANY_SUBLINK'], 'JoinExpr.jointype': ['JOIN_INNER', 'JOIN_LEFT'],
  'SortBy.sortby_dir': ['SORTBY_DEFAULT', 'SORTBY_ASC', 'SORTBY_DESC'], 'SortBy.sortby_nulls': ['SORTBY_NULLS_DEFAULT', 'SORTBY_NULLS_FIRST', 'SORTBY_NULLS_LAST'],
  'FuncCall.funcformat': ['COERCE_EXPLICIT_CALL', 'COERCE_SQL_SYNTAX'],
  'WindowDef.frameOptions': [1058], // 1058 = the default frame; any frame clause is refused
  'OnConflictClause.action': ['ONCONFLICT_NOTHING', 'ONCONFLICT_UPDATE'], 'TypeName.typemod': [-1],
  'IndexElem.ordering': ['SORTBY_DEFAULT'], 'IndexElem.nulls_ordering': ['SORTBY_NULLS_DEFAULT'],
};

const OPS = new Set(['=', '<>', '!=', '<', '>', '<=', '>=', '+', '-', '*', '/', '%', '||', '->>', '~~', '!~~']);
/** scalar and aggregate functions. `pg_catalog.` is stripped before the lookup. */
export const FUNCS = new Set([
  'count', 'sum', 'min', 'max', 'avg', 'json_group_array', 'json_group_object', 'row_number', 'rank',
  'lower', 'upper', 'length', 'abs', 'round', 'substr', 'replace', 'btrim', 'ltrim', 'rtrim', 'instr', 'typeof', 'hex', // btrim is what PostgreSQL parses trim(x) to
 
  'json_extract', 'json_set', 'json_insert', 'json_remove', 'json_array_length',
  'now', 'auth.uid', 'auth.role', 'date_trunc', 'extract', 'like_escape',
  'mantle.search', 'mantle.search_rank', 'mantle.near', 'mantle.distance',
]);
const WINDOW = new Set(['row_number', 'rank', 'sum', 'count']);
/** functions that exist only with OVER */
const WINDOW_ONLY = new Set(['row_number', 'rank', 'dense_rank', 'lag', 'lead', 'first_value', 'last_value']);
const AGG = new Set(['count', 'sum', 'min', 'max', 'avg', 'json_group_array', 'json_group_object']);
export const TRUNC_UNITS = new Set(['hour', 'day', 'week', 'month', 'year']);
export const EXTRACT_FIELDS = new Set(['year', 'month', 'day', 'dow', 'hour']);
const CAST_TYPES = new Set(['text', 'int4', 'int8', 'float8', 'bool', 'timestamptz', 'date', 'numeric', 'interval']);
export const MAX_RADIUS_M = 50_000;
export const MAX_NEAR_K = 100;
const MAX_NODES = 2000;


/** What one profile accepts. `reference` also lifts the rules that exist only because SQLite stores and compares differently. */
export interface Profile {
  readonly name: 'base' | 'reference';
  readonly keys: Readonly<Record<string, Set<string>>>;
  readonly enums: Readonly<Record<string, readonly (string | number | boolean)[]>>;
  readonly ops: ReadonlySet<string>;
  readonly funcs: ReadonlySet<string>;
  readonly window: ReadonlySet<string>;
  readonly agg: ReadonlySet<string>;
  readonly trunc: ReadonlySet<string>;
  readonly extract: ReadonlySet<string>;
  readonly casts: ReadonlySet<string>;
}
const BASE_PROFILE: Profile = { name: 'base', keys: KEYS, enums: ENUM, ops: OPS, funcs: FUNCS, window: WINDOW, agg: AGG, trunc: TRUNC_UNITS, extract: EXTRACT_FIELDS, casts: CAST_TYPES };

// ---- ADR-0037 decision 2: the reference profile's additions --------------------------------------------------------------
const MORE_KEYS: Record<string, string> = {
  SelectStmt: 'withClause larg rarg all', WithClause: 'ctes recursive', CommonTableExpr: 'ctename ctequery aliascolnames ctematerialized',
  RangeSubselect: 'lateral', FuncCall: 'agg_filter agg_order', WindowDef: 'startOffset endOffset', MinMaxExpr: 'op args',
};
const MORE_ENUM: Record<string, (string | number | boolean)[]> = {
  'SelectStmt.op': ['SETOP_UNION', 'SETOP_INTERSECT', 'SETOP_EXCEPT'], 'A_Expr.kind': ['AEXPR_ILIKE'],
  'CommonTableExpr.ctematerialized': ['CTEMaterializeDefault', 'CTEMaterializeAlways', 'CTEMaterializeNever'], 'MinMaxExpr.op': ['IS_GREATEST', 'IS_LEAST'],
};
const MORE_OPS = ['->', '#>', '#>>', '@>', '<@', '?', '?|', '?&', '~', '~*', '!~', '!~*', '~~*', '!~~*'];
const MORE_WINDOW = ['avg', 'min', 'max', 'lag', 'lead', 'first_value', 'last_value', 'dense_rank'];
const MORE_AGG = ['string_agg', 'jsonb_agg', 'jsonb_object_agg'];
const MORE_FUNCS = [...MORE_WINDOW, ...MORE_AGG, 'jsonb_build_object', 'jsonb_build_array', 'jsonb_strip_nulls', 'to_jsonb', 'jsonb_typeof', 'split_part', 'floor', 'ceil', 'sqrt', 'power', 'timezone'];
/** frame bits a window may not set: GROUPS and every EXCLUDE (PostgreSQL's FRAMEOPTION_* in parsenodes.h) */
export const FRAME_REFUSED = 0x8 | 0x8000 | 0x10000 | 0x20000;
const union = <T>(a: Iterable<T>, b: Iterable<T>) => new Set([...a, ...b]);
const REFERENCE_PROFILE: Profile = {
  name: 'reference',
  keys: Object.fromEntries([...new Set([...Object.keys(KEYS), ...Object.keys(MORE_KEYS)])].map((k) => [k, union(KEYS[k] ?? [], (MORE_KEYS[k] ?? '').split(' ').filter(Boolean))])),
  // a frame is checked by its bits (check.WindowDef), not as one enum value
  enums: Object.fromEntries([...new Set([...Object.keys(ENUM), ...Object.keys(MORE_ENUM)])].filter((k) => k !== 'WindowDef.frameOptions').map((k) => [k, [...(ENUM[k] ?? []), ...(MORE_ENUM[k] ?? [])]])),
  ops: union(OPS, MORE_OPS), funcs: union(FUNCS, MORE_FUNCS), window: union(WINDOW, MORE_WINDOW), agg: union(AGG, MORE_AGG),
  trunc: union(TRUNC_UNITS, ['minute', 'quarter']), extract: union(EXTRACT_FIELDS, ['minute', 'quarter', 'week', 'isoyear', 'isodow', 'doy', 'epoch']),
  casts: union(CAST_TYPES, ['jsonb']),
};
export const PROFILES = { base: BASE_PROFILE, reference: REFERENCE_PROFILE } as const;

/**
 * Names that SQLite rejects unquoted while PostgreSQL's keyword list lets the printer emit them bare.
 * Measured on local D1 by `cases/deparser.ts` (it fails if this list drifts from the measurement).
 */
export const SQLITE_ONLY_KEYWORDS = new Set([
  'add', 'alter', 'autoincrement', 'commit', 'delete', 'drop', 'escape', 'index', 'insert', 'nothing', 'raise', 'set', 'transaction', 'update',
]);

export const SYSTEM = new Set(['version', 'status', 'author_id', 'created_at', 'updated_at']);

const sv = (list: N[]) => list.map((n) => n.String?.sval ?? (n.A_Star ? '*' : no('SQL_UNSUPPORTED', 'a name part that is not an identifier'))).join('.');
const fname = (n: N) => sv(n.funcname).replace(/^pg_catalog\./, '');
function no(code: Code, message: string, offset?: number, keyword?: RegExp): never {
  throw new SqlRefusal(code, message, offset, keyword);
}

/** structural refusals name a key or an enum value; these find the keyword in the source text (the AST carries no location for them) */
const KEYWORD: Record<string, RegExp> = {
  'SelectStmt.withClause': /\bWITH\b/i, 'InsertStmt.withClause': /\bWITH\b/i, 'UpdateStmt.withClause': /\bWITH\b/i, 'DeleteStmt.withClause': /\bWITH\b/i,
  'SelectStmt.limitOffset': /\bOFFSET\b/i, 'SelectStmt.lockingClause': /\bFOR\s+(NO\s+KEY\s+)?(UPDATE|SHARE|KEY\s+SHARE)\b/i, 'SelectStmt.intoClause': /\bINTO\b/i,
  'SelectStmt.op': /\b(UNION|INTERSECT|EXCEPT)\b/i, 'UpdateStmt.fromClause': /\bFROM\b/i, 'DeleteStmt.usingClause': /\bUSING\b/i,
  'JoinExpr.jointype': /\b(RIGHT|FULL)\b/i, 'JoinExpr.isNatural': /\bNATURAL\b/i, 'JoinExpr.usingClause': /\bUSING\b/i,
  'WindowDef.frameOptions': /\b(ROWS|RANGE|GROUPS)\b/i, 'A_Expr.kind': /\bILIKE\b/i, 'InferClause.conname': /\bON\s+CONSTRAINT\b/i,
  'SelectStmt.distinctClause': /\bDISTINCT\s+ON\b/i, GroupingSet: /\bGROUPING\s+SETS\b/i,
};

/** first source offset found in a subtree, so a refusal about a key can still point somewhere */
function firstLoc(v: any): number | undefined {
  if (!v || typeof v !== 'object') return undefined;
  if (typeof v.location === 'number' && v.location >= 0) return v.location;
  for (const c of Array.isArray(v) ? v : Object.values(v)) {
    const l = firstLoc(c);
    if (l !== undefined) return l;
  }
  return undefined;
}

type Budget = { n: number };
type Walk = { ctx: Ctx; budget: Budget };

/** Validate a program of statements under a profile. `stmts` are the `stmt` of each RawStmt; `locs` their offsets (CLI only). */
export function validateProgram(stmts: N[], ctx: SqlContext & { source?: string }, locs: (number | undefined)[] = [], profile: Profile = BASE_PROFILE): void {
  program(stmts, { ...ctx, p: profile, scope: [] }, locs);
}
function program(stmts: N[], ctx: Ctx, locs: (number | undefined)[]): void {
  if (!Array.isArray(stmts) || !stmts.length) no('SQL_SHAPE', 'an empty program');
  if (ctx.kind === 'view' && (stmts.length !== 1 || !stmts[0]!.SelectStmt)) no('SQL_SHAPE', 'a View is exactly one SELECT', locs[1]);
  ctx = { ...ctx, known: knownColumns(stmts, ctx) };
  const w: Walk = { ctx, budget: { n: 0 } };
  stmts.forEach((s, i) => {
    const t = Object.keys(s)[0] ?? '';
    const at = locs[i] ?? firstLoc(s);
    if (!['SelectStmt', 'InsertStmt', 'UpdateStmt', 'DeleteStmt'].includes(t)) no('SQL_UNSUPPORTED', `statement ${t} is refused`, at);
    if (t === 'SelectStmt' && ctx.kind !== 'view') no('SQL_SHAPE', 'a Procedure statement is a write', at);
    if (t !== 'SelectStmt' && ctx.kind === 'view') no('SQL_SHAPE', 'a View is one SELECT', at);
    walk(t, s[t], w, [t], at);
  });
  if (ctx.public) publishedJoin(stmts, ctx);
}

/** every node of a tree with the given key, at any depth */
function* find(v: any, key: string): Generator<any> {
  if (!v || typeof v !== 'object') return;
  for (const [k, c] of Object.entries(v)) {
    if (k === key) yield c;
    yield* find(c, key);
  }
}

/**
 * Every name a column may have: declared fields (a geo field also as _lat and _lng), `id`, the system
 * columns, json_each's, relation names and aliases, and every output name the program gives (ORDER BY and outer queries read them).
 * A name outside the set is a typo. Not per relation: a column of another table passes here.
 */
function knownColumns(stmts: N[], ctx: Ctx): Set<string> {
  const known = new Set(['id', 'key', 'value', 'type', 'atom', 'parent', 'fullkey', 'path', ...SYSTEM]);
  for (const s of Object.values(ctx.schemas))
    for (const [f, t] of Object.entries(s.fields)) (t === 'geo' ? [f, `${f}_lat`, `${f}_lng`] : [f]).forEach((c) => known.add(c));
  for (const r of find(stmts, 'ResTarget')) if (r.name) known.add(String(r.name).toLowerCase());
  for (const r of find(stmts, 'RangeVar')) [r.relname, r.alias?.aliasname].forEach((a) => a && known.add(a.toLowerCase())); // mantle.search(<alias>, ...) names a relation
  for (const c of find(stmts, 'CommonTableExpr')) [c.ctename, ...(c.aliascolnames ?? []).map((x: N) => x.String?.sval)].forEach((a) => a && known.add(String(a).toLowerCase()));
  return known;
}

/** ADR-0034 decision 8: a public View that joins a non-publishing Schema must tie it to a publishing one in a JOIN ... ON. */
function publishedJoin(stmts: N[], ctx: Ctx) {
  // a CTE reference is not a relation: the Schemas its body reads are found where they are
  const rels: { alias: string; publishing: boolean }[] = [...find(stmts, 'RangeVar')].filter((r) => r.mantle !== 'cte').map((r) => ({
    alias: (r.alias?.aliasname ?? r.relname).toLowerCase(),
    publishing: !!ctx.schemas[r.relname.toLowerCase()]?.publishing,
  }));
  if (!rels.some((r) => r.publishing)) return;
  const ons: Set<string>[] = [...find(stmts, 'JoinExpr')].map((j) => new Set([...find(j.quals, 'ColumnRef')].filter((c) => c.fields.length === 2).map((c) => c.fields[0].String.sval.toLowerCase())));
  for (const r of rels)
    if (!r.publishing && !ons.some((o) => o.has(r.alias) && rels.some((p) => p.publishing && o.has(p.alias))))
      no('SQL_RELATION', `${r.alias} has no published state: a public View must join it to a publishing Schema in a JOIN ... ON`);
}

/** A node's keys and enum values against the profile. */
function shape(type: string, node: N, w: Walk, here: number | undefined): void {
  const keys = w.ctx.p.keys[type] ?? no('SQL_UNSUPPORTED', `${type} is not in the subset`, here, KEYWORD[type]);
  for (const [k, v] of Object.entries(node)) {
    if (k === 'location' || k === 'rexpr_list_start' || k === 'rexpr_list_end') continue; // source positions, not structure
    if (!keys.has(k)) no('SQL_UNSUPPORTED', `${type}.${k} is not in the subset`, firstLoc(v) ?? here, KEYWORD[`${type}.${k}`]);
    const e = w.ctx.p.enums[`${type}.${k}`];
    if (e && !e.includes(v as any)) no('SQL_UNSUPPORTED', `${type}.${k} = ${JSON.stringify(v)} is refused`, firstLoc(node) ?? here, KEYWORD[`${type}.${k}`]);
  }
}

/** Runs `f` with these CTE names in scope. */
function withScope(w: Walk, names: Iterable<string>, f: () => void): void {
  w.ctx.scope.push(new Set(names));
  try { f(); } finally { w.ctx.scope.pop(); }
}

function walk(type: string, node: N, w: Walk, path: string[], loc: number | undefined): void {
  if (++w.budget.n > MAX_NODES) no('SQL_SHAPE', 'statement too large', loc);
  const here = typeof node.location === 'number' ? node.location : loc;
  shape(type, node, w, here);
  try {
    check[type]?.(node, w.ctx, path, here);
  } catch (e) {
    if (e instanceof SqlRefusal && e.offset === undefined && !e.keyword) e.offset = here; // a helper (interval, numeric) refused without knowing where
    throw e;
  }
  // PostgreSQL's CTE scope: a body sees its earlier siblings (every sibling under RECURSIVE); the SELECT's body sees them all
  const wc: N | undefined = type === 'SelectStmt' ? node.withClause : undefined;
  const names: string[] = (wc?.ctes ?? []).map((x: N) => String(x.CommonTableExpr?.ctename));
  if (wc) {
    shape('WithClause', wc, w, here);
    (wc.ctes ?? []).forEach((x: N, j: number) => withScope(w, wc.recursive ? names : names.slice(0, j), () => child(x, w, [...path, 'WithClause'], 'ctes', here)));
  }
  withScope(w, names, () => {
    for (const [k, v] of Object.entries(node)) {
      if (type === 'A_Const' || k === 'location' || k === 'rexpr_list_start' || k === 'rexpr_list_end' || (wc && k === 'withClause')) continue;
      const bare = BARE[`${type}.${k}`] ?? BARE[k];
      if (bare) walk(bare, v as N, w, [...path, bare], here);
      else if (Array.isArray(v)) v.forEach((c) => child(c, w, path, k, here));
      else if (v && typeof v === 'object') child(v as N, w, path, k, here);
    }
  });
}
function child(c: N, w: Walk, path: string[], k: string, loc: number | undefined) {
  const keys = Object.keys(c);
  if (!keys.length) {
    if (k === 'distinctClause' || k === 'items') return; // `DISTINCT` is [{}]; a json_each coldeflist slot is {}
    no('SQL_UNSUPPORTED', `an empty node in ${k}`, loc);
  }
  if (keys.length !== 1) no('SQL_UNSUPPORTED', 'a malformed node', loc);
  walk(keys[0]!, c[keys[0]!], w, [...path, keys[0]!], loc);
}

const isConst = (n: N | undefined) => !!n?.A_Const;
const isInputRef = (n: N | undefined) => n?.ColumnRef?.fields?.length === 2 && n.ColumnRef.fields[0].String?.sval === 'input';

type Checker = (n: N, ctx: Ctx, path: string[], at: number | undefined) => void;
const check: Record<string, Checker> = {
  RangeVar: (n, ctx, _p, at) => {
    const name = (n.relname as string).toLowerCase(); // SQLite names are case-insensitive, quoted or not; the context is keyed in lower case
    if (name.startsWith('_mantle') || name === 'input' || name === 'auth') no('SQL_RELATION', `${name} is not a declared Schema`, at);
    const reference = ctx.p.name === 'reference';
    // a `cte` tag is honored only for a CTE in scope here (the runtime never trusts an IR's tags); base has no WITH at all
    if (n.mantle === 'cte') { if (reference && ctx.scope.some((s) => s.has(n.relname))) return; no('SQL_RELATION', `${name}: a cte reference is not defined in scope`, at); }
    if (!ctx.schemas[name]) no('SQL_RELATION', `${name} is not a declared Schema`, at);
    if (n.mantle !== undefined && n.mantle !== 'table') no('SQL_RELATION', `${name}: relation not name-resolved`, at);
    if (n.alias && ['input', 'auth', 'excluded'].includes(n.alias.aliasname)) no('SQL_RELATION', `${n.alias.aliasname} is a reserved alias`, at);
    if (!reference) for (const ident of [name, n.alias?.aliasname]) if (ident && SQLITE_ONLY_KEYWORDS.has(ident)) no('SQL_UNSUPPORTED', `${ident} is an SQLite keyword: the printer would not quote it`, at);
  },
  ColumnRef: (n, ctx, _p, at) => {
    const f = sv(n.fields), last = f.split('.').pop()!.toLowerCase();
    if (n.fields.length > 2) no('SQL_COLUMN', `${f}: at most alias.column`, at);
    if (['rowid', 'oid', '_rowid_', '_rid'].includes(last)) no('SQL_COLUMN', `${last} is not addressable`, at);
    if (Object.values(ctx.schemas).some((s) => s.scope === last)) no('SQL_COLUMN', `${f}: the scope column is not addressable`, at);
    if (f.startsWith('input.') && !(last in ctx.inputs)) no('SQL_COLUMN', `${f} is not a declared input`, at);
    if (ctx.p.name === 'base' && SQLITE_ONLY_KEYWORDS.has(last)) no('SQL_UNSUPPORTED', `${last} is an SQLite keyword: the printer would not quote it`, at);
    if (last !== '*' && !f.startsWith('input.') && !ctx.known!.has(last)) no('SQL_COLUMN', `${f} is not a declared field`, at);
  },
  FuncCall: (n, ctx, path, at) => {
    const f = fname(n);
    if (f === 'json_each') {
      if (path.at(-2) !== 'List' || path.at(-3) !== 'RangeFunction') no('SQL_FUNCTION', 'json_each is only allowed in FROM', at);
      return;
    }
    if (!ctx.p.funcs.has(f)) no('SQL_FUNCTION', `function ${f} is not on the allowlist`, at);
    if (n.over && (ctx.kind !== 'view' || !ctx.p.window.has(f))) no('SQL_FUNCTION', `window function ${f} is refused here`, at);
    if (!n.over && WINDOW_ONLY.has(f)) no('SQL_FUNCTION', `${f}() is a window function: it needs OVER (...)`, at);
    if ((f === 'lag' || f === 'lead') && n.args?.[1] && n.args[1].A_Const?.ival === undefined) no('SQL_FUNCTION', `${f}'s offset is an integer literal`, at);
    if ((n.agg_filter || n.agg_order) && !ctx.p.agg.has(f)) no('SQL_FUNCTION', `FILTER and ORDER BY belong to an aggregate, and ${f} is not one`, at);
    const args: N[] = n.args ?? [];
    const str = (a?: N) => a?.A_Const?.sval?.sval as string | undefined;
    switch (f) {
      case 'like_escape': if (path.at(-2) !== 'A_Expr') no('SQL_FUNCTION', 'like_escape is only the ESCAPE of a LIKE', at); break;
      case 'date_trunc': if (args.length !== 2 || !ctx.p.trunc.has(str(args[0]) ?? '')) no('SQL_TYPE', `date_trunc takes ${[...ctx.p.trunc].join(', ')} as a literal first argument`, at); break;
      case 'extract': if (args.length !== 2 || !ctx.p.extract.has(str(args[0]) ?? '')) no('SQL_TYPE', `extract takes ${[...ctx.p.extract].join(', ')}`, at); break;
      case 'now': case 'auth.uid': case 'auth.role': if (args.length) no('SQL_FUNCTION', `${f}() takes no arguments`, at); break;
      case 'mantle.search': case 'mantle.search_rank':
        if (args.length !== (f === 'mantle.search' ? 2 : 1) || args[0]?.ColumnRef?.fields?.length !== 1) no('SQL_FUNCTION', f === 'mantle.search' ? 'mantle.search(<alias>, <query>)' : 'mantle.search_rank(<alias>)', at);
        break;
      case 'mantle.near': case 'mantle.distance': {
        const want = f === 'mantle.near' ? 4 : 3;
        const fld = args[0]?.ColumnRef?.fields;
        if (args.length !== want || fld?.length !== 2) no('SQL_FUNCTION', `${f}(<alias>.<geo field>, lat, lng${f === 'mantle.near' ? ', meters' : ''})`, at);
        for (const a of args.slice(1, 3)) if (!isConst(a) && !isInputRef(a)) no('SQL_FUNCTION', `${f}: latitude and longitude are a literal or input.<name>`, at);
        if (f === 'mantle.near') {
          const m = args[3]?.A_Const?.ival?.ival ?? args[3]?.A_Const?.fval?.fval;
          if (m === undefined) no('SQL_FUNCTION', 'mantle.near() needs a literal radius in meters', at);
          if (Number(m) > MAX_RADIUS_M || Number(m) <= 0) no('SQL_FUNCTION', `mantle.near() radius is at most ${MAX_RADIUS_M} m`, at);
        }
        break;
      }
    }
    if (ctx.p.agg.has(f) && n.args?.length === 0 && !n.agg_star) no('SQL_FUNCTION', `${f} needs an argument`, at);
  },
  A_Expr: (n, ctx, _p, at) => {
    const op = sv(n.name);
    if (ctx.p.name === 'base') bareLiteralCompare(n, ctx, at); // PostgreSQL casts the literal to the column's type
    if (n.kind === 'AEXPR_OP' && !ctx.p.ops.has(op)) no('SQL_UNSUPPORTED', `operator ${op} is refused`, at);
    if (n.kind === 'AEXPR_IN' && !['=', '<>'].includes(op)) no('SQL_UNSUPPORTED', 'a bad IN', at);
    if (n.kind === 'AEXPR_LIKE' && !['~~', '!~~'].includes(op)) no('SQL_UNSUPPORTED', 'ILIKE and regular expressions are refused', at, /\bILIKE\b/i);
    if (n.kind === 'AEXPR_ILIKE' && !['~~*', '!~~*'].includes(op)) no('SQL_UNSUPPORTED', 'a bad ILIKE', at);
    const esc = (x: N | undefined) => !!x?.FuncCall && fname(x.FuncCall) === 'like_escape';
    if (esc(n.lexpr) || (esc(n.rexpr) && n.kind !== 'AEXPR_LIKE')) no('SQL_FUNCTION', 'like_escape is only the ESCAPE of a LIKE', at);
  },
  TypeCast: (n, ctx, _p, at) => {
    const t = sv(n.typeName.names).replace('pg_catalog.', '');
    if (!ctx.p.casts.has(t)) no('SQL_TYPE', `CAST to ${t} is refused`, at);
    const lit = n.arg?.A_Const;
    // the literal-only rules exist because SQLite truncates and stores time and decimals as integers; PostgreSQL casts any value
    const base = ctx.p.name === 'base';
    if (base && (t === 'int4' || t === 'int8') && !(lit?.ival || /^\s*-?\d+\s*$/.test(lit?.sval?.sval ?? 'x')))
      no('SQL_TYPE', `CAST to ${t} takes an integer literal: SQLite truncates toward zero where PostgreSQL rounds. Write round(x)`, at);
    if (t === 'interval') {
      if (!lit?.sval) no('SQL_TYPE', 'an interval is a literal such as interval \'36 hours\'', at);
      intervalMicros(lit.sval.sval, n.typeName.typmods?.[0]?.A_Const?.ival?.ival); // throws SQL_TYPE for calendar units
    }
    if (base && (t === 'timestamptz' || t === 'date') && !lit?.sval) no('SQL_TYPE', `CAST to ${t} takes a literal (the compiler folds it to its integer encoding)`, at);
    if (t === 'numeric') {
      const [p, s] = (n.typeName.typmods ?? []).map((m: N) => m.A_Const?.ival?.ival ?? 0);
      if (p === undefined) no('SQL_TYPE', 'numeric needs (precision, scale)', at);
      parseNumeric(`numeric(${p}, ${s})`);
      if (base && !lit) no('SQL_TYPE', 'CAST to numeric takes a literal: numeric columns are integer counts of the smallest unit', at);
    }
  },
  ResTarget: (n, ctx, _p, at) => {
    if (ctx.p.name === 'base' && n.name && SQLITE_ONLY_KEYWORDS.has(n.name)) no('SQL_UNSUPPORTED', `${n.name} is an SQLite keyword: the printer would not quote it`, at);
  },
  SubLink: (n, _c, _p, at) => {
    if (n.subLinkType === 'ANY_SUBLINK' && n.operName && sv(n.operName) !== '=') no('SQL_UNSUPPORTED', 'only IN (subquery)', at);
  },
  JoinExpr: (n, _c, _p, at) => {
    if (!n.quals) no('SQL_SHAPE', 'a JOIN needs ON', at, /\bCROSS\s+JOIN\b|\bJOIN\b/i);
  },
  RangeFunction: (n, _c, _p, at) => {
    const fs: N[] = n.functions;
    if (fs.length !== 1 || fs[0]?.List?.items?.length !== 2 || sv(fs[0].List.items[0].FuncCall?.funcname ?? []) !== 'json_each') no('SQL_FUNCTION', 'only json_each() is allowed in FROM', at);
    if (fs[0]!.List.items[0].FuncCall.args?.length !== 1) no('SQL_FUNCTION', 'json_each takes one argument', at);
  },
  RangeSubselect: (n, _c, _p, at) => {
    if (!n.alias) no('SQL_SHAPE', 'a subquery in FROM needs an alias', at);
  },
  CommonTableExpr: (n, _c, _p, at) => {
    if (!n.ctequery?.SelectStmt) no('SQL_SHAPE', 'a CTE body is a SELECT: a write inside WITH is refused', at);
    // the printer writes a CTE's name unquoted, so PostgreSQL would fold "Items" to items
    if (String(n.ctename) !== String(n.ctename).toLowerCase()) no('SQL_SHAPE', `a CTE name is lower case: ${n.ctename}`, at);
  },
  WindowDef: (n, _c, _p, at) => {
    if (n.frameOptions & FRAME_REFUSED) no('SQL_UNSUPPORTED', 'GROUPS frames and EXCLUDE are refused', at, /\b(GROUPS|EXCLUDE)\b/i);
    // an offset is a literal: rows as an integer, a RANGE over time as an interval literal
    for (const o of [n.startOffset, n.endOffset]) if (o && !(o.A_Const?.ival !== undefined || (o.TypeCast?.arg?.A_Const?.sval && sv(o.TypeCast.typeName.names).replace('pg_catalog.', '') === 'interval')))
      no('SQL_SHAPE', 'a frame offset is a literal: an integer, or an interval such as interval \'6 days\'', at);
  },
  SelectStmt: (n, ctx, path, at) => {
    const reference = ctx.p.name === 'reference';
    // Core pages and orders a View's own SELECT (ADR-0037 decision 2), so what reshapes rows lives in a CTE or a subquery
    const top = ctx.kind === 'view' && path.length === 1;
    const distinctOn = !!n.distinctClause && (n.distinctClause.length !== 1 || Object.keys(n.distinctClause[0]).length > 0);
    if (n.op && n.op !== 'SETOP_NONE' && top) no('SQL_SHAPE', 'UNION, INTERSECT and EXCEPT go inside a WITH or a subquery: Core pages the View\'s own SELECT', at, /\b(UNION|INTERSECT|EXCEPT)\b/i);
    if (n.limitCount && !n.sortClause) no('SQL_SHAPE', 'LIMIT needs an ORDER BY', firstLoc(n.limitCount) ?? at);
    if (distinctOn && (!reference || top)) no(reference ? 'SQL_SHAPE' : 'SQL_UNSUPPORTED', reference ? 'DISTINCT ON goes inside a WITH or a subquery: Core pages the View\'s own SELECT' : 'DISTINCT ON is refused', at, /\bDISTINCT\s+ON\b/i);
    if (n.distinctClause && !distinctOn && n.sortClause) no('SQL_SHAPE', 'DISTINCT with ORDER BY is refused: the appended id key would change what is distinct', at);
    if (n.valuesLists && (path.at(-2) !== 'InsertStmt' || n.valuesLists.length !== 1)) no('SQL_SHAPE', 'VALUES is one row, in INSERT only', firstLoc(n.valuesLists) ?? at);
    if ((n.fromClause ?? []).slice(1).some((f: N) => !f.RangeFunction && !(reference && f.RangeSubselect?.lateral))) no('SQL_SHAPE', reference ? 'a comma join is refused (except json_each and LATERAL)' : 'a comma join is refused (except json_each)', at);
    // mantle.near()/mantle.distance(): a query ordered by mantle.distance() needs a LIMIT of at most MAX_NEAR_K
    const byDistance = JSON.stringify(n.sortClause ?? []).includes('"distance"');
    if (byDistance) {
      const k = n.limitCount?.A_Const?.ival?.ival;
      if (k === undefined || k > MAX_NEAR_K) no('SQL_SHAPE', `a query ordered by mantle.distance() needs a literal LIMIT of at most ${MAX_NEAR_K}`, firstLoc(n.sortClause) ?? at);
    }
  },
  UpdateStmt: (n, ctx) => writeList(n.targetList, ctx, n.relation, false),
  InsertStmt: (n, ctx, _p, at) => {
    writeList(n.cols ?? no('SQL_WRITE', 'INSERT needs a column list', at), ctx, n.relation, true, n.selectStmt?.SelectStmt?.valuesLists?.[0]?.List?.items);
    if (n.onConflictClause?.action === 'ONCONFLICT_UPDATE') writeList(n.onConflictClause.targetList, ctx, n.relation, false);
  },
};

/** Columns stored as integers that PostgreSQL compares with a string literal by casting it: the system timestamps and these types. */
const STORED_AS_NUMBER = new Set(['timestamptz', 'date', 'bool']);
const SYSTEM_TIMES = new Set(['created_at', 'updated_at']);

/** The type a column name has in every Schema that declares it, or undefined when none does or they disagree. */
function columnType(ctx: Ctx, name: string): string | undefined {
  if (SYSTEM_TIMES.has(name)) return 'timestamptz';
  const types = new Set(Object.values(ctx.schemas).flatMap((s: SqlSchemaDef) => (Object.hasOwn(s.fields, name) ? [s.fields[name]!] : [])));
  return types.size === 1 ? [...types][0] : undefined;
}

/**
 * PostgreSQL reads `startsAt > '2020-01-01'` by casting the literal to the column's type; SQLite compares the stored integer with
 * text and the condition is silently false. A bare string literal against a date-time, date or boolean column is refused, and so
 * is any comparison of a json column.
 */
function bareLiteralCompare(n: N, ctx: Ctx, at: number | undefined) {
  const compares = n.kind === 'AEXPR_OP' ? ['=', '<>', '!=', '<', '>', '<=', '>='].includes(sv(n.name)) : ['AEXPR_IN', 'AEXPR_BETWEEN', 'AEXPR_NOT_BETWEEN', 'AEXPR_DISTINCT', 'AEXPR_NOT_DISTINCT'].includes(n.kind);
  if (!compares) return;
  const typeOf = (x: N | undefined) => { const f = x?.ColumnRef?.fields; const name = f?.at(-1)?.String?.sval; return name && !(f.length === 2 && f[0].String?.sval === 'input') ? columnType(ctx, String(name).toLowerCase()) : undefined; };
  const literals = (x: N | undefined): string[] => (x?.List ? x.List.items.flatMap(literals) : x?.A_Const?.sval ? [x.A_Const.sval.sval] : []);
  for (const [colSide, other] of [[n.lexpr, n.rexpr], [n.rexpr, n.lexpr]] as const) {
    const type = typeOf(colSide);
    // a json value compares as text on SQLite and as jsonb (no operator with a number) on PostgreSQL: compare an extraction
    if (type === 'json') no('SQL_TYPE', `${colSide.ColumnRef.fields.at(-1).String.sval} is json: compare a value read with ->> (and CAST), or declare the field with one scalar type`, at);
    if (!type || !STORED_AS_NUMBER.has(type)) continue;
    const text = literals(other)[0];
    if (text !== undefined)
      no('SQL_TYPE', `'${text}' is text and the column is ${type}, which is stored as a number: ${type === 'bool' ? 'write true or false' : `write CAST('${text}' AS ${type})`}, or bind it as an input`, at);
  }
}

/** A write may not name the scope field or a system column; `id` is never writable on update, and on a scoped Schema never on insert. */
function writeList(list: N[], ctx: Ctx, rel: N, insert: boolean, values?: N[]) {
  const s: SqlSchemaDef | undefined = ctx.schemas[rel.relname.toLowerCase()];
  for (const [i, { ResTarget: r }] of list.entries()) {
    const at = firstLoc(r) ?? firstLoc(rel);
    const name = String(r.name).toLowerCase();
    const scopedId = insert && name === 'id' && s?.scope;
    if (name === s?.scope || SYSTEM.has(name) || (!insert && name === 'id') || scopedId)
      no('SQL_WRITE', `${r.name} is filled by Mantle and cannot be written${scopedId ? ' (a scoped Schema generates its ids)' : ''}`, at);
    const cols = Object.entries(s?.fields ?? {}).flatMap(([f, t]) => (t === 'geo' ? [`${f}_lat`, `${f}_lng`] : [f]));
    if (name !== 'id' && !cols.includes(name)) no('SQL_WRITE', `${rel.relname} has no field ${r.name}`, at);
    // a bare text literal in a column stored as a number: SQLite's STRICT table would fail it at run time, so refuse it here
    const type = s?.fields[name];
    const literal = (insert ? values?.[i] : r.val)?.A_Const?.sval?.sval;
    if (ctx.p.name === 'base' && literal !== undefined && type && !['text', 'json'].includes(type) && !/^-?\d+(\.\d+)?$/.test(literal)) no('SQL_TYPE', `'${literal}' is text and ${r.name} is ${type}: write CAST('${literal}' AS ${type === 'integer' ? 'int8' : type === 'real' ? 'float8' : type}), or bind it as an input`, at);
  }
}


/** A `SqlRefusal` as a `SqlDiagnostic`, without a source position (the runtime has no source text). */
function refusalToDiagnostic(e: SqlRefusal): SqlDiagnostic {
  return { code: e.code, message: e.message };
}

/**
 * The runtime's check of a plan's IR: the grammar version, then the exact allowlist.
 * Returns no diagnostics when the plan is acceptable, otherwise the first refusal.
 * Also the check for IR built by handler code. Never throws for bad input.
 */
export function validateIr(plan: SqlPlan, ctx: SqlContext, profile: Profile = BASE_PROFILE): readonly SqlDiagnostic[] {
  try {
    if (plan?.grammar !== PG_GRAMMAR) no("SQL_UNSUPPORTED", `plan was compiled with PostgreSQL grammar ${plan?.grammar}, this runtime reads ${PG_GRAMMAR}`);
    validateProgram(plan.stmts as N[], ctx, [], profile);
    return [];
  } catch (e) {
    if (e instanceof SqlRefusal) return [refusalToDiagnostic(e)];
    // Hand-built IR can be malformed in ways the allowlist does not anticipate (null, wrong types).
    // Refusing is the only safe answer.
    return [{ code: "SQL_UNSUPPORTED", message: `malformed IR: ${e instanceof Error ? e.message : String(e)}` }];
  }
}
