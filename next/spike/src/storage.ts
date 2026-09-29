// Storage convergence for a set of Schemas (ADR-0034 decision 5 and 9): STRICT tables, checks as
// triggers that only RAISE, FTS5 (trigram) and R*Tree kept in step by triggers, and the system tables.
// Idempotent statements are not the point in the spike: every case starts from an empty D1.
import { parseSync } from 'libpg-query';
import type { N, SchemaDef, Schemas } from './types.ts';
import { print } from './print.ts';
import { parseNumeric } from './codec.ts';

const q = (id: string) => `"${id.replace(/"/g, '""')}"`;
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

function colType(t: string): string {
  if (parseNumeric(t)) return 'INTEGER';
  switch (t) {
    case 'text': case 'json': return 'TEXT';
    case 'integer': case 'bool': case 'timestamptz': case 'date': return 'INTEGER';
    case 'real': return 'REAL';
  }
  throw new Error(`no column type for ${t}`);
}

/** `stock >= 0` -> `"NEW"."stock" >= 0`, printed by the same deparser as everything else */
function checkExpr(expr: string): string {
  const tree: any = parseSync(`SELECT 1 WHERE ${expr}`);
  const where = tree.stmts[0].stmt.SelectStmt.whereClause;
  if (JSON.stringify(where).includes('"SubLink"')) throw new Error(`check "${expr}" reads a subquery: a check reads only the row's own columns`);
  const go = (v: any): any => {
    if (Array.isArray(v)) return v.map(go);
    if (!v || typeof v !== 'object') return v;
    if (v.ColumnRef?.fields?.length === 1) return { ColumnRef: { fields: [{ String: { sval: 'new' } }, v.ColumnRef.fields[0]] } };
    return Object.fromEntries(Object.entries(v).filter(([k]) => k !== 'location').map(([k, c]) => [k, go(c)]));
  };
  const sel: N = { SelectStmt: { targetList: [{ ResTarget: { val: go(where) } }], limitOption: 'LIMIT_OPTION_DEFAULT', op: 'SETOP_NONE' } };
  return print(sel).replace(/^SELECT\s+/i, '');
}

export function schemaDdl(name: string, s: SchemaDef): string[] {
  const t = q(name);
  // `_rid` aliases rowid: FTS5 content_rowid and the R*Tree key on it, and an unaliased rowid may change on VACUUM
  const cols = [
    '_rid INTEGER PRIMARY KEY', 'id TEXT NOT NULL UNIQUE', 'version INTEGER NOT NULL DEFAULT 1', 'created_at INTEGER NOT NULL',
    ...(s.scope ? [`${q(s.scope)} TEXT NOT NULL`] : []),
    ...(s.ttl ? [`${q(s.ttl)} INTEGER`] : []),
    ...(s.publishing ? ["status TEXT NOT NULL DEFAULT 'draft'"] : []),
    ...Object.entries(s.fields).flatMap(([f, ty]) => (ty === 'geo' ? [`${q(f + '_lat')} REAL`, `${q(f + '_lng')} REAL`] : [`${q(f)} ${colType(ty)}`])),
  ];
  const out = [`CREATE TABLE ${t} (${cols.join(', ')}) STRICT`];
  if (s.scope) out.push(`CREATE INDEX ${q(`_mantle_scope_${name}`)} ON ${t} (${q(s.scope)})`);
  (s.unique ?? []).forEach((u, i) => out.push(`CREATE UNIQUE INDEX ${q(`_mantle_uq_${name}_${i}`)} ON ${t} (${[...(s.scope ? [s.scope] : []), ...u].map(q).join(', ')})`)); // unique includes the scope: a collision can only be with the caller's own rows
  (s.checks ?? []).forEach((c, i) => {
    const e = checkExpr(c);
    for (const ev of ['INSERT', 'UPDATE'])
      out.push(`CREATE TRIGGER ${q(`_mantle_chk_${name}_${i}_${ev[0].toLowerCase()}`)} BEFORE ${ev} ON ${t} WHEN NOT (${e}) BEGIN SELECT RAISE(ABORT, ${lit(`CHECK ${name}: ${c}`)}); END`);
  });
  if (s.search?.length) {
    const fts = q(`_mantle_fts_${name}`), f = s.search.map(q).join(', '), n = s.search.map((c) => `new.${q(c)}`).join(', '), o = s.search.map((c) => `old.${q(c)}`).join(', ');
    out.push(
      `CREATE VIRTUAL TABLE ${fts} USING fts5(${f}, content=${lit(name)}, content_rowid='rowid', tokenize='trigram')`,
      `CREATE TRIGGER ${q(`_mantle_fts_${name}_i`)} AFTER INSERT ON ${t} BEGIN INSERT INTO ${fts} (rowid, ${f}) VALUES (new.rowid, ${n}); END`,
      `CREATE TRIGGER ${q(`_mantle_fts_${name}_d`)} AFTER DELETE ON ${t} BEGIN INSERT INTO ${fts} (${fts}, rowid, ${f}) VALUES ('delete', old.rowid, ${o}); END`,
      `CREATE TRIGGER ${q(`_mantle_fts_${name}_u`)} AFTER UPDATE OF ${f} ON ${t} BEGIN INSERT INTO ${fts} (${fts}, rowid, ${f}) VALUES ('delete', old.rowid, ${o}); INSERT INTO ${fts} (rowid, ${f}) VALUES (new.rowid, ${n}); END`,
    );
  }
  const geo = Object.entries(s.fields).find(([, ty]) => ty === 'geo')?.[0];
  if (geo) {
    const g = q(`_mantle_geo_${name}`), la = q(geo + '_lat'), ln = q(geo + '_lng');
    out.push(
      `CREATE VIRTUAL TABLE ${g} USING rtree(id, minLat, maxLat, minLng, maxLng)`,
      `CREATE TRIGGER ${q(`_mantle_geo_${name}_i`)} AFTER INSERT ON ${t} WHEN new.${la} IS NOT NULL AND new.${ln} IS NOT NULL BEGIN INSERT INTO ${g} VALUES (new.rowid, new.${la}, new.${la}, new.${ln}, new.${ln}); END`,
      `CREATE TRIGGER ${q(`_mantle_geo_${name}_d`)} AFTER DELETE ON ${t} BEGIN DELETE FROM ${g} WHERE id = old.rowid; END`,
      `CREATE TRIGGER ${q(`_mantle_geo_${name}_u`)} AFTER UPDATE OF ${la}, ${ln} ON ${t} BEGIN DELETE FROM ${g} WHERE id = old.rowid; INSERT INTO ${g} SELECT new.rowid, new.${la}, new.${la}, new.${ln}, new.${ln} WHERE new.${la} IS NOT NULL AND new.${ln} IS NOT NULL; END`,
    );
  }
  return out;
}

/** System tables every site has. `_mantle_assert` turns a wrong `changes()` into CONFLICT op=k and keeps no rows. */
export const systemDdl = [
  'CREATE TABLE _mantle_assert (op INTEGER, ok INTEGER)',
  "CREATE TRIGGER _mantle_assert_t BEFORE INSERT ON _mantle_assert BEGIN SELECT CASE WHEN new.ok IS NOT 1 THEN RAISE(ABORT, 'CONFLICT op=' || new.op) ELSE RAISE(IGNORE) END; END",
  'CREATE TABLE _mantle_tz (from_us INTEGER PRIMARY KEY, offset_us INTEGER NOT NULL) STRICT',
];

export const storageDdl = (schemas: Schemas) => [...systemDdl, ...Object.entries(schemas).flatMap(([n, s]) => schemaDdl(n, s))];
