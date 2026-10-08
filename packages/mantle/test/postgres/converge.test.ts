// @ts-nocheck test code over loosely typed results
/**
 * BOOT-5: convergence under a deploy. Every isolate of a release boots at once against one database: the first converges, the
 * rest read the fingerprint again after the advisory lock and skip; a check whose expression did not change is not dropped
 * (DROP + ADD takes ACCESS EXCLUSIVE on a table live traffic reads); and DDL gives up on a lock instead of queueing behind it.
 */
import pg from "pg";
import { loadModule, parseSync } from "libpg-query";
import { expect, it } from "vitest";
import { DiagnosticError } from "../../src/spec/kernel/index.js";
import { RUNTIME_PLAN_VERSION } from "../../src/spec/index.js";
import { postgresStorage } from "../../src/postgres/index.js";
import { bootRead } from "../../src/postgres/driver.js";
import { convergeStorage } from "../../src/postgres/storage.js";
import * as pgCompile from "../../src/postgres/compile/index.js";
import { PG_URL, freshSchema } from "./engine.js";

await loadModule();
const expr = (text: string) => (parseSync(`SELECT 1 WHERE ${text}`) as any).stmts[0].stmt.SelectStmt.whereClause;
const items = (extra = {}) => ({ fields: { name: "text", stock: "integer" }, checks: [expr("stock >= 0"), expr("name <> ''")], ...extra });
const notes = (extra = {}) => ({ fields: { title: "text", stars: "integer" }, checks: [expr("stars < 6")], ...extra });
const v1 = () => ({ items: items(), notes: notes() });

const sql = async (db, text: string, values: unknown[] = []) => {
  const c = await db.connect();
  try { return (await c.query({ text, values })).rows; } finally { await c.end(); }
};
const checks = (db) => sql(db, `SELECT t.relname AS tbl, c.conname AS name, c.oid::int8 AS oid, c.xmin::text AS xmin FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
  WHERE c.contype = 'c' AND t.relnamespace = current_schema()::regnamespace ORDER BY 1, 2`);
const by = (rows) => Object.fromEntries(rows.map((r) => [r.name, r]));
/** What a booting isolate holds when it read the fingerprint before anyone converged. */
const herdOf = (db, n: number, plan, fingerprint: string, extra = {}) =>
  Promise.all(Array.from({ length: n }, () => convergeStorage(db.connect, plan, { fingerprint, booted: null, ...extra })));

it.skipIf(!PG_URL)("a check whose expression is unchanged keeps its row; a changed or removed one is rebuilt; a legacy check without the mark is rebuilt once", async () => {
  const db = await freshSchema();
  try {
    expect((await convergeStorage(db.connect, v1(), { fingerprint: "a" })).skipped).toBe(false);
    const before = by(await checks(db));
    expect(Object.keys(before)).toEqual(["_mantle_chk_items_0", "_mantle_chk_items_1", "_mantle_chk_notes_0"]);

    // a release adds a field and a check to notes, and changes nothing on items
    const plan2 = { items: items(), notes: notes({ fields: { title: "text", stars: "integer", note: "text" }, checks: [expr("stars < 6"), expr("title <> ''")] }) };
    expect((await convergeStorage(db.connect, plan2, { fingerprint: "b" })).skipped).toBe(false);
    const after = by(await checks(db));
    for (const n of ["_mantle_chk_items_0", "_mantle_chk_items_1", "_mantle_chk_notes_0"]) expect(after[n], n).toEqual(before[n]);
    expect(after._mantle_chk_notes_1).toBeDefined();

    // a changed expression is rebuilt, and it still binds writes
    const plan3 = { items: items({ checks: [expr("stock >= 1"), expr("name <> ''")] }), notes: plan2.notes };
    await convergeStorage(db.connect, plan3, { fingerprint: "c" });
    const changed = by(await checks(db));
    expect(changed._mantle_chk_items_0.oid).not.toBe(after._mantle_chk_items_0.oid);
    expect(changed._mantle_chk_items_1).toEqual(after._mantle_chk_items_1);
    await expect(sql(db, "INSERT INTO items (id, created_at, name, stock) VALUES ('x', now(), 'n', 0)")).rejects.toMatchObject({ code: "23514" });

    // a removed check is dropped
    await convergeStorage(db.connect, { items: items({ checks: [expr("stock >= 1")] }), notes: plan2.notes }, { fingerprint: "d" });
    expect(Object.keys(by(await checks(db)))).not.toContain("_mantle_chk_items_1");

    // a check a release before the mark made has no comment: rebuilt this once, then left alone
    await sql(db, `COMMENT ON CONSTRAINT _mantle_chk_notes_0 ON notes IS NULL`);
    const legacy = by(await checks(db));
    await convergeStorage(db.connect, { items: items({ checks: [expr("stock >= 1")] }), notes: plan2.notes }, { fingerprint: "e" });
    const adopted = by(await checks(db));
    expect(adopted._mantle_chk_notes_0.oid).not.toBe(legacy._mantle_chk_notes_0.oid);
    expect(adopted._mantle_chk_items_0).toEqual(legacy._mantle_chk_items_0);
    await convergeStorage(db.connect, { items: items({ checks: [expr("stock >= 1")] }), notes: plan2.notes }, { fingerprint: "f" });
    expect(by(await checks(db))).toEqual(adopted);
  } finally { await db.drop(); }
}, 60_000);

it.skipIf(!PG_URL)("a herd of booting isolates converges once: a fresh database, then an upgraded one; the rest skip, none fail", async () => {
  const db = await freshSchema();
  try {
    for (const [plan, fingerprint] of [[v1(), "a"], [{ items: items(), notes: notes({ checks: [expr("stars < 6"), expr("title <> ''")] }) }, "b"]] as const) {
      const reports = await herdOf(db, 8, plan, fingerprint);
      expect(reports.filter((r) => !r.skipped).length, fingerprint).toBe(1);
      expect(reports.filter((r) => r.skipped).length).toBe(7);
      expect(reports.every((r) => !r.blocked.length)).toBe(true);
      // and a boot after them reads one row and stops
      expect((await bootRead(db.connect)).booted).toMatch(new RegExp(`^${fingerprint}\\|`));
      expect((await herdOf(db, 3, plan, fingerprint)).every((r) => r.skipped)).toBe(true);
    }
    const final = await checks(db);
    expect(final.map((r) => r.name)).toEqual(["_mantle_chk_items_0", "_mantle_chk_items_1", "_mantle_chk_notes_0", "_mantle_chk_notes_1"]);
  } finally { await db.drop(); }
}, 60_000);

it.skipIf(!PG_URL)("the DDL gives up on a lock it cannot get, retries, and succeeds once it is free; if it never is, nothing is applied and the error says why", async () => {
  const db = await freshSchema();
  const holder = new pg.Client({ connectionString: PG_URL, options: `-c search_path=${db.schema}` });
  try {
    await convergeStorage(db.connect, v1(), { fingerprint: "a" });
    const before = by(await checks(db));
    const plan2 = { items: items({ checks: [expr("stock >= 1"), expr("name <> ''")] }), notes: notes() };
    await holder.connect();
    // a read in a transaction that stays open: it conflicts with the ACCESS EXCLUSIVE an ALTER TABLE queues for
    await holder.query("BEGIN; LOCK TABLE items IN ACCESS SHARE MODE");

    const t0 = performance.now();
    const refused = await convergeStorage(db.connect, plan2, { fingerprint: "b", booted: "a", lockTimeoutMs: 50, attempts: 3 });
    expect(refused.blocked[0].message).toMatch(/lock stayed held for 3 tries of 50 ms.*lock timeout/s);
    expect(performance.now() - t0).toBeLessThan(5000);
    expect(by(await checks(db))).toEqual(before);
    expect((await bootRead(db.connect)).booted).toMatch(/^a\|/);
    // prepare surfaces it as a boot diagnostic
    const e = postgresStorage({ connect: db.connect });
    await expect(e.prepare({ version: RUNTIME_PLAN_VERSION, dialect: { name: pgCompile.name, version: pgCompile.version }, fingerprint: "b", views: {}, procedures: {}, triggers: {},
      schemas: Object.fromEntries(Object.entries(plan2).map(([n, d]) => [n, { ...d, name: n, names: {}, schema: { type: "object" } }])) })).rejects.toBeInstanceOf(DiagnosticError);

    // a reader is not stuck behind the converger's queue for longer than the timeout
    const free = setTimeout(() => void holder.query("COMMIT"), 400);
    const ok = await convergeStorage(async () => db.connect(), plan2, { fingerprint: "b", booted: "a", lockTimeoutMs: 100, attempts: 50, cooldownMs: 0 });
    clearTimeout(free);
    expect(ok.blocked).toEqual([]);
    expect(by(await checks(db))._mantle_chk_items_0.oid).not.toBe(before._mantle_chk_items_0.oid);
  } finally { await holder.end().catch(() => undefined); await db.drop(); }
}, 60_000);

it.skipIf(!PG_URL)("a boot that times out on the advisory lock says another boot is converging, not that a table is in use", async () => {
  const db = await freshSchema();
  const holder = new pg.Client({ connectionString: PG_URL, options: `-c search_path=${db.schema}` });
  try {
    await holder.connect();
    await holder.query("BEGIN; SELECT pg_advisory_xact_lock(4471522036519061)");
    const r = await convergeStorage(db.connect, v1(), { fingerprint: "a", lockTimeoutMs: 50, attempts: 2, cooldownMs: 0 });
    expect(r.blocked[0].code).toBe("STORAGE_CHANGE_BLOCKED");
    expect(r.blocked[0].message).toMatch(/another boot is still converging/);
    expect(r.blocked[0].message).not.toMatch(/long transaction/);
  } finally { await holder.query("ROLLBACK").catch(() => undefined); await holder.end(); await db.drop(); }
}, 30_000);

it.skipIf(!PG_URL)("a herd under a held lock gives up together within the retry window, not one isolate after another; readers are not stalled past it; a request after a blocked boot fails fast", async () => {
  const db = await freshSchema();
  const holder = new pg.Client({ connectionString: PG_URL, options: `-c search_path=${db.schema}` });
  try {
    await convergeStorage(db.connect, v1(), { fingerprint: "a" });
    const plan2 = { items: items({ checks: [expr("stock >= 1"), expr("name <> ''")] }), notes: notes() };
    await holder.connect();
    await holder.query("BEGIN; LOCK TABLE items IN ROW EXCLUSIVE MODE");
    const timeout = 200, attempts = 3;
    let worst = 0, stop = false;
    const reader = (async () => {
      while (!stop) { const t = performance.now(); await sql(db, "SELECT 1 FROM items LIMIT 1"); worst = Math.max(worst, performance.now() - t); await new Promise((r) => setTimeout(r, 10)); }
    })();
    const counted = { n: 0 };
    const connect = async () => { const c = await db.connect(); const q = c.query.bind(c); c.query = (...a) => { counted.n++; return q(...a); }; return c; };
    const t0 = performance.now();
    const reports = await Promise.all(Array.from({ length: 12 }, () => convergeStorage(connect, plan2, { fingerprint: "b", booted: "a", lockTimeoutMs: timeout, attempts, cooldownMs: 60_000 })));
    const wall = performance.now() - t0;
    stop = true; await reader;
    expect(reports.every((r) => r.blocked.length === 1 && /lock stayed held/.test(r.blocked[0].message))).toBe(true);
    // each isolate waits at most `attempts` times for the advisory lock and for the table, whatever the herd's size
    expect(wall).toBeLessThan(attempts * 2 * timeout + 100 * attempts * attempts + 1500);
    expect(worst).toBeLessThan(timeout + 600);
    // the next request neither opens a connection nor issues DDL
    counted.n = 0;
    const again = await convergeStorage(connect, plan2, { fingerprint: "b", booted: "a", lockTimeoutMs: timeout, attempts, cooldownMs: 60_000 });
    // the herd's isolates timed out on either lock, so their wording differs; the fast-failing report is one of them
    expect(again.blocked).toHaveLength(1);
    expect(again.blocked[0].message).toMatch(/lock stayed held/);
    expect(counted.n).toBe(0);
  } finally { await holder.end().catch(() => undefined); await db.drop(); }
}, 60_000);
