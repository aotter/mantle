/** Build-time initial SQLite DDL; applications own migrations. */
import { ftsTableName, geoTreeName, checkShapeProblem, notNullColumns, storageColumns, parseNumeric, type SqlNode } from "../spec/domain/index.js";
import type { StorageSchema } from "../core/dialect.js";
import { print } from "./print.js";

export type { StorageSchema };

const q = (id: string) => `"${id.replace(/"/g, '""')}"`;
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

function colType(t: string): "TEXT" | "INTEGER" | "REAL" {
  if (parseNumeric(t)) return "INTEGER";
  switch (t) {
    case "text": case "json": return "TEXT";
    case "integer": case "bool": case "timestamptz": case "date": return "INTEGER";
    case "real": return "REAL";
  }
  throw new Error(`no column type for ${t}`);
}

/** `stock >= 0` as IR -> `"new"."stock" >= 0`: the same printer as everything else. */
function checkText(expr: SqlNode, s: StorageSchema): string {
  const problem = checkShapeProblem(expr, storageColumns(s));
  if (problem) throw new Error(problem);
  const qualify = (v: any): any => {
    if (Array.isArray(v)) return v.map(qualify);
    if (!v || typeof v !== "object") return v;
    if (v.ColumnRef?.fields?.length === 1) return { ColumnRef: { fields: [{ String: { sval: "new" } }, v.ColumnRef.fields[0]] } };
    return Object.fromEntries(Object.entries(v).map(([k, c]) => [k, qualify(c)]));
  };
  const select: SqlNode = { SelectStmt: { targetList: [{ ResTarget: { val: qualify(expr) } }], limitOption: "LIMIT_OPTION_DEFAULT", op: "SETOP_NONE" } };
  return print(select).replace(/^SELECT\s+/i, "");
}

interface Column { readonly name: string; readonly type: string; readonly native: boolean }
interface Desired {
  readonly table: string;
  readonly columns: readonly Column[];
  readonly indexes: readonly { name: string; unique: boolean; columns: readonly string[]; sql: string }[];
  readonly triggers: readonly { name: string; sql: string }[];
  /** FTS5 / R*Tree tables with the SQL they must have been created with. */
  readonly virtuals: readonly { name: string; sql: string; rebuild: string }[];
}

function desired(name: string, s: StorageSchema): Desired {
  const t = q(name);
  const columns: Column[] = [
    { name: "_rid", type: "INTEGER", native: true },
    { name: "id", type: "TEXT", native: true },
    { name: "version", type: "INTEGER", native: true },
    { name: "created_at", type: "INTEGER", native: true },
    { name: "updated_at", type: "INTEGER", native: true },
    { name: "author_id", type: "TEXT", native: true },
    ...(s.scope ? [{ name: s.scope, type: "TEXT", native: true }] : []),
    ...(s.publishing ? [{ name: "status", type: "TEXT", native: true }, { name: "published_at", type: "INTEGER", native: false }] : []),
    // the scope field is a declared property too, but it is the native column above
    ...Object.entries(s.fields).filter(([f]) => f !== s.scope).flatMap(([f, ty]): Column[] =>
      ty === "geo" ? [{ name: `${f}_lat`, type: "REAL", native: false }, { name: `${f}_lng`, type: "REAL", native: false }] : [{ name: f, type: colType(ty), native: false }]),
  ];
  const indexes = [
    ...(s.unique ?? []).map((u, i) => ({ name: `_mantle_uq_${name}_${i}`, unique: true, columns: s.userScopes?.length ? [...new Set([...(s.scope ? [s.scope] : []), ...s.userScopes.map(x => x.column), ...u])] : s.scope && u[0] !== s.scope ? [s.scope, ...u] : [...u] })), // the grammar already starts a scoped unique index with the scope
    ...(s.indexes ?? []).map((cols, i) => ({ name: `_mantle_ix_${name}_${i}`, unique: false, columns: cols })),
  ].map((i) => ({ ...i, sql: `CREATE ${i.unique ? "UNIQUE " : ""}INDEX IF NOT EXISTS ${q(i.name)} ON ${t} (${i.columns.map(q).join(", ")})` }));

  const triggers: { name: string; sql: string }[] = [];
  (s.checks ?? []).forEach((c, i) => {
    const e = checkText(c, s);
    for (const ev of ["INSERT", "UPDATE"])
      triggers.push({ name: `_mantle_chk_${name}_${i}_${ev[0]!.toLowerCase()}`, sql: `CREATE TRIGGER ${q(`_mantle_chk_${name}_${i}_${ev[0]!.toLowerCase()}`)} BEFORE ${ev} ON ${t} WHEN NOT (${e}) BEGIN SELECT RAISE(ABORT, ${lit(`MANTLE_CHECK ${name}: ${e.replace(/\bnew\./g, "")}`)}); END` });
  });
  const virtuals: Desired["virtuals"][number][] = [];
  if (s.search?.length) {
    const fts = q(ftsTableName(name));
    const f = s.search.map(q).join(", ");
    const n = s.search.map((c) => `new.${q(c)}`).join(", ");
    const o = s.search.map((c) => `old.${q(c)}`).join(", ");
    virtuals.push({ name: ftsTableName(name), sql: `CREATE VIRTUAL TABLE ${fts} USING fts5(${f}, content=${lit(name)}, content_rowid='_rid', tokenize='trigram')`, rebuild: `INSERT INTO ${fts} (${fts}) VALUES ('rebuild')` });
    triggers.push(
      { name: `_mantle_fts_${name}_i`, sql: `CREATE TRIGGER ${q(`_mantle_fts_${name}_i`)} AFTER INSERT ON ${t} BEGIN INSERT INTO ${fts} (rowid, ${f}) VALUES (new._rid, ${n}); END` },
      { name: `_mantle_fts_${name}_d`, sql: `CREATE TRIGGER ${q(`_mantle_fts_${name}_d`)} AFTER DELETE ON ${t} BEGIN INSERT INTO ${fts} (${fts}, rowid, ${f}) VALUES ('delete', old._rid, ${o}); END` },
      { name: `_mantle_fts_${name}_u`, sql: `CREATE TRIGGER ${q(`_mantle_fts_${name}_u`)} AFTER UPDATE OF ${f} ON ${t} BEGIN INSERT INTO ${fts} (${fts}, rowid, ${f}) VALUES ('delete', old._rid, ${o}); INSERT INTO ${fts} (rowid, ${f}) VALUES (new._rid, ${n}); END` },
    );
  }
  // one R*Tree per geo field: near() reads the tree of the field it names
  for (const [geo, ty] of Object.entries(s.fields)) {
    if (ty !== "geo") continue;
    const tree = geoTreeName(name, geo);
    const g = q(tree);
    const la = q(`${geo}_lat`);
    const ln = q(`${geo}_lng`);
    virtuals.push({ name: tree, sql: `CREATE VIRTUAL TABLE ${g} USING rtree(id, minLat, maxLat, minLng, maxLng)`, rebuild: `INSERT INTO ${g} SELECT _rid, ${la}, ${la}, ${ln}, ${ln} FROM ${t} WHERE ${la} IS NOT NULL AND ${ln} IS NOT NULL` });
    triggers.push(
      { name: `${tree}_i`, sql: `CREATE TRIGGER ${q(`${tree}_i`)} AFTER INSERT ON ${t} WHEN new.${la} IS NOT NULL AND new.${ln} IS NOT NULL BEGIN INSERT INTO ${g} VALUES (new._rid, new.${la}, new.${la}, new.${ln}, new.${ln}); END` },
      { name: `${tree}_d`, sql: `CREATE TRIGGER ${q(`${tree}_d`)} AFTER DELETE ON ${t} BEGIN DELETE FROM ${g} WHERE id = old._rid; END` },
      { name: `${tree}_u`, sql: `CREATE TRIGGER ${q(`${tree}_u`)} AFTER UPDATE OF ${la}, ${ln} ON ${t} BEGIN DELETE FROM ${g} WHERE id = old._rid; INSERT INTO ${g} SELECT new._rid, new.${la}, new.${la}, new.${ln}, new.${ln} WHERE new.${la} IS NOT NULL AND new.${ln} IS NOT NULL; END` },
    );
  }
  return { table: name, columns, indexes, triggers, virtuals };
}

/** `notNull`: the columns the initial artifact (not convergence, which never alters an existing column) also declares NOT NULL. */
function createTable(d: Desired, notNull: ReadonlySet<string> = new Set()): string {
  const cols = d.columns.map((c) => {
    if (c.name === "_rid") return "_rid INTEGER PRIMARY KEY";
    if (c.name === "id") return "id TEXT NOT NULL UNIQUE";
    if (c.name === "version") return "version INTEGER NOT NULL DEFAULT 1";
    if (c.name === "created_at") return "created_at INTEGER NOT NULL";
    if (c.name === "updated_at") return "updated_at INTEGER NOT NULL DEFAULT 0";
    if (c.name === "author_id") return "author_id TEXT";
    if (c.name === "status") return "status TEXT NOT NULL DEFAULT 'draft'";
    return `${q(c.name)} ${c.type}${c.native && c.type === "TEXT" || notNull.has(c.name) ? " NOT NULL" : ""}`;
  });
  // `_rid` aliases rowid: FTS5's content_rowid and the R*Tree key on it, and an unaliased rowid may change on VACUUM
  return `CREATE TABLE IF NOT EXISTS ${q(d.table)} (${cols.join(", ")}) STRICT`;
}

/** System tables every site has. `_mantle_assert` turns a wrong `changes()` into `CONFLICT op=k` and keeps no rows. */
const SYSTEM_DDL = [
  "CREATE TABLE IF NOT EXISTS _mantle_assert (op INTEGER, ok INTEGER)",
  "CREATE TRIGGER IF NOT EXISTS _mantle_assert_t BEFORE INSERT ON _mantle_assert BEGIN SELECT CASE WHEN new.ok IS NOT 1 THEN RAISE(ABORT, 'CONFLICT op=' || new.op) ELSE RAISE(IGNORE) END; END",
  "CREATE TABLE IF NOT EXISTS _mantle_tz (from_us INTEGER PRIMARY KEY, offset_us INTEGER NOT NULL) STRICT",
];

/** Build-time initial schema artifact. Applying or migrating it is the application's responsibility. */
export function initialStorageSql(plan: Readonly<Record<string, StorageSchema>>): readonly string[] {
  // This initial artifact compiles with UTC, not an application-selected regional time zone.
  return [SYSTEM_DDL[0]!, SYSTEM_DDL[1]!, SYSTEM_DDL[2]!, "INSERT OR IGNORE INTO _mantle_tz (from_us, offset_us) VALUES (-9007199254740991, 0)", ...Object.entries(plan).flatMap(([name, schema]) => {
    const d = desired(name, schema);
    return [createTable(d, notNullColumns(schema)), ...d.indexes.map((i) => i.sql), ...d.virtuals.map((i) => i.sql), ...d.triggers.map((i) => i.sql)];
  })];
}
