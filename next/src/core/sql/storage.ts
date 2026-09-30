/**
 * Storage convergence (ADR-0033, amended by ADR-0034): the database is the state, the plan is the target.
 * Safe differences are applied in one batch; blocked ones are reported and never touched; undeclared ones
 * are reported and never dropped. STRICT tables, checks as triggers, and the FTS5 / R*Tree tables that back
 * `search` and `format: geo` are Mantle's own and are rebuilt when their declaration changes.
 */
import { parseNumeric, type SqlNode, type SqlSchemaDef } from "../../spec/index.js";
import type { DatabaseDriver, SqlStatement } from "../driver.js";
import { print } from "./print.js";
import { transitions, tzStatements } from "./tz.js";

export interface StorageSchema extends SqlSchemaDef {
  /** Boolean expressions over the row's own columns (IR), enforced by triggers that only RAISE. */
  readonly checks?: readonly SqlNode[];
  /** Fields indexed by FTS5 (trigram). */
  readonly search?: readonly string[];
  /** Unique constraints; on a scoped Schema the scope column is added. */
  readonly unique?: readonly (readonly string[])[];
}

export interface StorageChange {
  readonly schema: string;
  readonly code: "STORAGE_CHANGE_BLOCKED" | "STORAGE_TABLE_NOT_OWNED" | "STORAGE_UNDECLARED_COLUMN" | "STORAGE_UNDECLARED_INDEX";
  readonly message: string;
}

export interface StorageReport {
  /** Fingerprint matched: nothing but the fingerprint was read. */
  readonly skipped: boolean;
  readonly blocked: readonly StorageChange[];
  readonly undeclared: readonly StorageChange[];
}

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
function checkText(expr: SqlNode): string {
  if (JSON.stringify(expr).includes('"SubLink"')) throw new Error("a check reads only the row's own columns, never a subquery");
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
    ...(s.scope ? [{ name: s.scope, type: "TEXT", native: true }] : []),
    ...(s.ttl ? [{ name: s.ttl, type: "INTEGER", native: true }] : []),
    ...(s.publishing ? [{ name: "status", type: "TEXT", native: true }] : []),
    ...Object.entries(s.fields).flatMap(([f, ty]): Column[] =>
      ty === "geo" ? [{ name: `${f}_lat`, type: "REAL", native: false }, { name: `${f}_lng`, type: "REAL", native: false }] : [{ name: f, type: colType(ty), native: false }]),
  ];
  const indexes = [
    ...(s.scope ? [{ name: `_mantle_scope_${name}`, unique: false, columns: [s.scope] }] : []),

    ...(s.unique ?? []).map((u, i) => ({ name: `_mantle_uq_${name}_${i}`, unique: true, columns: s.scope && u[0] !== s.scope ? [s.scope, ...u] : [...u] })), // the grammar already starts a scoped unique index with the scope
  ].map((i) => ({ ...i, sql: `CREATE ${i.unique ? "UNIQUE " : ""}INDEX ${q(i.name)} ON ${t} (${i.columns.map(q).join(", ")})` }));

  const triggers: { name: string; sql: string }[] = [];
  (s.checks ?? []).forEach((c, i) => {
    const e = checkText(c);
    for (const ev of ["INSERT", "UPDATE"])
      triggers.push({ name: `_mantle_chk_${name}_${i}_${ev[0]!.toLowerCase()}`, sql: `CREATE TRIGGER ${q(`_mantle_chk_${name}_${i}_${ev[0]!.toLowerCase()}`)} BEFORE ${ev} ON ${t} WHEN NOT (${e}) BEGIN SELECT RAISE(ABORT, ${lit(`CHECK ${name}: ${e.replace(/\bnew\./g, "")}`)}); END` });
  });
  const virtuals: Desired["virtuals"][number][] = [];
  if (s.search?.length) {
    const fts = q(`_mantle_fts_${name}`);
    const f = s.search.map(q).join(", ");
    const n = s.search.map((c) => `new.${q(c)}`).join(", ");
    const o = s.search.map((c) => `old.${q(c)}`).join(", ");
    virtuals.push({ name: `_mantle_fts_${name}`, sql: `CREATE VIRTUAL TABLE ${fts} USING fts5(${f}, content=${lit(name)}, content_rowid='_rid', tokenize='trigram')`, rebuild: `INSERT INTO ${fts} (${fts}) VALUES ('rebuild')` });
    triggers.push(
      { name: `_mantle_fts_${name}_i`, sql: `CREATE TRIGGER ${q(`_mantle_fts_${name}_i`)} AFTER INSERT ON ${t} BEGIN INSERT INTO ${fts} (rowid, ${f}) VALUES (new._rid, ${n}); END` },
      { name: `_mantle_fts_${name}_d`, sql: `CREATE TRIGGER ${q(`_mantle_fts_${name}_d`)} AFTER DELETE ON ${t} BEGIN INSERT INTO ${fts} (${fts}, rowid, ${f}) VALUES ('delete', old._rid, ${o}); END` },
      { name: `_mantle_fts_${name}_u`, sql: `CREATE TRIGGER ${q(`_mantle_fts_${name}_u`)} AFTER UPDATE OF ${f} ON ${t} BEGIN INSERT INTO ${fts} (${fts}, rowid, ${f}) VALUES ('delete', old._rid, ${o}); INSERT INTO ${fts} (rowid, ${f}) VALUES (new._rid, ${n}); END` },
    );
  }
  const geo = Object.entries(s.fields).find(([, ty]) => ty === "geo")?.[0];
  if (geo) {
    const g = q(`_mantle_geo_${name}`);
    const la = q(`${geo}_lat`);
    const ln = q(`${geo}_lng`);
    virtuals.push({ name: `_mantle_geo_${name}`, sql: `CREATE VIRTUAL TABLE ${g} USING rtree(id, minLat, maxLat, minLng, maxLng)`, rebuild: `INSERT INTO ${g} SELECT _rid, ${la}, ${la}, ${ln}, ${ln} FROM ${t} WHERE ${la} IS NOT NULL AND ${ln} IS NOT NULL` });
    triggers.push(
      { name: `_mantle_geo_${name}_i`, sql: `CREATE TRIGGER ${q(`_mantle_geo_${name}_i`)} AFTER INSERT ON ${t} WHEN new.${la} IS NOT NULL AND new.${ln} IS NOT NULL BEGIN INSERT INTO ${g} VALUES (new._rid, new.${la}, new.${la}, new.${ln}, new.${ln}); END` },
      { name: `_mantle_geo_${name}_d`, sql: `CREATE TRIGGER ${q(`_mantle_geo_${name}_d`)} AFTER DELETE ON ${t} BEGIN DELETE FROM ${g} WHERE id = old._rid; END` },
      { name: `_mantle_geo_${name}_u`, sql: `CREATE TRIGGER ${q(`_mantle_geo_${name}_u`)} AFTER UPDATE OF ${la}, ${ln} ON ${t} BEGIN DELETE FROM ${g} WHERE id = old._rid; INSERT INTO ${g} SELECT new._rid, new.${la}, new.${la}, new.${ln}, new.${ln} WHERE new.${la} IS NOT NULL AND new.${ln} IS NOT NULL; END` },
    );
  }
  return { table: name, columns, indexes, triggers, virtuals };
}

function createTable(d: Desired): string {
  const cols = d.columns.map((c) => {
    if (c.name === "_rid") return "_rid INTEGER PRIMARY KEY";
    if (c.name === "id") return "id TEXT NOT NULL UNIQUE";
    if (c.name === "version") return "version INTEGER NOT NULL DEFAULT 1";
    if (c.name === "created_at") return "created_at INTEGER NOT NULL";
    if (c.name === "status") return "status TEXT NOT NULL DEFAULT 'draft'";
    return `${q(c.name)} ${c.type}${c.native && c.type === "TEXT" ? " NOT NULL" : ""}`;
  });
  // `_rid` aliases rowid: FTS5's content_rowid and the R*Tree key on it, and an unaliased rowid may change on VACUUM
  return `CREATE TABLE ${q(d.table)} (${cols.join(", ")}) STRICT`;
}

/** System tables every site has. `_mantle_assert` turns a wrong `changes()` into `CONFLICT op=k` and keeps no rows. */
const SYSTEM_DDL = [
  "CREATE TABLE IF NOT EXISTS _mantle_assert (op INTEGER, ok INTEGER)",
  "CREATE TRIGGER IF NOT EXISTS _mantle_assert_t BEFORE INSERT ON _mantle_assert BEGIN SELECT CASE WHEN new.ok IS NOT 1 THEN RAISE(ABORT, 'CONFLICT op=' || new.op) ELSE RAISE(IGNORE) END; END",
  "CREATE TABLE IF NOT EXISTS _mantle_tz (from_us INTEGER PRIMARY KEY, offset_us INTEGER NOT NULL) STRICT",
  "CREATE TABLE IF NOT EXISTS _mantle_boot_state (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT",
  "CREATE TABLE IF NOT EXISTS _mantle_schema_tables (name TEXT PRIMARY KEY) STRICT",
];

type Row = Record<string, unknown>;

/** Converge storage to the plan. Blocked differences are reported and applied to nothing; a matching fingerprint reads nothing else. */
export async function convergeStorage(
  driver: DatabaseDriver,
  plan: Readonly<Record<string, StorageSchema>>,
  options: { fingerprint: string; timeZone?: string },
): Promise<StorageReport> {
  const timeZone = options.timeZone ?? "UTC";
  const state = `${options.fingerprint}|${timeZone}`;
  await driver.batch(SYSTEM_DDL.map((sql) => ({ sql })));
  const [stored] = await driver.batch([{ sql: "SELECT value FROM _mantle_boot_state WHERE key = 'fingerprint'" }]);
  if (stored!.rows[0]?.value === state) return { skipped: true, blocked: [], undeclared: [] };

  for (let attempt = 0; ; attempt++) {
    const { statements, blocked, undeclared, uniques } = await diff(driver, plan);
    if (blocked.length) return { skipped: false, blocked, undeclared };
    statements.push(...tzStatements(transitions(timeZone)).map((sql) => ({ sql })));
    statements.push({ sql: "INSERT OR REPLACE INTO _mantle_boot_state (key, value) VALUES ('fingerprint', ?1)", binds: [state] });
    try {
      await driver.batch(statements);
      return { skipped: false, blocked: [], undeclared };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // a concurrent cold start applied the same ADD COLUMN: introspect again and let the diff decide
      if (/duplicate column name/i.test(message) && attempt < 2) continue;
      if (/UNIQUE constraint failed/i.test(message) && uniques.length)
        return { skipped: false, blocked: uniques.map((u) => ({ schema: u.schema, code: "STORAGE_CHANGE_BLOCKED", message: `unique index ${u.index} cannot be created: existing rows break it (${message}); dedupe the data, then rerun` })), undeclared };
      throw e;
    }
  }
}

async function diff(driver: DatabaseDriver, plan: Readonly<Record<string, StorageSchema>>) {
  const statements: SqlStatement[] = [];
  const blocked: StorageChange[] = [];
  const undeclared: StorageChange[] = [];
  const uniques: { schema: string; index: string }[] = [];
  const block = (schema: string, message: string, code: StorageChange["code"] = "STORAGE_CHANGE_BLOCKED") => blocked.push({ schema, code, message });

  const [objects, owned] = await driver.batch([
    { sql: "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\'" },
    { sql: "SELECT name FROM _mantle_schema_tables" },
  ]);
  const byName = new Map<string, Row>(objects!.rows.map((r) => [String(r.name), r]));
  const ownedNames = new Set(owned!.rows.map((r) => String(r.name)));

  for (const [name, schema] of Object.entries(plan)) {
    const d = desired(name, schema);
    const t = q(name);
    const existing = byName.get(name);
    if (existing && !ownedNames.has(name)) {
      block(name, `table ${name} exists and Mantle did not create it, so it is not read or written`, "STORAGE_TABLE_NOT_OWNED");
      continue;
    }
    if (!existing) {
      statements.push({ sql: createTable(d) }, { sql: "INSERT OR IGNORE INTO _mantle_schema_tables (name) VALUES (?1)", binds: [name] }, ...d.indexes.map((i) => ({ sql: i.sql })));
      if (d.indexes.some((i) => i.unique)) for (const i of d.indexes) if (i.unique) uniques.push({ schema: name, index: i.name });
    } else {
      const [info, idx] = await driver.batch([
        { sql: "SELECT name, type FROM pragma_table_info(?1)", binds: [name] },
        { sql: "SELECT il.name AS name, il.\"unique\" AS uniq, il.origin AS origin, ii.name AS col FROM pragma_index_list(?1) il, pragma_index_info(il.name) ii ORDER BY il.name, ii.seqno", binds: [name] },
      ]);
      const have = new Map(info!.rows.map((r) => [String(r.name), String(r.type).toUpperCase()]));
      for (const c of d.columns) {
        const actual = have.get(c.name);
        if (actual === undefined) {
          if (c.native) block(name, `${name} lacks the native column ${c.name}; add it, or copy the data into a table Mantle creates`);
          else statements.push({ sql: `ALTER TABLE ${t} ADD COLUMN ${q(c.name)} ${c.type}` });
        } else if (actual !== c.type && !(c.name === "_rid" && actual === "INTEGER")) block(name, `${name}.${c.name} is ${actual}, the plan says ${c.type}; a column's type is never altered`);
      }
      const declared = new Set(d.columns.map((c) => c.name));
      for (const c of have.keys()) if (!declared.has(c)) undeclared.push({ schema: name, code: "STORAGE_UNDECLARED_COLUMN", message: `${name}.${c} is in the database and not in the plan; it is kept` });

      const actualIdx = new Map<string, { unique: boolean; cols: string[]; origin: string }>();
      for (const r of idx!.rows) {
        const e = actualIdx.get(String(r.name)) ?? { unique: r.uniq === 1, cols: [], origin: String(r.origin) };
        e.cols.push(String(r.col));
        actualIdx.set(String(r.name), e);
      }
      for (const i of d.indexes) {
        const a = actualIdx.get(i.name);
        if (!a) {
          statements.push({ sql: i.sql });
          if (i.unique) uniques.push({ schema: name, index: i.name });
        } else if (a.unique !== i.unique || a.cols.join() !== i.columns.join()) block(name, `index ${i.name} exists with other columns or uniqueness; drop it and rerun`);
      }
      const declaredIdx = new Set(d.indexes.map((i) => i.name));
      for (const [n, a] of actualIdx) {
        if (declaredIdx.has(n) || a.origin !== "c") continue; // sqlite_autoindex and primary keys are not ours to judge
        if (a.unique) block(name, `undeclared unique index ${n} still constrains writes; drop it or declare it`);
        else undeclared.push({ schema: name, code: "STORAGE_UNDECLARED_INDEX", message: `index ${n} is in the database and not in the plan; it is kept` });
      }
    }
    // Mantle's own triggers and search / geo tables: rebuilt when their declaration changes, dropped when it goes away
    const wantTriggers = new Set(d.triggers.map((x) => x.name));
    for (const r of byName.values())
      if (r.type === "trigger" && r.tbl_name === name && String(r.name).startsWith("_mantle_") && !wantTriggers.has(String(r.name))) statements.push({ sql: `DROP TRIGGER IF EXISTS ${q(String(r.name))}` });
    const wantVirtual = new Set(d.virtuals.map((v) => v.name));
    for (const prefix of ["_mantle_fts_", "_mantle_geo_"]) {
      const n = `${prefix}${name}`;
      if (byName.has(n) && !wantVirtual.has(n)) statements.push({ sql: `DROP TABLE IF EXISTS ${q(n)}` });
    }
    for (const v of d.virtuals) {
      const cur = byName.get(v.name);
      if (cur?.sql === v.sql) continue;
      // a virtual table's triggers reference it, so they are dropped and recreated with it
      statements.push({ sql: `DROP TABLE IF EXISTS ${q(v.name)}` }, { sql: v.sql }, { sql: v.rebuild });
    }
    for (const tr of d.triggers) {
      if (byName.get(tr.name)?.sql !== tr.sql) statements.push({ sql: `DROP TRIGGER IF EXISTS ${q(tr.name)}` }, { sql: tr.sql });
    }
  }
  return { statements, blocked, undeclared, uniques };
}
