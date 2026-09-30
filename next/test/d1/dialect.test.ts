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
import { Report } from "../../src/testing/report.js";
import { boot, caller, compileProgram, program, runView, site } from "../../src/testing/harness.js";
import { VIEW } from "../../src/testing/cases/report-view.js";
import { corpus } from "../../src/testing/cases/corpus.js";
import * as types from "./cases/types.js";

const engine = async () => { const d1 = await LocalD1.create(); return { d1, engine: { storage: sqliteStorage(d1), driver: d1 } }; };

it("the types case: D1's storage encodings give PostgreSQL's results", async () => {
  const { d1, engine: e } = await engine();
  try {
    const r = new Report();
    await types.run(r, e);
    expect(r.failed.map((c) => `${c.name}: ${c.detail ?? ""}`)).toEqual([]);
  } finally { await d1.dispose(); }
}, 120_000);

it("the policy wrapper prints scope and TTL once per Schema, and SQLite's plan still uses the scope index", async () => {
  const { d1, engine: e } = await engine();
  try {
    const s = site(await boot(e));
    const sql = print(compileProgram(s, await program("view", VIEW, { min: "int8" }))[0].ast);
    expect(sql).toMatch(/FROM items WHERE items\.owner = \?1 AND \(items\.expires_at IS NULL OR items\.expires_at > \?2\)/);
    expect(sql).toMatch(/FROM orders WHERE orders\.owner = \?1/);
    expect(sql).not.toMatch(/\?4/);
    const detail = (await s.d1.all(`EXPLAIN QUERY PLAN ${sql}`, ["o1", 0, 0])).map((x) => x.detail).join(" | ");
    expect(detail).toMatch(/_mantle_scope_items/);
    expect(detail).toMatch(/_mantle_scope_orders/);
  } finally { await d1.dispose(); }
}, 120_000);

it("FTS5 trigram matches nothing under three characters, so search falls back to a scan; D1's meta.changes counts trigger writes", async () => {
  const { d1, engine: e } = await engine();
  try {
    const b = await boot(e);
    const s = site(b);
    expect((await b.d1.all('SELECT rowid FROM "_mantle_fts_notes" WHERE "_mantle_fts_notes" = ?1', ['"小籠"'])).length).toBe(0);
    const search = await program("view", "SELECT id FROM notes WHERE mantle.search(notes, input.q) ORDER BY id", { q: "text" });
    expect((await runView(s, search, caller({ q: "小籠" }))).rows).toEqual([{ id: "n1" }]);
    // so a write's count must be changes() inside the batch, never D1's meta.changes
    expect((await b.d1.batch([{ sql: "UPDATE notes SET title = 'renamed' WHERE id = 'n3'" }]))[0].changes).not.toBe(1);
  } finally { await d1.dispose(); }
}, 120_000);

it("D1's compile side accepts every printer corpus item, so the suite's corpus case runs all of them on D1", async () => {
  const refused = [];
  for (const item of corpus) await program(item.kind, item.sql, item.inputs ?? {}).catch((err) => refused.push(`${item.id}: ${err.message}`));
  expect(refused).toEqual([]);
});
