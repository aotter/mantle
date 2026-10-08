/**
 * Storage convergence on PostgreSQL (ADR-0033, as D1 applies it): the database is the state, the plan is the target. Safe
 * differences are applied in one transaction; blocked ones are reported and never touched; undeclared ones are reported and
 * kept. Columns have native types; a Schema check is a CHECK constraint added NOT VALID, so it binds every later write and
 * leaves rows that predate it alone, as D1's trigger does.
 */
import { checkShapeProblem, storageColumns, type SqlNode } from "../spec/domain/index.js";
import type { StorageSchema } from "../core/dialect.js";
import { query, sqlState, type PgClient, type PgConnect, type PgStatement } from "./driver.js";
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

/** The SQLSTATE `_mantle_expect` raises; the executor reads it as CONFLICT. */
export const EXPECT_STATE = "MX409";

/**
 * Mantle's one function. ADR-0039 removed the SQLite emulations that used to sit beside it (`_mantle_jget`, `_mantle_bool`,
 * `_mantle_json_each`); a database booted before keeps them, unreferenced and harmless, and no DROP is issued: an older release
 * still running during a rolling deploy calls them, and a dropped function would fail its queries.
 */
const FUNCTIONS = [
  // a write's `expect`, checked where it ran: a different count fails the statement, and with it the transaction
  `CREATE OR REPLACE FUNCTION _mantle_expect(actual int8, expected int8) RETURNS bool LANGUAGE plpgsql VOLATILE AS $f$BEGIN
    IF actual <> expected THEN RAISE EXCEPTION USING ERRCODE = '${EXPECT_STATE}', MESSAGE = format('the write matched %s rows, not %s', actual, expected); END IF;
    RETURN true;
  END$f$`,
];

const SYSTEM_DDL = [
  "CREATE TABLE IF NOT EXISTS _mantle_boot_state (key text PRIMARY KEY, value text NOT NULL)",
  "CREATE TABLE IF NOT EXISTS _mantle_schema_tables (name text PRIMARY KEY)",
  // the target an `expect` guard inserts into; its HAVING never lets a row through (executor.ts)
  "CREATE TABLE IF NOT EXISTS _mantle_assert (ok boolean)",
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
    // Admin's default list order (updated_at descending, then the id tiebreak), served by a backward scan (ADR-0039 decision 2)
    // ponytail: every Schema pays this index on UPDATE; a write-hot table that is never listed could opt out once one is measured; a large existing table is better served by CREATE INDEX CONCURRENTLY (outside the convergence transaction) with the same name and columns, which is the upgrade path
    { name: `_mantle_ix_${name}_updated`, unique: false, columns: [...(s.scope ? [s.scope] : []), "updated_at", "id"] },
  ].map((i) => ({ ...i, name: ident(i.name), sql: `CREATE ${i.unique ? "UNIQUE " : ""}INDEX IF NOT EXISTS ${q(ident(i.name))} ON ${q(name)} (${i.columns.map(q).join(", ")})` }));
}

/** A check's expression as PostgreSQL prints it, over the row's own columns. */
function checkText(expr: SqlNode, s: StorageSchema): string {
  const problem = checkShapeProblem(expr, storageColumns(s));
  if (problem) throw new Error(problem);
  return print(typed({ SelectStmt: { targetList: [{ ResTarget: { val: expr } }], limitOption: "LIMIT_OPTION_DEFAULT", op: "SETOP_NONE" } }, {})).replace(/^SELECT\s+/i, "");
}

/** Constraint name -> "<schema>: <expression>", for the executor's CHECK message. */
export function checkMessages(plan: Readonly<Record<string, StorageSchema>>): Map<string, string> {
  return new Map(Object.entries(plan).flatMap(([name, s]) => (s.checks ?? []).map((c, i) => [ident(`_mantle_chk_${name}_${i}`), `${name}: ${checkText(c, s)}`] as [string, string])));
}

/**
 * Text compares and sorts by code point, whatever collation the database was created with.
 * ponytail: this began as D1 emulation (ADR-0039 keeps the tiebreak in the column's own collation, so indexes still serve it). Dropping it
 * only changes tables created from now on and leaves the earlier ones in "C", so one Schema family would sort text two ways by age
 * (and a database whose collation is en_US sorts ids and names by locale); the upgrade is a deliberate rebuild of text columns and
 * their indexes in one release, which needs the migration this PR avoids. Tracked as a follow-up issue.
 */
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

/** One at a time: node-postgres deprecates a query issued while another is in flight (`Promise.all`), and pipelining is the driver's own business. */
async function sequentially<T, R>(items: readonly T[], f: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (const i of items) out.push(await f(i));
  return out;
}

/** The catalog reads and the plan's differences, over the client that holds the convergence lock. */
async function diff(client: PgClient, plan: Readonly<Record<string, StorageSchema>>) {
  const statements: PgStatement[] = [];
  const blocked: StorageChange[] = [];
  const undeclared: StorageChange[] = [];
  const block = (schema: string, message: string, code: StorageChange["code"] = "STORAGE_CHANGE_BLOCKED") => blocked.push({ schema, code, message });

  const [tables, owned, cols, idx, chk] = (await sequentially([
    "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema()",
    "SELECT name FROM _mantle_schema_tables",
    "SELECT table_name, column_name, udt_name, numeric_precision, numeric_scale FROM information_schema.columns WHERE table_schema = current_schema()",
    `SELECT t.relname AS tbl, i.relname AS name, ix.indisunique AS uniq, ix.indisprimary AS pk, ix.indpred IS NOT NULL AS partial,
        (SELECT string_agg(a.attname, ',' ORDER BY k.ord) FROM unnest(ix.indkey) WITH ORDINALITY k(attnum, ord) JOIN pg_attribute a ON a.attrelid = ix.indrelid AND a.attnum = k.attnum) AS cols
      FROM pg_index ix JOIN pg_class i ON i.oid = ix.indexrelid JOIN pg_class t ON t.oid = ix.indrelid WHERE t.relnamespace = current_schema()::regnamespace`,
    // the comment is the expression Mantle added the check from (CHECK_MARK): PostgreSQL prints a constraint in its own normal form, which is not the plan's
    "SELECT t.relname AS tbl, c.conname AS name, obj_description(c.oid, 'pg_constraint') AS comment FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid WHERE c.contype = 'c' AND t.relnamespace = current_schema()::regnamespace",
  ], (text) => client.query({ text }))).map((o) => o.rows as Row[]);
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
    // Mantle's checks follow the plan: one whose expression is unchanged is left alone (a DROP and ADD takes ACCESS EXCLUSIVE on a
    // table live traffic reads), the rest are dropped and added NOT VALID (a check binds writes, not old rows)
    // ponytail: checks are named by position, so inserting one mid-list rebuilds the later ones; naming by expression hash avoids it
    const wantChecks = new Map((schema.checks ?? []).map((c, i) => [ident(`_mantle_chk_${name}_${i}`), checkText(c, schema)]));
    const kept = new Set<string>();
    for (const r of chk!) {
      if (r.tbl !== name || !String(r.name).startsWith("_mantle_chk_")) continue;
      const text = wantChecks.get(String(r.name));
      if (text !== undefined && r.comment === CHECK_MARK + text) kept.add(String(r.name));
      else statements.push({ text: `ALTER TABLE ${t} DROP CONSTRAINT IF EXISTS ${q(String(r.name))}` });
    }
    for (const [n, text] of wantChecks) {
      if (kept.has(n)) continue;
      statements.push({ text: `ALTER TABLE ${t} ADD CONSTRAINT ${q(n)} CHECK (${text}) NOT VALID` },
        { text: `COMMENT ON CONSTRAINT ${q(n)} ON ${t} IS '${(CHECK_MARK + text).replace(/'/g, "''")}'` });
    }
  }
  return { statements, blocked, undeclared };
}

/** Bump whenever `indexes()` or `createTable()` output changes for an unchanged plan: the boot state includes it, so a booted database converges again. */
const LAYOUT = "2";

/** Prefixes the comment on a Mantle check: the expression it was added from, so the next boot can tell whether the plan changed it. */
const CHECK_MARK = "mantle:";

/** How long a boot that gave up on a lock fails fast. ponytail: per process and per `connect`; a shared record (a _mantle_boot_state row) would also quiet other isolates. */
const COOL_DOWN_MS = 10_000;
const COOL_DOWN = new WeakMap<PgConnect, { state: string; until: number; report: StorageReport }>();

const BOOTED = "SELECT value FROM _mantle_boot_state WHERE key = 'fingerprint'";

/**
 * Converge storage to the plan. Blocked differences are reported and applied to nothing; a matching fingerprint reads nothing else.
 *
 * Every isolate of a deploy boots at once, so the work is one transaction under the advisory lock, in READ COMMITTED: a waiter
 * wakes to a fresh snapshot, reads the fingerprint again, and finds the winner's work done (a SERIALIZABLE snapshot would predate
 * it). The DDL runs under `lock_timeout`: ALTER TABLE queues for ACCESS EXCLUSIVE and every read after it queues behind it, so
 * it gives up after `lockTimeoutMs`, rolls back, and tries again, rather than stalling live traffic behind a long query.
 */
export async function convergeStorage(connect: PgConnect, plan: Readonly<Record<string, StorageSchema>>, options: { fingerprint: string; booted?: string | null; lockTimeoutMs?: number; attempts?: number; cooldownMs?: number }): Promise<StorageReport> {
  // the plan and Mantle's functions: a release that changes a function re-creates it on the next boot
  const state = `${options.fingerprint}|${fnv(FUNCTIONS.join("\n"))}|${LAYOUT}`;
  const booted = options.booted !== undefined ? options.booted : (await query(connect, { text: BOOTED }).catch(() => undefined))?.rows[0]?.value;
  if (booted === state) return { skipped: true, blocked: [], undeclared: [] };
  // a boot that gave up on a lock is not retried by every request of every isolate: for `cooldownMs` it fails fast with the same report
  const cool = COOL_DOWN.get(connect);
  if (cool && cool.state === state && cool.until > Date.now()) return cool.report;
  const lockTimeout = Math.max(1, Math.floor(options.lockTimeoutMs ?? 1000));
  const attempts = options.attempts ?? 5;
  for (let attempt = 1; ; attempt++) {
    const client = await connect();
    try {
      return await locked(client, plan, state, lockTimeout);
    } catch (e) {
      await client.query({ text: "ROLLBACK" }).catch(() => undefined);
      const code = sqlState(e);
      if (code === "55P03") {
        if (attempt < attempts) { await new Promise((r) => setTimeout(r, Math.random() * 100 * attempt)); continue; }
        const why = e instanceof Error ? e.message : String(e);
        const report: StorageReport = { skipped: false, undeclared: [], blocked: [{ schema: "*", code: "STORAGE_CHANGE_BLOCKED", message: `storage could not be converged: a lock stayed held for ${attempts} tries of ${lockTimeout} ms (${why}); a long transaction or query is using a table the plan changes. Nothing was applied; end it, or boot again when traffic is lower (not retried for ${(options.cooldownMs ?? COOL_DOWN_MS) / 1000} s)` }] };
        COOL_DOWN.set(connect, { state, until: Date.now() + (options.cooldownMs ?? COOL_DOWN_MS), report });
        return report;
      }
      if (code === "23505") {
        const msg = e instanceof Error ? e.message : String(e);
        return { skipped: false, undeclared: [], blocked: [{ schema: "*", code: "STORAGE_CHANGE_BLOCKED", message: `a unique index cannot be created: existing rows break it (${msg}); dedupe the data, then rerun` }] };
      }
      throw e;
    } finally { await client.end().catch(() => undefined); }
  }
}

async function locked(client: PgClient, plan: Readonly<Record<string, StorageSchema>>, state: string, lockTimeoutMs: number): Promise<StorageReport> {
  const run = (s: PgStatement) => client.query({ text: s.text, ...(s.values ? { values: [...s.values] } : {}) });
  // convergence builds indexes on tables that may be large: no statement timeout. The lock wait below has none either: a waiter is behind the winner's work
  // lock_timeout comes first so the advisory wait is bounded too: a herd gives up together, not one isolate after another
  // ponytail: a winner building a large index outlasts that bound and the waiters report a blocked boot; a longer advisory wait than DDL wait is the upgrade once it is measured
  await client.query({ text: `BEGIN ISOLATION LEVEL READ COMMITTED; SET LOCAL statement_timeout = 0; SET LOCAL lock_timeout = ${lockTimeoutMs}` });
  await run(LOCK);
  for (const text of SYSTEM_DDL) await run({ text });
  // another isolate may have converged while this one waited for the lock: this read, after it, sees its commit
  if ((await run({ text: BOOTED })).rows[0]?.value === state) {
    await client.query({ text: "COMMIT" });
    return { skipped: true, blocked: [], undeclared: [] };
  }
  for (const text of FUNCTIONS) await run({ text });
  await run({ text: "INSERT INTO _mantle_boot_state (key, value) VALUES ('instance', $1) ON CONFLICT DO NOTHING", values: [crypto.randomUUID()] });
  const { statements, blocked, undeclared } = await diff(client, plan);
  if (blocked.length) {
    await client.query({ text: "COMMIT" });
    return { skipped: false, blocked, undeclared };
  }
  for (const s of statements) await run(s);
  await run({ text: "INSERT INTO _mantle_boot_state (key, value) VALUES ('fingerprint', $1) ON CONFLICT (key) DO UPDATE SET value = excluded.value", values: [state] });
  await client.query({ text: "COMMIT" });
  return { skipped: false, blocked: [], undeclared };
}
