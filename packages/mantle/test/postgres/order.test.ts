// @ts-nocheck test code over loosely typed plans and rows
/**
 * ADR-0039 decision 2, ordering: PostgreSQL pages in its own NULL order (NULL last ascending, first descending) with an id tiebreak
 * that follows the last key, so a declared btree index (and the default updated_at index) serves each paged sort. EXPLAIN is the
 * proof: no Sort node, an index scan on the index the author declared.
 */
import { expect, it } from "vitest";
import { RUNTIME_PLAN_VERSION } from "../../src/spec/index.js";
import { pgDatabaseDriver, postgresStorage } from "../../src/postgres/index.js";
import { print, typed } from "../../src/postgres/print.js";
import * as pgCompile from "../../src/postgres/compile/index.js";
import { Db, caller, program, runView, useCompileSide } from "../../src/testing/harness.js";
import { PG_URL, freshSchema } from "./engine.js";

const schemas = {
  // a nullable sort key with a declared index; the tiebreak id rides in the index
  reqs: { fields: { amount: "integer", name: "text" }, indexes: [["amount", "id"]] },
  // a scoped Schema: Admin's default list reads one owner's rows newest first
  notes: { scope: "owner", fields: { title: "text" } },
};

const nodes = (plan: any): any[] => [plan, ...(plan.Plans ?? []).flatMap(nodes)];

it.skipIf(!PG_URL)("a declared index and the default updated_at index serve paged sorts, in PostgreSQL's NULL order", async () => {
  const db = await freshSchema();
  useCompileSide(pgCompile);
  try {
    const storage = postgresStorage({ connect: db.connect });
    const plan = { version: RUNTIME_PLAN_VERSION, dialect: { name: pgCompile.name, version: pgCompile.version }, fingerprint: "order", views: {}, procedures: {}, triggers: {},
      schemas: Object.fromEntries(Object.entries(schemas).map(([n, d]) => [n, { ...d, name: n, names: {}, schema: { type: "object" } }])) };
    const { executor } = await storage.prepare(plan);
    const d = new Db(pgDatabaseDriver(db.connect));
    await d.exec([
      "INSERT INTO reqs (id, created_at, updated_at, amount, name) SELECT 'r' || lpad(g::text, 6, '0'), now(), now() - g * interval '1 second', CASE WHEN g % 10 = 0 THEN NULL ELSE g % 500 END, 'n' || g FROM generate_series(1, 5000) g",
      "INSERT INTO notes (id, owner, created_at, updated_at, title) SELECT 'n' || lpad(g::text, 6, '0'), CASE WHEN g % 2 = 0 THEN 'o1' ELSE 'o2' END, now(), now() - g * interval '1 second', 't' || g FROM generate_series(1, 5000) g",
      "ANALYZE reqs", "ANALYZE notes",
    ]);
    const seen: any[] = [];
    const s = { d1: d, schemas, dialect: storage.dialect, executor: { maxBindings: executor.maxBindings, apply: (b) => executor.apply(b), select: (st) => (seen.push(st), executor.select(st)) } };
    const explain = async (st) => {
      const [r] = await d.driver.batch([{ sql: `EXPLAIN (FORMAT JSON) ${print(typed(st.ir, schemas))}`, binds: st.binds }]);
      const plan = r.rows[0]["QUERY PLAN"];
      return nodes((typeof plan === "string" ? JSON.parse(plan) : plan)[0].Plan);
    };
    const served = async (sql: string, index: string, opts = {}) => {
      seen.length = 0;
      const p = await program("view", sql, {}, schemas);
      const page = await runView(s, p, caller(), { pageSize: 50, ...opts });
      const plan = await explain(seen.at(-1));
      expect(plan.map((n) => n["Node Type"]), sql).not.toContain("Sort");
      expect(plan.find((n) => n["Index Name"])?.["Index Name"], sql).toBe(index);
      return page;
    };

    // NULL last ascending, first descending; the tiebreak follows the last key
    const asc = await served("SELECT id, amount FROM reqs ORDER BY amount", "_mantle_ix_reqs_0");
    expect(asc.rows[0]).toEqual({ id: "r000001", amount: 1 });
    const desc = await served("SELECT id, amount FROM reqs ORDER BY amount DESC", "_mantle_ix_reqs_0");
    expect(desc.rows[0]).toEqual({ id: "r005000", amount: null });
    expect(desc.rows.slice(0, 2).map((r) => r.id)).toEqual(["r005000", "r004990"]);
    // a cursor (a value, then past the NULLs) keeps the index
    await served("SELECT id, amount FROM reqs ORDER BY amount", "_mantle_ix_reqs_0", { cursor: [7, "r000507"] });
    await served("SELECT id, amount FROM reqs ORDER BY amount DESC", "_mantle_ix_reqs_0", { cursor: [null, "r004990"] });
    // the default list order: updated_at descending (Admin), unscoped and scoped
    await served("SELECT id FROM reqs ORDER BY updated_at DESC", "_mantle_ix_reqs_updated");
    await served("SELECT id FROM notes ORDER BY updated_at DESC", "_mantle_ix_notes_updated");

    // paging walks the NULLs in order, without a repeat or a gap
    const p = await program("view", "SELECT id, amount FROM reqs WHERE amount IS NULL OR amount = 499 ORDER BY amount", {}, schemas);
    const ids: string[] = [];
    for (let after; ;) {
      const page = await runView(s, p, caller(), { pageSize: 300, ...(after ? { cursor: after } : {}) });
      ids.push(...page.rows.map((r) => r.id));
      if (!(after = page.next)) break;
    }
    expect(ids.length).toBe(500 + 10);
    expect(ids.slice(-500).every((id) => (Number(id.slice(1)) % 10) === 0)).toBe(true);
    expect(ids.slice(0, 10).every((id) => Number(id.slice(1)) % 500 === 499)).toBe(true);
  } finally { useCompileSide(undefined); await db.drop(); }
}, 60_000);
