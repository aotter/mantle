// The SQLite-family DatabaseDriver over node:sqlite, a recording wrapper with engine-time accounting, and the native replay.
// Mantle calls and native replays go through the same wrapper, so its own overhead lands on both sides.
// No Mantle imports: the driver shape is Mantle's `DatabaseDriver` (src/core/driver.ts), duck-typed.
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";

const argsOf = (binds) => (binds ?? []).map((b) => (typeof b === "boolean" ? Number(b) : b ?? null));

/**
 * One transaction per batch, the engine's error rethrown unchanged; `all` and `first` are plain reads.
 * Rows are copied (`{ ...r }`) exactly as test/d1/node-sqlite.test.ts does: node:sqlite rows are null-prototype objects.
 * `busyUs` accumulates the time spent inside the engine calls themselves (synchronous work only), so it stays correct when
 * several driver calls are in flight at once (a handler's Promise.all) and each await would otherwise include the others' work.
 */
export function nodeSqliteDriver(path = ":memory:", options = {}) {
  const db = new DatabaseSync(path, options);
  const driver = {
    db,
    busyUs: 0,
    async batch(statements) {
      const t0 = performance.now();
      db.exec("BEGIN IMMEDIATE");
      try {
        const out = statements.map(({ sql, binds }) => {
          const s = db.prepare(sql);
          const args = argsOf(binds);
          return { rows: s.columns().length ? s.all(...args).map((r) => ({ ...r })) : (s.run(...args), []) };
        });
        db.exec("COMMIT");
        return out;
      } catch (e) {
        try { db.exec("ROLLBACK"); } catch {}
        throw e;
      } finally {
        driver.busyUs += (performance.now() - t0) * 1000;
      }
    },
    async all({ sql, binds }) {
      const t0 = performance.now();
      try {
        return db.prepare(sql).all(...argsOf(binds)).map((r) => ({ ...r }));
      } finally {
        driver.busyUs += (performance.now() - t0) * 1000;
      }
    },
    async first({ sql, binds }) {
      const t0 = performance.now();
      try {
        const row = db.prepare(sql).get(...argsOf(binds));
        return row ? { ...row } : null;
      } finally {
        driver.busyUs += (performance.now() - t0) * 1000;
      }
    },
  };
  return driver;
}

/** How many rows each statement of a driver call returned. */
const countsOf = (method, result) => (method === "batch" ? result.map((r) => r.rows.length) : method === "all" ? [result.length] : [result ? 1 : 0]);

/**
 * Wraps a driver for recording: every call is appended to `rec.calls` as `{ method, stmts, counts }` (statements by reference,
 * never copied). `rec.sqlUs` is the engine time of the wrapped driver since the last reset (its `busyUs`). Mantle calls and
 * native replays use this same wrapper, so its own cost lands on both sides.
 */
export function timed(driver, rec) {
  rec.driver = driver;
  rec.base = driver.busyUs;
  const wrap = (method) => async (arg) => {
    const result = await driver[method](arg);
    rec.calls.push({ method, stmts: method === "batch" ? arg : [arg], counts: countsOf(method, result) });
    return result;
  };
  return {
    batch: wrap("batch"),
    ...(driver.all ? { all: wrap("all") } : {}),
    ...(driver.first ? { first: wrap("first") } : {}),
  };
}

export const newRecorder = () => ({ calls: [], base: 0, driver: undefined, get sqlUs() { return this.driver ? this.driver.busyUs - this.base : 0; } });
export const resetRecorder = (rec) => { rec.base = rec.driver ? rec.driver.busyUs : 0; rec.calls = []; };

/** Replays recorded driver calls, in order, through a (timed) driver; returns the row counts of each statement. */
export async function replay(driver, calls) {
  const counts = [];
  for (const { method, stmts } of calls) {
    if (method === "batch") counts.push((await driver.batch(stmts)).map((r) => r.rows.length));
    else if (method === "all") counts.push([(await driver.all(stmts[0])).length]);
    else counts.push([(await driver.first(stmts[0])) ? 1 : 0]);
  }
  return counts;
}
