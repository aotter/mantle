// The D1 dialect's lowering (ADR-0034 decision 8, ADR-0035 decision 6): what Core's policy rewriter hands a dialect to spell
// in SQLite. Casts become the storage encodings, Mantle's functions become FTS5, R*Tree and `_mantle_tz` lookups, and a
// surviving function prints as a plain call. Runs in the tenant Worker: AST in, AST out, no parser.
import { SqlRefusal as Refused, intervalMicros, parseNumeric, type SqlNode as N } from '../spec/domain/index.js';
import { S, num } from '../core/sql/ast.js';
import type { BindContext } from '../core/sql/compile.js';
import type { PolicyLowering, LoweringScope } from '../core/sql/policy.js';
import { runtimeDiagnostic, DiagnosticError } from '../spec/kernel/index.js';
import { encodeDate, encodeNumeric, encodeTimestamptz, sqliteType } from './codec.js';
import type { RawExpr } from './print.js';

type Arg = { input: string; type: string } | { const: number };
/** The one bind the D1 dialect adds: a corner of the R*Tree box a near() query reads. */
type BoxBind = { k: 'dialect'; box: 'minLat' | 'maxLat' | 'minLng' | 'maxLng'; lat: Arg; lng: Arg; meters: number };

const fn = (f: string, ...args: N[]): N => ({ FuncCall: { funcname: [S(f)], args, funcformat: 'COERCE_EXPLICIT_CALL' } });
const cast = (x: N, t: string): N => ({ TypeCast: { arg: x, typeName: { names: [S(t)], typemod: -1 } } });
const res = (val: N, name?: string): N => ({ ResTarget: name ? { name, val } : { val } });
const col = (...f: string[]): N => ({ ColumnRef: { fields: f.map(S) } });
const clone = <T,>(x: T): T => structuredClone(x);

/**
 * A lowering written as SQLite text. `__name` splices a (cloned) sub-AST, in parentheses; everything else is
 * emitted as written. The printer prints a `Raw` node as a parenthesized expression, so the runtime parses nothing.
 */
const TOKEN = /"(?:[^"]|"")*"|'(?:[^']|'')*'|__\w+/g;
function sql(text: string, subst: Record<string, N> = {}): N {
  const parts: (string | N)[] = [];
  let last = 0;
  // a placeholder is only ever unquoted: a quoted identifier or string is text, so a user's alias `n__q` cannot be spliced into
  for (const m of text.matchAll(TOKEN)) {
    if (!m[0].startsWith('__')) continue;
    const node = subst[m[0]];
    if (!node) throw new Error(`lowering template names ${m[0]} but was not given it`);
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push('(', clone(node), ')');
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return { Raw: { parts } satisfies RawExpr };
}
const q = (id: string) => `"${id.replace(/"/g, '""')}"`;

const OFF = (x: string) => `coalesce((SELECT offset_us FROM _mantle_tz WHERE from_us <= ${x} ORDER BY from_us DESC LIMIT 1), 0)`;
const FD = (a: string, b: number) => `((${a} - ((${a} % ${b}) + ${b}) % ${b}) / ${b})`; // exact integer floor division
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
const argOf = (n: N, scope: LoweringScope): Arg => {
  const k = n.ColumnRef?.fields?.length === 2 ? n.ColumnRef.fields[1].String.sval : undefined;
  if (k) return { input: k, type: scope.inputs[k]! };
  return { const: Number(n.A_Const?.ival?.ival ?? n.A_Const?.fval?.fval) };
};

function lowerFunc(f: string, n: N, scope: LoweringScope): N | undefined {
  const args: N[] = n.args ?? [];
  switch (f) {
    case 'date_trunc': {
      const ts = scope.tx(args[1]);
      return sql(`(${TRUNC[strConst(args[0]!)!]}) - ${OFF(`(${TRUNC[strConst(args[0]!)!]}) - ${OFF('__ts')}`)}`, { __ts: ts });
    }
    case 'extract': {
      const ts = scope.tx(args[1]);
      return sql(`CAST(strftime('${EXTRACT[strConst(args[0]!)!]}', ${FD(LOCAL, 1_000_000)}, 'unixepoch') AS INTEGER)`, { __ts: ts });
    }
    case 'search': case 'search_rank': {
      const alias = args[0]!.ColumnRef.fields[0].String.sval;
      const { schema, def, searchQuery } = scope.alias(alias);
      if (!def.search?.length) throw new Refused('SQL_FUNCTION', `${schema} declares no search fields`);
      scope.seen('search');
      const fts = q(`_mantle_fts_${schema}`), a = q(alias);
      const query = scope.tx(f === 'search' ? args[1] : searchQuery ?? (() => { throw new Refused('SQL_FUNCTION', `search_rank(${alias}) needs a search(${alias}, ...) in the same query`); })());
      const phrase = `'"' || replace(__q, '"', '""') || '"'`; // a quoted phrase: FTS5 operators in the query are literal. `fts = q` is FTS5's spelling of `fts MATCH q`; PostgreSQL's grammar has no MATCH
      if (f === 'search_rank') return sql(`coalesce((SELECT bm25(${fts}) FROM ${fts} WHERE ${fts} = ${phrase} AND rowid = ${a}._rid), 0)`, { __q: query });
      const like = def.search.map((fld) => `${a}.${q(fld)} LIKE '%' || replace(replace(replace(__q, '!', '!!'), '%', '!%'), '_', '!_') || '%' ESCAPE '!'`).join(' OR ');
      // trigram cannot match under three characters: fall back to LIKE over the same fields
      return sql(`CASE WHEN length(__q) >= 3 THEN ${a}._rid IN (SELECT rowid FROM ${fts} WHERE ${fts} = ${phrase}) ELSE (${like}) END`, { __q: query });
    }
    case 'near': case 'distance': {
      const [ref, latN, lngN] = args;
      const alias = ref!.ColumnRef.fields[0].String.sval, fld = ref!.ColumnRef.fields[1].String.sval;
      const { schema, def } = scope.alias(alias);
      if (def.fields[fld] !== 'geo') throw new Refused('SQL_FUNCTION', `${schema}.${fld} is not a geo field`);
      const a = q(alias);
      const dist = HAV(`${a}.${q(fld + '_lat')}`, `${a}.${q(fld + '_lng')}`);
      const sub = { __lat: scope.tx(latN), __lng: scope.tx(lngN) };
      if (f === 'distance') return sql(dist, sub);
      scope.seen('near');
      const meters = Number(args[3]!.A_Const.ival?.ival ?? args[3]!.A_Const.fval?.fval);
      const b = (which: BoxBind['box']) => scope.param({ k: 'dialect', box: which, lat: argOf(latN!, scope), lng: argOf(lngN!, scope), meters } satisfies BoxBind);
      const geo = q(`_mantle_geo_${schema}_${fld}`);
      return sql(`(${a}._rid IN (SELECT id FROM ${geo} WHERE minLat >= __b0 AND maxLat <= __b1 AND minLng >= __b2 AND maxLng <= __b3) AND ${dist} <= ${meters})`,
        { ...sub, __b0: b('minLat'), __b1: b('maxLat'), __b2: b('minLng'), __b3: b('maxLng') });
    }
  }
  return undefined;
}

function lowerCast(n: N, scope: LoweringScope): N {
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
  // PostgreSQL: a number is true when non-zero, text by its spelling; NULL stays NULL. A bare `x <> 0` is always true for text in SQLite ('false' <> 0 is 1)
  if (t === 'bool') return sql(`CASE WHEN typeof(__x) = 'text' THEN lower(__x) IN ('t', 'true', 'y', 'yes', 'on', '1') WHEN __x IS NULL THEN NULL ELSE __x <> 0 END`, { __x: scope.tx(n.arg) });
  const target = t === 'int4' || t === 'int8' ? 'integer' : t === 'float8' ? 'real' : 'text';
  return cast(scope.tx(n.arg), target);
}

/** The box a near() query binds to the R*Tree: a bounding box of the radius, padded for float32 storage. */
function box(which: BoxBind['box'], lat: number, lng: number, meters: number): number {
  const dLat = meters / 111_320;
  const dLng = meters / (111_320 * Math.max(Math.cos((lat * Math.PI) / 180), 1e-9));
  const pad = 1e-4;
  if (Math.abs(lat) + dLat >= 90 || Math.abs(lng) + dLng >= 180)
    throw new DiagnosticError(runtimeDiagnostic({ code: "INPUT_VALIDATION_FAILED", severity: "error", path: "store", message: "near(): a box that crosses the antimeridian or a pole is refused" }));
  return { minLat: lat - dLat - pad, maxLat: lat + dLat + pad, minLng: lng - dLng - pad, maxLng: lng + dLng + pad }[which];
}

export const d1Lowering: PolicyLowering = {
  // decision 5: every bind is CAST to its declared type
  input: (param, type) => cast(param, sqliteType(type)),
  func: lowerFunc,
  /** A function that survives lowering prints as a plain call: no `pg_catalog.` prefix, no SQL-syntax form (TRIM(BOTH FROM x)). */
  call(out) {
    if (out.funcname[0].String.sval === 'pg_catalog') out.funcname = out.funcname.slice(1);
    if (out.funcname.length === 1 && out.funcname[0].String.sval === 'btrim') out.funcname = [S('trim')]; // PostgreSQL's spelling of trim(x)
    out.funcformat = 'COERCE_EXPLICIT_CALL';
    return { FuncCall: out };
  },
  cast: lowerCast,
  sublink(out) {
    if (out.subLinkType === 'ANY_SUBLINK') delete out.operName; // `x = ANY (subquery)` is `x IN (subquery)`; SQLite has no ANY
    return { SubLink: out };
  },
  newId: () => fn('lower', fn('hex', fn('randomblob', num(16)))),
  // the FTS5 and R*Tree tables join on SQLite's rowid
  columns: (s) => (s.search?.length || Object.values(s.fields).includes('geo') ? [res(col('rowid'), '_rid')] : []),
};

/** Resolves the D1 dialect's own bind, a corner of a near() box, for one call. */
export function bindBox(spec: { readonly k: 'dialect' }, ctx: BindContext): number {
  const b = spec as BoxBind;
  const input = ctx.input ?? {};
  const arg = (a: Arg) => ('const' in a ? a.const : Number(input[a.input]));
  return box(b.box, arg(b.lat), arg(b.lng), b.meters);
}
