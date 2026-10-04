// @ts-nocheck test code over loosely typed IR and rows
/**
 * What the compliance suite leaves to each dialect, checked for D1: the SQL it prints, SQLite's query plan over the
 * policy wrapper, FTS5's trigram floor, D1's meta.changes, the storage encodings (the types case), and that D1's
 * compile side accepts the whole printer corpus.
 */
import { expect, it } from "vitest";
import { LocalD1 } from "../../src/cloudflare/testing/d1.js";
import { sqliteStorage } from "../../src/d1/index.js";
import { print } from "../../src/d1/print.js";
import { loadModule, parseSync } from "libpg-query";
import { Report } from "../../src/testing/report.js";
import { boot, caller, compileProgram, program, runView, site, useCompileSide } from "../../src/testing/harness.js";
import * as printer from "../../src/testing/cases/printer.js";
import * as d1Compile from "../../src/d1/compile/index.js";
import { SqlRefusal } from "../../src/spec/index.js";
import { VIEW } from "../../src/testing/cases/report-view.js";
import { corpus } from "../../src/testing/cases/corpus.js";
import * as types from "./cases/types.js";

const engine = async () => { const d1 = await LocalD1.create(); return { storage: sqliteStorage(d1), driver: d1 }; };

it("the types case: D1's storage encodings give PostgreSQL's results", async () => {
  const e = await engine();
  try {
    const r = new Report();
    await types.run(r, e);
    expect(r.failed.map((c) => `${c.name}: ${c.detail ?? ""}`)).toEqual([]);
  } finally { await e.driver.dispose(); }
}, 120_000);

it("the policy wrapper prints scope and TTL once per Schema, and SQLite's plan still uses the index the scope leads", async () => {
  const e = await engine();
  try {
    const s = site(await boot(e));
    const sql = print(compileProgram(s, await program("view", VIEW, { min: "int8" }))[0].ast);
    expect(sql).toMatch(/FROM items WHERE items\.owner = \?1 AND \(items\.expires_at IS NULL OR items\.expires_at > \?2\)/);
    expect(sql).toMatch(/FROM orders WHERE orders\.owner = \?1/);
    expect(sql).not.toMatch(/\?4/);
    const detail = (await s.d1.all(`EXPLAIN QUERY PLAN ${sql}`, ["o1", 0, 0])).map((x) => x.detail).join(" | ");
    expect(detail).toMatch(/_mantle_ix_items_0/);
    expect(detail).toMatch(/_mantle_ix_orders_0/);
  } finally { await e.driver.dispose(); }
}, 120_000);

it("FTS5 trigram matches nothing under three characters, so search falls back to a scan; D1's meta.changes counts trigger writes", async () => {
  const e = await engine();
  try {
    const b = await boot(e);
    const s = site(b);
    expect((await b.d1.all('SELECT rowid FROM "_mantle_fts_notes" WHERE "_mantle_fts_notes" = ?1', ['"小籠"'])).length).toBe(0);
    const search = await program("view", "SELECT id FROM notes WHERE mantle.search(notes, input.q) ORDER BY id", { q: "text" });
    expect((await runView(s, search, caller({ q: "小籠" }))).rows).toEqual([{ id: "n1" }]);
    // so a write's count must be changes() inside the batch, never D1's meta.changes
    expect((await b.d1.batch([{ sql: "UPDATE notes SET title = 'renamed' WHERE id = 'n3'" }]))[0].changes).not.toBe(1);
  } finally { await e.driver.dispose(); }
}, 120_000);

it("D1's compile side accepts every printer corpus item, so the suite's corpus case runs all of them on D1", async () => {
  const refused = [];
  for (const item of corpus) await program(item.kind, item.sql, item.inputs ?? {}).catch((err) => refused.push(`${item.id}: ${err.message}`));
  expect(refused).toEqual([]);
});

it("the printer case passes a corpus item the compile side refuses as unsupported, and fails one refused for another reason", async () => {
  // D1's compile side, refusing window functions with the given code
  const refusingWindows = (code: string) => ({ ...d1Compile, accepts: (stmts, ctx, at) => {
    if (JSON.stringify(stmts).includes('"over"')) throw new SqlRefusal(code, "window functions");
    return d1Compile.accepts(stmts, ctx, at);
  } });
  const printed = async (code: string) => {
    const e = await engine();
    useCompileSide(refusingWindows(code));
    try {
      const r = new Report();
      await printer.run(r, e);
      return { failed: r.failed.length, check: r.checks.at(-1).name };
    } finally { useCompileSide(undefined); await e.driver.dispose(); }
  };
  const unsupported = await printed("SQL_UNSUPPORTED");
  expect(unsupported.failed).toBe(0);
  expect(unsupported.check).toMatch(/refused as unsupported: \w/);
  await expect(printed("SQL_COLUMN")).rejects.toThrow(/^SQL_COLUMN: window functions/);
}, 120_000);

it("a nested condition as an operand prints in parentheses: SQLite runs the IR, not a regrouped expression", async () => {
  await loadModule();
  const d1 = await LocalD1.create();
  try {
    // SQLite groups BETWEEN, LIKE and IN left to right: without the parentheses each of these selects another value
    for (const q of ["SELECT 5 BETWEEN 0 AND (5 BETWEEN 1 AND 2) AS v", "SELECT 5 BETWEEN 0 AND (5 IN (SELECT 1)) AS v", "SELECT 'a' LIKE ('a' IN (SELECT 1)) AS v",
      "SELECT 'ab' LIKE 'a%' ESCAPE ('!' = '!') AS v", "SELECT (1 IN (SELECT 1)) BETWEEN 0 AND 0 AS v", "SELECT (2 = 2) IS NULL AS v"]) {
      const printed = print((parseSync(q) as any).stmts[0].stmt);
      expect([q, (await d1.all(printed))[0]]).toEqual([q, (await d1.all(q))[0]]);
    }
  } finally { await d1.dispose(); }
});

it("a literal cast or signed constant in ORDER BY sorts by its value, never as a column position", async () => {
  const e = await engine();
  try {
    const s = site(await boot(e));
    // the IR orders by a constant, then id: the first row is 'a'; a bare 2 would sort by the second column (stock)
    // (`+2` written in SQL is refused: a sign over a number constant is that constant)
    await expect(program("view", "SELECT id FROM items ORDER BY +2, id")).rejects.toThrow(/a sign over a number/);
    for (const cast of ["CAST('0.2' AS numeric(10,1))", "CAST('1970-01-03' AS date)"]) {
      const p = await program("view", `SELECT id FROM (SELECT id, stock FROM items ORDER BY ${cast}, id LIMIT 1) s ORDER BY id`);
      expect([cast, (await runView(s, p, { ...caller({}), role: "staff" })).rows]).toEqual([cast, [{ id: "a" }]]);
    }
  } finally { await e.driver.dispose(); }
}, 120_000);

it("a sign before a negative constant never prints `--`, and `true` is the boolean even beside an output named true", async () => {
  const stmt = (val: unknown) => ({ SelectStmt: { targetList: [{ ResTarget: { val } }], limitOption: "LIMIT_OPTION_DEFAULT", op: "SETOP_NONE" } });
  const minus = (rexpr: unknown) => ({ A_Expr: { kind: "AEXPR_OP", name: [{ String: { sval: "-" } }], rexpr } });
  for (const c of [{ ival: { ival: -2 } }, { fval: { fval: "-2.5" } }]) expect(print(stmt(minus({ A_Const: c })) as never)).not.toContain("--");
  const e = await engine();
  try {
    const s = site(await boot(e));
    const p = await program("view", `SELECT id, 0 AS "true" FROM items WHERE true ORDER BY id`);
    expect((await runView(s, p, { ...caller({}), role: "staff" })).rows.map((r: any) => r.id)).toEqual(["a", "b", "c", "d"]);
  } finally { await e.driver.dispose(); }
}, 120_000);
