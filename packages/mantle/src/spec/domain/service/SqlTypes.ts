/**
 * Type rules the SQL allowlist needs (ADR-0034 decisions 2 and 5): `numeric(p, s)`
 * bounds and `interval` literals. Pure; a refusal is a `SqlRefusal`.
 */
import { SqlRefusal } from "./SqlRefusal.js";

export const MAX_NUMERIC_P = 15;

export function parseNumeric(type: string): { p: number; s: number } | undefined {
  const m = /^numeric\((\d+),\s*(\d+)\)$/.exec(type);
  if (!m) return undefined;
  const p = +m[1]!, s = +m[2]!;
  if (p < 1 || p > MAX_NUMERIC_P || s > p) throw new SqlRefusal('SQL_TYPE', `numeric(${p}, ${s}) is refused: precision is 1 to ${MAX_NUMERIC_P}, scale at most precision`);
  return { p, s };
}

/** The Mantle field types storage maps (`numeric(p, s)` aside): the one list a plan's `fields` are checked against. */
export const MANTLE_FIELD_TYPES: ReadonlySet<string> = new Set(['text', 'integer', 'real', 'bool', 'json', 'timestamptz', 'date', 'geo']);

/** A field type storage can create: one of `MANTLE_FIELD_TYPES`, or a `numeric(p, s)` that `parseNumeric` accepts. */
export function isFieldType(type: unknown): boolean {
  if (typeof type !== 'string') return false;
  if (MANTLE_FIELD_TYPES.has(type)) return true;
  try { return parseNumeric(type) !== undefined; } catch { return false; }
}

/**
 * A TTL's `expireAfterSeconds` that reads can use: a whole number of seconds, 0 or more, whose cutoff (now less the TTL, in
 * microseconds) stays a safe integer, which is how an instant is bound.
 */
export const MAX_TTL_SECONDS = Math.floor(Number.MAX_SAFE_INTEGER / 2_000_000);
export const isTtlSeconds = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) >= 0 && (x as number) <= MAX_TTL_SECONDS;

/** PostgreSQL `interval` literal -> microseconds. Only second, minute and hour: day and longer are calendar units. */
const UNIT_US: Record<string, number> = Object.fromEntries(
  (['second seconds sec secs s', 'minute minutes min mins m', 'hour hours hr hrs h'] as const).flatMap((names, i) => names.split(' ').map((u) => [u, [1e6, 6e7, 3.6e9][i]!])),
);
const TYPMOD_UNIT: Record<number, string> = { 1024: 'hour', 2048: 'minute', 4096: 'second' };
export function intervalMicros(text: string, typmod?: number): number {
  let m = /^\s*(-?\d+(?:\.\d+)?)\s*([a-z]+)\s*$/i.exec(text);
  if (!m && typmod !== undefined && TYPMOD_UNIT[typmod] && /^\s*-?\d+(\.\d+)?\s*$/.test(text)) m = [text, text.trim(), TYPMOD_UNIT[typmod]] as any;
  if (!m) throw new SqlRefusal('SQL_TYPE', `interval '${text}' is not supported: write a number and second, minute or hour`);
  const unit = UNIT_US[m[2]!.toLowerCase()];
  if (!unit && /^(days?|weeks?|months?|mons?|years?|y)$/i.test(m[2]!)) throw new SqlRefusal('SQL_TYPE', `interval unit '${m[2]}' is a calendar unit (a day is 23 or 25 hours across daylight saving): bind the boundary as an input instead`);
  if (!unit) throw new SqlRefusal('SQL_TYPE', `interval '${text}' is not supported: write a number and second, minute or hour`);
  return Math.round(Number(m[1]) * unit);
}

/** D1's search table of a Schema (FTS5) and R*Tree of each geo field: the names `near()` and `search` read. */
export const ftsTableName = (schema: string) => `_mantle_fts_${schema}`;
export const geoTreeName = (schema: string, field: string) => `_mantle_geo_${schema}_${field}`;
const FTS5_SHADOWS = ['_data', '_idx', '_content', '_docsize', '_config'];
const RTREE_SHADOWS = ['_node', '_parent', '_rowid'];

/**
 * Declarations whose search or geo tables would name one object: `a` field `b_c` and `a_b` field `c` share a tree, and a tree
 * may be named as another's shadow table (`_node`, `_parent`, `_rowid`; FTS5's `_data` and the rest). Names fold, as SQLite's do.
 */
export function sideTableClashes(schemas: Readonly<Record<string, { readonly search?: readonly string[]; readonly fields?: Readonly<Record<string, string>> }>>): { schema: string; message: string }[] {
  const named = new Map<string, string>(); // folded table name -> the declaration that names it
  const out: { schema: string; message: string }[] = [];
  for (const [schema, s] of Object.entries(schemas)) {
    const tables = [
      ...(s.search?.length ? [{ owner: `${schema} search`, name: ftsTableName(schema), shadows: FTS5_SHADOWS }] : []),
      ...Object.entries(s.fields ?? {}).filter(([, t]) => t === 'geo').map(([f]) => ({ owner: `${schema}.${f}`, name: geoTreeName(schema, f), shadows: RTREE_SHADOWS })),
    ];
    for (const t of tables)
      for (const n of [t.name, ...t.shadows.map((x) => t.name + x)]) {
        const prior = named.get(n.toLowerCase());
        if (prior !== undefined && prior !== t.owner) out.push({ schema, message: `${t.owner} and ${prior} would both name the table ${n}: rename a Schema or a field` });
        else named.set(n.toLowerCase(), t.owner);
      }
  }
  return out;
}
