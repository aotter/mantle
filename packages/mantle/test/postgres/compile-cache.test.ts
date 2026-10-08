// @ts-nocheck test code over loosely typed IR and rows
/**
 * The compile and print caches on a real PostgreSQL: a View or Procedure run again on warm caches, by other callers and in any order,
 * returns exactly the rows (and cursors, and write results) a program of new identities returns. test/core/compile-cache.test.ts
 * proves the SQL and binds; this proves what the server answers to them.
 */
import { expect, it } from "vitest";
import { pgDatabaseDriver, postgresStorage } from "../../src/postgres/index.js";
import * as pgCompile from "../../src/postgres/compile/index.js";
import { boot, caller, program, reset, runProcedure, runView, site, useCompileSide } from "../../src/testing/harness.js";
import { corpus } from "../../src/testing/cases/corpus.js";
import { VIEW } from "../../src/testing/cases/report-view.js";
import { PG_URL, freshSchema } from "./engine.js";

it.skipIf(!PG_URL)("warm caches give the rows, cursors and write results the cold path gives", async () => {
  const { connect, drop } = await freshSchema();
  useCompileSide(pgCompile);
  try {
    const b = await boot({ storage: postgresStorage({ connect }), driver: pgDatabaseDriver(connect) });
    const s = site(b);
    const as = (uid: string | null, role?: string, input = {}) => ({ ...caller(input, uid), ...(role ? { role } : {}) });
    const callers = [["o1", "staff"], ["o2", undefined], [null, undefined], ["o1", undefined]] as const;
    const cold = async (p, bind, run) => run(site(b), structuredClone(p), bind);

    for (const base of corpus) {
      const item = b.dialect.nativeSql && base.native ? { ...base, ...base.native } : base;
      const p = await program(item.kind, item.sql, item.inputs ?? {}).catch((e) => (/^SQL_(UNSUPPORTED|FUNCTION|TYPE):/.test(e.message) ? undefined : Promise.reject(e)));
      if (!p) continue;
      const run = item.kind === "view" ? (st, q, bind) => runView(st, q, bind).then((r) => r.rows) : (st, q, bind) => runProcedure(st, q, bind).then((r) => r.rows);
      const settle = (f) => f().then((v) => ({ v }), (e) => ({ e: String(e.diagnostic?.message ?? e.message) }));
      for (const order of [callers, [...callers].reverse()]) {
        const warm = structuredClone(p);
        for (let round = 0; round < 2; round++)
          for (const [uid, role] of order) {
            const bind = as(uid, role, item.input);
            if (item.kind === "procedure") await reset(b);
            const got = await settle(() => run(s, warm, bind));
            if (item.kind === "procedure") await reset(b);
            expect(got, `${item.id} as ${uid}/${role} round ${round}`).toEqual(await settle(() => cold(p, bind, run)));
          }
      }
    }

    // keyset paging, one row at a time, on a warm program: every page and cursor equals the cold program's
    for (const sql of [VIEW, "SELECT id, note FROM items ORDER BY note", "SELECT id, note FROM items ORDER BY note DESC", "SELECT id, name FROM items ORDER BY created_at DESC", "SELECT i.id FROM items i ORDER BY i.id"]) {
      const inputs = sql === VIEW ? { min: "int8" } : {};
      const p = await program("view", sql, inputs);
      const pages = async (st, q, bind) => {
        const out = [];
        let cursor;
        for (let i = 0; i < 8; i++) {
          const page = await runView(st, q, bind, { cursor, pageSize: 1 + (i % 2) });
          out.push(page);
          if (!page.next) break;
          cursor = page.next;
        }
        return out;
      };
      for (const [uid, role] of callers) {
        const bind = as(uid, role, { min: 0 });
        expect(await pages(s, p, bind), sql).toEqual(await cold(p, bind, pages));
      }
    }
  } finally {
    useCompileSide(undefined);
    await drop();
  }
}, 300_000);
