/**
 * Storage convergence (ADR-0033, amended by ADR-0034): the database is the state, the plan is the target.
 * Safe differences are applied in one batch; blocked ones are reported and never touched; undeclared ones
 * are reported and never dropped. STRICT tables, checks as triggers, and the FTS5 / R*Tree tables that back
 * `search` and `format: geo` are Mantle's own and are rebuilt when their declaration changes.
 */
import { parseNumeric, type SqlNode } from "../spec/domain/index.js";
import type { DatabaseDriver, SqlStatement } from "../core/driver.js";
import type { StorageSchema } from "../core/dialect.js";
import { print } from "./print.js";
import { transitions, tzStatements } from "./tz.js";

export type { StorageSchema };

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
    { name: "updated_at", type: "INTEGER", native: true },
    { name: "author_id", type: "TEXT", native: true },
    ...(s.scope ? [{ name: s.scope, type: "TEXT", native: true }] : []),
    ...(s.publishing ? [{ name: "status", type: "TEXT", native: true }] : []),
    // the scope field is a declared property too, but it is the native column above
    ...Object.entries(s.fields).filter(([f]) => f !== s.scope).flatMap(([f, ty]): Column[] =>
      ty === "geo" ? [{ name: `${f}_lat`, type: "REAL", native: false }, { name: `${f}_lng`, type: "REAL", native: false }] : [{ name: f, type: colType(ty), native: false }]),
  ];
  const indexes = [
    ...(s.scope ? [{ name: `_mantle_scope_${name}`, unique: false, columns: [s.scope] }] : []),
    ...(s.unique ?? []).map((u, i) => ({ name: `_mantle_uq_${name}_${i}`, unique: true, columns: s.scope && u[0] !== s.scope ? [s.scope, ...u] : [...u] })), // the grammar already starts a scoped unique index with the scope
    ...(s.indexes ?? []).map((cols, i) => ({ name: `_mantle_ix_${name}_${i}`, unique: false, columns: cols })),
  ].map((i) => ({ ...i, sql: `CREATE ${i.unique ? "UNIQUE " : ""}INDEX IF NOT EXISTS ${q(i.name)} ON ${t} (${i.columns.map(q).join(", ")})` }));

  const triggers: { name: string; sql: string }[] = [];
  (s.checks ?? []).forEach((c, i) => {
    const e = checkText(c);
    for (const ev of ["INSERT", "UPDATE"])
      triggers.push({ name: `_mantle_chk_${name}_${i}_${ev[0]!.toLowerCase()}`, sql: `CREATE TRIGGER ${q(`_mantle_chk_${name}_${i}_${ev[0]!.toLowerCase()}`)} BEFORE ${ev} ON ${t} WHEN NOT (${e}) BEGIN SELECT RAISE(ABORT, ${lit(`MANTLE_CHECK ${name}: ${e.replace(/\bnew\./g, "")}`)}); END` });
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
  // one R*Tree per geo field: near() reads the tree of the field it names
  for (const [geo, ty] of Object.entries(s.fields)) {
    if (ty !== "geo") continue;
    const tree = `_mantle_geo_${name}_${geo}`;
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

function createTable(d: Desired): string {
  const cols = d.columns.map((c) => {
    if (c.name === "_rid") return "_rid INTEGER PRIMARY KEY";
    if (c.name === "id") return "id TEXT NOT NULL UNIQUE";
    if (c.name === "version") return "version INTEGER NOT NULL DEFAULT 1";
    if (c.name === "created_at") return "created_at INTEGER NOT NULL";
    if (c.name === "updated_at") return "updated_at INTEGER NOT NULL DEFAULT 0";
    if (c.name === "author_id") return "author_id TEXT";
    if (c.name === "status") return "status TEXT NOT NULL DEFAULT 'draft'";
    return `${q(c.name)} ${c.type}${c.native && c.type === "TEXT" ? " NOT NULL" : ""}`;
  });
  // `_rid` aliases rowid: FTS5's content_rowid and the R*Tree key on it, and an unaliased rowid may change on VACUUM
  return `CREATE TABLE IF NOT EXISTS ${q(d.table)} (${cols.join(", ")}) STRICT`;
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
  await driver.batch([...SYSTEM_DDL.map((sql) => ({ sql })), { sql: "INSERT OR IGNORE INTO _mantle_boot_state (key, value) VALUES ('instance', ?1)", binds: [crypto.randomUUID()] }]);
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
      if (/duplicate column name|already exists/i.test(message) && attempt < 2) continue;
      if (/UNIQUE constraint failed/i.test(message) && uniques.length)
        return { skipped: false, blocked: uniques.map((u) => ({ schema: u.schema, code: "STORAGE_CHANGE_BLOCKED", message: `unique index ${u.index} cannot be created: existing rows break it (${message}); dedupe the data, then rerun` })), undeclared };
      throw e;
    }
  }
}

/** Tables the platform creates itself (Better Auth, media, site config); a Schema may not take these names. */
const RESERVED_TABLES = new Set([
  "entries", "_migrations", "d1_migrations", "site_config", "user", "session", "account", "verification", "jwks",
  "oauthclient", "oauthresource", "oauthclientresource", "oauthrefreshtoken", "oauthaccesstoken", "oauthconsent", "oauthclientassertion",
  "media_assets", "pending_media_uploads",
]);

/**
 * What `convergeStorage` would apply to this database now, applying nothing (`mantle generate --check`, ADR-0033 decision 3).
 * `skipped` when the database already booted this fingerprint, as boot would. The SQL replays: system DDL (only where Mantle
 * never booted) is `IF NOT EXISTS`, `ADD COLUMN` comes from the current state, binds are inlined. The boot state and time
 * zone rows are left to boot.
 */
export async function planStorageChanges(driver: DatabaseDriver, plan: Readonly<Record<string, StorageSchema>>, options: { fingerprint?: string } = {}): Promise<{ skipped: boolean; sql: string[]; blocked: readonly StorageChange[]; undeclared: readonly StorageChange[] }> {
  const [sys] = await driver.batch([{ sql: "SELECT name FROM sqlite_schema WHERE name IN ('_mantle_boot_state', '_mantle_schema_tables')" }]);
  const have = new Set(sys!.rows.map((r) => r.name));
  if (options.fingerprint !== undefined && have.has("_mantle_boot_state")) {
    const [b] = await driver.batch([{ sql: "SELECT value FROM _mantle_boot_state WHERE key = 'fingerprint'" }]);
    if (String(b!.rows[0]?.value ?? "").startsWith(`${options.fingerprint}|`)) return { skipped: true, sql: [], blocked: [], undeclared: [] };
  }
  const { statements, blocked, undeclared } = await diff(driver, plan);
  const inline = (s: SqlStatement) => (s.binds ? s.sql.replace(/\?(\d+)/g, (_, n: string) => lit(String(s.binds![Number(n) - 1]))) : s.sql);
  return { skipped: false, sql: [...(have.has("_mantle_schema_tables") ? [] : SYSTEM_DDL), ...statements.map(inline)], blocked, undeclared };
}

async function diff(driver: DatabaseDriver, plan: Readonly<Record<string, StorageSchema>>) {
  const statements: SqlStatement[] = [];
  const blocked: StorageChange[] = [];
  const undeclared: StorageChange[] = [];
  const uniques: { schema: string; index: string }[] = [];
  const block = (schema: string, message: string, code: StorageChange["code"] = "STORAGE_CHANGE_BLOCKED") => blocked.push({ schema, code, message });

  const [objects] = await driver.batch([{ sql: "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\'" }]);
  // SQLite identifiers are case-insensitive, so ownership and lookup are too.
  const byName = new Map<string, Row>(objects!.rows.map((r) => [String(r.name).toLowerCase(), r]));
  // a dry run creates nothing, so on a database Mantle never booted the registry does not exist yet
  const owned = !byName.has("_mantle_schema_tables") ? [] : (await driver.batch([{ sql: "SELECT name FROM _mantle_schema_tables" }]))[0]!.rows;
  const ownedNames = new Set(owned.map((r) => String(r.name).toLowerCase()));

  for (const [name, schema] of Object.entries(plan)) {
    const d = desired(name, schema);
    const t = q(name);
    if (RESERVED_TABLES.has(name.toLowerCase()) || name.toLowerCase().startsWith("_mantle_")) {
      block(name, `table name ${name} is reserved for Mantle and Better Auth`, "STORAGE_TABLE_NOT_OWNED");
      continue;
    }
    const existing = byName.get(name.toLowerCase());
    if (existing && !ownedNames.has(name.toLowerCase())) {
      block(name, `table ${name} exists and Mantle did not create it, so it is not read or written`, "STORAGE_TABLE_NOT_OWNED");
      continue;
    }
    if (!existing) {
      statements.push({ sql: createTable(d) }, { sql: "INSERT OR IGNORE INTO _mantle_schema_tables (name) VALUES (?1)", binds: [name] }, ...d.indexes.map((i) => ({ sql: i.sql })));
      if (d.indexes.some((i) => i.unique)) for (const i of d.indexes) if (i.unique) uniques.push({ schema: name, index: i.name });
    } else {
      const [info, idx] = await driver.batch([
        { sql: "SELECT name, type, pk FROM pragma_table_info(?1)", binds: [name] },
        { sql: "SELECT il.name AS name, il.\"unique\" AS uniq, il.origin AS origin, il.partial AS partial, ii.name AS col FROM pragma_index_list(?1) il, pragma_index_info(il.name) ii ORDER BY il.name, ii.seqno", binds: [name] },
      ]);
      const have = new Map(info!.rows.map((r) => [String(r.name), String(r.type).toUpperCase()]));
      const pk = new Map(info!.rows.map((r) => [String(r.name), Number(r.pk)]));
      for (const c of d.columns) {
        const actual = have.get(c.name);
        if (actual === undefined) {
          if (c.name === "_rid") block(name, `${name} has no _rid, which must be the table's INTEGER PRIMARY KEY (the rowid alias FTS5 and the R*Tree key on) and cannot be added to a table; copy the data into a table Mantle creates`);
          else if (c.native) block(name, `${name} lacks the native column ${c.name}; add it, or copy the data into a table Mantle creates`);
          else statements.push({ sql: `ALTER TABLE ${t} ADD COLUMN ${q(c.name)} ${c.type}` });
        } else if (c.name === "_rid" && pk.get("_rid") !== 1) block(name, `${name}._rid is not the table's INTEGER PRIMARY KEY, so it does not alias the rowid; copy the data into a table Mantle creates`);
        else if (actual !== c.type && !(c.name === "_rid" && actual === "INTEGER")) block(name, `${name}.${c.name} is ${actual}, the plan says ${c.type}; a column's type is never altered`);
      }
      const declared = new Set(d.columns.map((c) => c.name));
      for (const c of have.keys()) if (!declared.has(c)) undeclared.push({ schema: name, code: "STORAGE_UNDECLARED_COLUMN", message: `${name}.${c} is in the database and not in the plan; it is kept` });

      const actualIdx = new Map<string, { unique: boolean; cols: string[]; origin: string; partial: boolean }>();
      for (const r of idx!.rows) {
        const e = actualIdx.get(String(r.name)) ?? { unique: r.uniq === 1, cols: [], origin: String(r.origin), partial: r.partial === 1 };
        e.cols.push(String(r.col));
        actualIdx.set(String(r.name), e);
      }
      for (const i of d.indexes) {
        const a = actualIdx.get(i.name);
        if (!a) {
          statements.push({ sql: i.sql });
          if (i.unique) uniques.push({ schema: name, index: i.name });
        } else if (a.unique !== i.unique || a.partial || a.cols.join() !== i.columns.join()) block(name, `index ${i.name} exists with other columns, uniqueness or a WHERE; drop it and rerun`);
      }
      const declaredIdx = new Set(d.indexes.map((i) => i.name));
      for (const [n, a] of actualIdx) {
        // a column UNIQUE is a constraint too, and it would leak across owners; only the `id` UNIQUE (ours) and primary keys pass
        if (a.origin === "u" && a.unique && a.cols.join() !== "id") block(name, `${name} has a UNIQUE constraint on ${a.cols.join(", ")} that Mantle did not declare; it still constrains writes`);
        if (declaredIdx.has(n) || a.origin !== "c") continue;
        if (a.unique) block(name, `undeclared unique index ${n} still constrains writes; drop it or declare it`);
        else undeclared.push({ schema: name, code: "STORAGE_UNDECLARED_INDEX", message: `index ${n} is in the database and not in the plan; it is kept` });
      }
    }
    // Mantle's own triggers and search / geo tables: rebuilt when their declaration changes, dropped when it goes away
    const wantTriggers = new Set(d.triggers.map((x) => x.name));
    for (const r of byName.values())
      if (r.type === "trigger" && r.tbl_name === name && String(r.name).startsWith("_mantle_") && !wantTriggers.has(String(r.name))) {
        statements.push({ sql: `DROP TRIGGER IF EXISTS ${q(String(r.name))}` });
        // the insert trigger of a search or geo table names it: a declaration that went away takes its table with it (a name
        // alone is not evidence, an FTS5 or R*Tree shadow table of another Schema can look the same)
        const tree = /^(_mantle_(?:fts|geo)_.+)_i$/.exec(String(r.name));
        if (tree && byName.get(tree[1]!)?.sql?.toString().startsWith("CREATE VIRTUAL TABLE")) statements.push({ sql: `DROP TABLE IF EXISTS ${q(tree[1]!)}` });
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
