// @ts-nocheck test code over loosely typed results
/**
 * ADR-lite #1379: a pipelined client answers every read and every write batch in one round trip; a client that does not
 * pipeline takes three per read and N + 2 per batch. MANTLE_PG_ONE_WAY_MS adds latency each way and prints wall times.
 */
import { expect, it } from "vitest";
import { pgDatabaseDriver, postgresStorage } from "../../src/postgres/index.js";
import * as pgCompile from "../../src/postgres/compile/index.js";
import { boot, caller, isConflict, opIndexOf, program, runProcedure, runView, site, useCompileSide } from "../../src/testing/harness.js";
import { PG_URL, freshSchema } from "./engine.js";
import { roundTripProxy } from "./proxy.js";

const ONE_WAY_MS = Number(process.env.MANTLE_PG_ONE_WAY_MS ?? 0);

async function measure(pipeline: boolean) {
  const proxy = await roundTripProxy(new URL(PG_URL!), ONE_WAY_MS);
  const db = await freshSchema({ url: proxy.url, pipeline });
  useCompileSide(pgCompile);
  try {
    const s = site(await boot({ storage: postgresStorage({ connect: db.connect }), driver: pgDatabaseDriver(db.connect) }));
    const read = await program("view", "SELECT id, stock FROM items WHERE cat = 'x' ORDER BY id");
    const write = await program("procedure", [
      "UPDATE items SET stock = stock + 1 WHERE id = 'a'",
      "UPDATE items SET stock = stock + 1 WHERE id = 'b'",
      "UPDATE items SET stock = stock - 1 WHERE id = 'd'",
      "INSERT INTO settings (key, value) VALUES ('rt', 'x')",
    ].join("; "));
    const missing = await program("procedure", "UPDATE items SET stock = stock + 1 WHERE id = 'a'; UPDATE items SET stock = 1 WHERE id = 'nope'");
    // each operation opens its own connection: its round trips are that connection's, less the startup handshake
    const op = async (f: () => Promise<unknown>) => {
      const from = proxy.trips.length;
      const t0 = performance.now();
      const result = await f().catch((e) => e);
      const ms = performance.now() - t0;
      await new Promise((r) => setTimeout(r, 2 * ONE_WAY_MS + 20));
      return { result, ms, trips: proxy.trips.slice(from).map((n) => n - 1) };
    };
    const r = await op(() => runView(s, read, caller()));
    const w = await op(() => runProcedure(s, write, caller()));
    const c = await op(() => runProcedure(s, missing, caller()));
    const [after] = await pgDatabaseDriver(db.connect).batch([{ sql: "SELECT stock FROM items WHERE id = 'a'" }]);
    return { r, w, c, stockA: after.rows[0].stock };
  } finally { await db.drop(); await proxy.close(); }
}

it.skipIf(!PG_URL)("one round trip per read and per write batch when the client pipelines; 3 and N + 2 when it does not", async () => {
  const seq = await measure(false);
  const pipe = await measure(true);
  expect(seq.r.trips).toEqual([3]);
  expect(seq.w.trips).toEqual([4 + 2]);
  expect(pipe.r.trips).toEqual([1]);
  expect(pipe.w.trips).toEqual([1]);
  // an expect that fails is checked by PostgreSQL: CONFLICT naming op 1, op 0 rolled back, and still one round trip plus the ROLLBACK
  for (const m of [seq, pipe]) {
    expect(isConflict(m.c.result)).toBe(true);
    expect(opIndexOf(m.c.result)).toBe(1);
    expect(m.stockA).toBe(6);
  }
  expect(pipe.c.trips).toEqual([2]);
  if (ONE_WAY_MS) console.log(`one-way ${ONE_WAY_MS} ms: read ${seq.r.ms.toFixed(0)} -> ${pipe.r.ms.toFixed(0)} ms, 4-statement write ${seq.w.ms.toFixed(0)} -> ${pipe.w.ms.toFixed(0)} ms`);
}, 120_000);
