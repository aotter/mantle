/**
 * Storage convergence on PostgreSQL (ADR-0033, as D1 applies it): the database is the state, the plan is the target. Safe
 * differences are applied in one transaction; blocked ones are reported and never touched; undeclared ones are reported and
 * kept. Columns have native types; a Schema check is a CHECK constraint added NOT VALID, so it binds every later write and
 * leaves rows that predate it alone, as D1's trigger does.
 */
import { hasSubLink, type SqlNode } from "../spec/domain/index.js";
import type { StorageSchema } from "../core/dialect.js";
import { query, transaction, type PgConnect, type PgStatement } from "./driver.js";
import { pgType } from "./codec.js";
import { print, typed } from "./print.js";

export interface StorageChange {
  readonly schema: string;
  readonly code: "STORAGE_CHANGE_BLOCKED" | "STORAGE_TABLE_NOT_OWNED" | "STORAGE_UNDECLARED_COLUMN" | "STORAGE_UNDECLARED_INDEX";
  readonly message: string;
}
export interface StorageReport {
  readonly skipped: boolean;
  readonly blocked: readonly StorageChange[];
  readonly undeclared: readonly StorageChange[];
}

const q = (id: string) => `"${id.replace(/"/g, '""')}"`;
/** PostgreSQL truncates a name past 63 bytes; a long one keeps a readable prefix and a hash, so it is still found by name. */
const ident = (n: string) => (new TextEncoder().encode(n).length <= 63 ? n : `${n.slice(0, 50)}_${fnv(n)}`);
/** FNV-1a, 32 bits, as hex: a stable suffix that needs no crypto module. */
const fnv = (s: string) => [...s].reduce((h, c) => Math.imul(h ^ c.codePointAt(0)!, 16777619) >>> 0, 2166136261).toString(16).padStart(8, "0");

/** Mantle's functions the lowering calls. Each is plain SQL, so the planner inlines it. */
const FUNCTIONS = [
  // x ->> k as SQLite reads it: a key, an index or a `$` path, over jsonb, json or JSON text
  // a `$` path is read strict and silent, as SQLite reads it: `$.a` of an array is NULL, not the array's members' `a`
  `CREATE OR REPLACE FUNCTION _mantle_jget(j jsonb, k text) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $f$SELECT CASE WHEN left(k, 1) = '$' THEN jsonb_path_query_first(j, ('strict ' || k)::jsonpath, '{}', true) #>> '{}' ELSE j ->> k END$f$`,
  `CREATE OR REPLACE FUNCTION _mantle_jget(j jsonb, k int8) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $f$SELECT j ->> k::int4$f$`,
  ...["text", "json"].flatMap((t) => ["text", "int8"].map((k) => `CREATE OR REPLACE FUNCTION _mantle_jget(j ${t}, k ${k}) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $f$SELECT _mantle_jget(j::jsonb, k)$f$`)),
  // CAST(x AS bool) by PostgreSQL's own rules for every type the subset has (PostgreSQL itself has no bigint -> bool cast)
  `CREATE OR REPLACE FUNCTION _mantle_bool(x bool) RETURNS bool LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $f$SELECT x$f$`,
  `CREATE OR REPLACE FUNCTION _mantle_bool(x text) RETURNS bool LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $f$SELECT x::bool$f$`,
  ...["int4", "int8", "float8", "numeric"].map((t) => `CREATE OR REPLACE FUNCTION _mantle_bool(x ${t}) RETURNS bool LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $f$SELECT x <> 0$f$`),
  // json_each with SQLite's columns: a scalar's value is its SQL text, an object's or array's its JSON text; id orders the elements
  `CREATE OR REPLACE FUNCTION _mantle_json_each(j jsonb) RETURNS TABLE (key text, value text, type text, atom text, id int8) LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $f$
    SELECT e.k,
      CASE WHEN jsonb_typeof(e.v) IN ('object', 'array') THEN e.v::text ELSE e.v #>> '{}' END,
      CASE jsonb_typeof(e.v) WHEN 'string' THEN 'text' WHEN 'boolean' THEN e.v::text WHEN 'number' THEN CASE WHEN e.v::text ~ '^-?[0-9]+$' THEN 'integer' ELSE 'real' END ELSE jsonb_typeof(e.v) END,
      CASE WHEN jsonb_typeof(e.v) IN ('object', 'array') THEN NULL ELSE e.v #>> '{}' END,
      e.n
    FROM (SELECT (a.n - 1)::text AS k, a.v, a.n FROM jsonb_array_elements(CASE WHEN jsonb_typeof(j) = 'array' THEN j ELSE '[]' END) WITH ORDINALITY a(v, n)
      UNION ALL SELECT o.k, o.v, o.n FROM jsonb_each(CASE WHEN jsonb_typeof(j) = 'object' THEN j ELSE '{}' END) WITH ORDINALITY o(k, v, n)) e$f$`,
];

const SYSTEM_DDL = [
  "CREATE TABLE IF NOT EXISTS _mantle_boot_state (key text PRIMARY KEY, value text NOT NULL)",
  "CREATE TABLE IF NOT EXISTS _mantle_schema_tables (name text PRIMARY KEY)",
];

/** One convergence at a time per database: the others wait, then find the work done. */
const LOCK: PgStatement = { text: "SELECT pg_advisory_xact_lock(4471522036519061)::text AS locked" };

/** Tables the platform creates itself (Better Auth, media, site config); a Schema may not take these names. */
const RESERVED_TABLES = new Set([
  "entries", "_migrations", "d1_migrations", "site_config", "user", "session", "account", "verification", "jwks",
  "oauthclient", "oauthresource", "oauthclientresource", "oauthrefreshtoken", "oauthaccesstoken", "oauthconsent", "oauthclientassertion",
  "media_assets", "pending_media_uploads",
]);

interface Column { readonly name: string; readonly type: string; readonly native: boolean }

function columns(s: StorageSchema): Column[] {
  return [
    ...(s.scope ? [{ name: s.scope, type: "text", native: true }] : []),
    ...(s.publishing ? [{ name: "status", type: "text", native: true }] : []),
    ...Object.entries(s.fields).filter(([f]) => f !== s.scope).flatMap(([f, ty]): Column[] =>
      ty === "geo" ? [{ name: `${f}_lat`, type: "float8", native: false }, { name: `${f}_lng`, type: "float8", native: false }] : [{ name: f, type: pgType(ty), native: false }]),
  ];
}

function indexes(name: string, s: StorageSchema) {
  return [
    ...(s.unique ?? []).map((u, i) => ({ name: `_mantle_uq_${name}_${i}`, unique: true, columns: s.scope && u[0] !== s.scope ? [s.scope, ...u] : [...u] })),
    ...(s.indexes ?? []).map((cols, i) => ({ name: `_mantle_ix_${name}_${i}`, unique: false, columns: [...cols] })),
  ].map((i) => ({ ...i, name: ident(i.name), sql: `CREATE ${i.unique ? "UNIQUE " : ""}INDEX IF NOT EXISTS ${q(ident(i.name))} ON ${q(name)} (${i.columns.map(q).join(", ")})` }));
}

/** A check's expression as PostgreSQL prints it, over the row's own columns. */
function checkText(expr: SqlNode): string {
  if (hasSubLink(expr)) throw new Error("a check reads only the row's own columns, never a subquery");
  return print(typed({ SelectStmt: { targetList: [{ ResTarget: { val: expr } }], limitOption: "LIMIT_OPTION_DEFAULT", op: "SETOP_NONE" } }, {})).replace(/^SELECT\s+/i, "");
}

/** Constraint name -> "<schema>: <expression>", for the executor's CHECK message. */
export function checkMessages(plan: Readonly<Record<string, StorageSchema>>): Map<string, string> {
  return new Map(Object.entries(plan).flatMap(([name, s]) => (s.checks ?? []).map((c, i) => [ident(`_mantle_chk_${name}_${i}`), `${name}: ${checkText(c)}`] as [string, string])));
}

/** Text compares and sorts by code point, as on D1, whatever collation the database was created with. */
const ddlType = (type: string) => (type === "text" ? 'text COLLATE "C"' : type);
const createTable = (name: string, s: StorageSchema) => `CREATE TABLE ${q(name)} (${[
  "_rid bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY", `id ${ddlType("text")} NOT NULL UNIQUE`, "version int8 NOT NULL DEFAULT 1",
  "created_at timestamptz NOT NULL", "updated_at timestamptz NOT NULL DEFAULT now()", `author_id ${ddlType("text")}`,
  ...columns(s).map((c) => `${q(c.name)} ${ddlType(c.type)}${c.name === "status" ? " NOT NULL DEFAULT 'draft'" : c.native ? " NOT NULL" : ""}`),
].join(", ")})`;
const tooLong = (n: string) => new TextEncoder().encode(n).length > 63;

/** `information_schema`'s spelling of a column type, to compare with the plan's. */
const spelled = (r: { udt_name: string; numeric_precision: number | null; numeric_scale: number | null }) =>
  r.udt_name === "numeric" && r.numeric_precision !== null ? `numeric(${r.numeric_precision}, ${r.numeric_scale})` : r.udt_name;

type Row = Record<string, any>;

async function diff(connect: PgConnect, plan: Readonly<Record<string, StorageSchema>>) {
  const statements: PgStatement[] = [];
  const blocked: StorageChange[] = [];
  const undeclared: StorageChange[] = [];
  const block = (schema: string, message: string, code: StorageChange["code"] = "STORAGE_CHANGE_BLOCKED") => blocked.push({ schema, code, message });

  const [tables, owned, cols, idx, chk] = (await transaction(connect, [
    { text: "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema()" },
    { text: "SELECT name FROM _mantle_schema_tables" },
    { text: "SELECT table_name, column_name, udt_name, numeric_precision, numeric_scale FROM information_schema.columns WHERE table_schema = current_schema()" },
    { text: `SELECT t.relname AS tbl, i.relname AS name, ix.indisunique AS uniq, ix.indisprimary AS pk, ix.indpred IS NOT NULL AS partial,
        (SELECT string_agg(a.attname, ',' ORDER BY k.ord) FROM unnest(ix.indkey) WITH ORDINALITY k(attnum, ord) JOIN pg_attribute a ON a.attrelid = ix.indrelid AND a.attnum = k.attnum) AS cols
      FROM pg_index ix JOIN pg_class i ON i.oid = ix.indexrelid JOIN pg_class t ON t.oid = ix.indrelid WHERE t.relnamespace = current_schema()::regnamespace` },
    { text: "SELECT t.relname AS tbl, c.conname AS name FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid WHERE c.contype = 'c' AND t.relnamespace = current_schema()::regnamespace" },
  ])).map((o) => o.rows as Row[]);
  const existing = new Set(tables!.map((r) => String(r.name)));
  const ownedNames = new Set(owned!.map((r) => String(r.name)));

  for (const [name, schema] of Object.entries(plan)) {
    const t = q(name);
    if (RESERVED_TABLES.has(name.toLowerCase()) || name.toLowerCase().startsWith("_mantle_")) {
      block(name, `table name ${name} is reserved for Mantle and Better Auth`, "STORAGE_TABLE_NOT_OWNED");
      continue;
    }
    if (existing.has(name) && !ownedNames.has(name)) {
      block(name, `table ${name} exists and Mantle did not create it, so it is not read or written`, "STORAGE_TABLE_NOT_OWNED");
      continue;
    }
    // PostgreSQL truncates a longer name, so the next boot would not find what this one created
    const long = [name, ...columns(schema).map((c) => c.name)].filter(tooLong);
    if (long.length) { block(name, `${long.join(", ")}: PostgreSQL names are at most 63 bytes; shorten the Schema or field name`); continue; }
    const want = indexes(name, schema);
    if (!existing.has(name)) {
      statements.push({ text: createTable(name, schema) }, { text: "INSERT INTO _mantle_schema_tables (name) VALUES ($1) ON CONFLICT DO NOTHING", values: [name] }, ...want.map((i) => ({ text: i.sql })));
    } else {
      const have = new Map(cols!.filter((r) => r.table_name === name).map((r) => [String(r.column_name), spelled(r as never)]));
      const native = new Map([["_rid", "int8"], ["id", "text"], ["version", "int8"], ["created_at", "timestamptz"], ["updated_at", "timestamptz"], ["author_id", "text"]]);
      for (const [c, type] of native) {
        if (!have.has(c)) block(name, `${name} lacks the native column ${c}; copy the data into a table Mantle creates`);
        else if (have.get(c) !== type) block(name, `${name}.${c} is ${have.get(c)}, Mantle needs ${type}`);
      }
      for (const c of columns(schema)) {
        const actual = have.get(c.name);
        if (actual === undefined) {
          if (c.native) block(name, `${name} lacks the native column ${c.name}; add it, or copy the data into a table Mantle creates`);
          else statements.push({ text: `ALTER TABLE ${t} ADD COLUMN ${q(c.name)} ${ddlType(c.type)}` });
        } else if (actual !== c.type) block(name, `${name}.${c.name} is ${actual}, the plan says ${c.type}; a column's type is never altered`);
      }
      const declared = new Set([...native.keys(), ...columns(schema).map((c) => c.name)]);
      for (const c of have.keys()) if (!declared.has(c)) undeclared.push({ schema: name, code: "STORAGE_UNDECLARED_COLUMN", message: `${name}.${c} is in the database and not in the plan; it is kept` });

      const actual = new Map(idx!.filter((r) => r.tbl === name).map((r) => [String(r.name), r]));
      for (const i of want) {
        const a = actual.get(i.name);
        if (!a) statements.push({ text: i.sql });
        else if (a.uniq !== i.unique || a.partial || a.cols !== i.columns.join(",")) block(name, `index ${i.name} exists with other columns, uniqueness or a WHERE; drop it and rerun`);
      }
      const wanted = new Set(want.map((i) => i.name));
      for (const [n, a] of actual) {
        if (wanted.has(n) || a.pk || (a.uniq && a.cols === "id")) continue;
        if (a.uniq) block(name, `undeclared unique index ${n} on ${a.cols} still constrains writes; drop it or declare it`);
        else undeclared.push({ schema: name, code: "STORAGE_UNDECLARED_INDEX", message: schema.scope && n === ident(`_mantle_scope_${name}`) ? `index ${n} is redundant: a declared index leads with ${schema.scope}; drop it by hand` : `index ${n} is in the database and not in the plan; it is kept` });
      }
    }
    // Mantle's checks are rebuilt from the plan: dropped, then added NOT VALID (a check binds writes, not old rows)
    for (const r of chk!) if (r.tbl === name && String(r.name).startsWith("_mantle_chk_")) statements.push({ text: `ALTER TABLE ${t} DROP CONSTRAINT IF EXISTS ${q(String(r.name))}` });
    (schema.checks ?? []).forEach((c, i) => statements.push({ text: `ALTER TABLE ${t} ADD CONSTRAINT ${q(ident(`_mantle_chk_${name}_${i}`))} CHECK (${checkText(c)}) NOT VALID` }));
  }
  return { statements, blocked, undeclared };
}

/** Converge storage to the plan. Blocked differences are reported and applied to nothing; a matching fingerprint reads nothing else. */
export async function convergeStorage(connect: PgConnect, plan: Readonly<Record<string, StorageSchema>>, options: { fingerprint: string }): Promise<StorageReport> {
  // the plan and Mantle's functions: a release that changes a function re-creates it on the next boot
  const state = `${options.fingerprint}|${fnv(FUNCTIONS.join("\n"))}`;
  const booted = await query(connect, { text: "SELECT value FROM _mantle_boot_state WHERE key = 'fingerprint'" }).catch(() => undefined);
  if (booted?.rows[0]?.value === state) return { skipped: true, blocked: [], undeclared: [] };
  await transaction(connect, [LOCK, ...SYSTEM_DDL.map((text) => ({ text })), ...FUNCTIONS.map((text) => ({ text })),
    { text: "INSERT INTO _mantle_boot_state (key, value) VALUES ('instance', $1) ON CONFLICT DO NOTHING", values: [crypto.randomUUID()] }], undefined, 0);
  for (let attempt = 0; ; attempt++) {
    const { statements, blocked, undeclared } = await diff(connect, plan);
    if (blocked.length) return { skipped: false, blocked, undeclared };
    statements.push({ text: "INSERT INTO _mantle_boot_state (key, value) VALUES ('fingerprint', $1) ON CONFLICT (key) DO UPDATE SET value = excluded.value", values: [state] });
    try {
      // convergence builds indexes on tables that may be large: no statement timeout
      await transaction(connect, [LOCK, ...statements], undefined, 0);
      return { skipped: false, blocked: [], undeclared };
    } catch (e) {
      const state = (e as { code?: string }).code;
      // another isolate converged while this one diffed: diff again against what it left
      if ((state === "42P07" || state === "42701" || state === "42710") && attempt < 2) continue;
      if (state === "23505") {
        const msg = e instanceof Error ? e.message : String(e);
        return { skipped: false, blocked: [{ schema: "*", code: "STORAGE_CHANGE_BLOCKED", message: `a unique index cannot be created: existing rows break it (${msg}); dedupe the data, then rerun` }], undeclared };
      }
      throw e;
    }
  }
}
