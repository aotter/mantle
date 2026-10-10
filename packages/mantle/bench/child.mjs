// The only process that imports Mantle. run.mjs spawns it as
//   node --expose-gc --disable-warning=ExperimentalWarning child.mjs '<json args>'
// and reads one stdout line `@@BENCH <json>`. Modes: seed | record | cold-mantle | cold-native | warm | counters.
// Cold modes are one item per fresh process; warm is one process and one runtime for every item.
import { readFileSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { parse as decodeJson, stringify as encodeJson } from "./lib/codec.mjs";
import { startCoverage } from "./lib/counters.mjs";
import { newRecorder, nodeSqliteDriver, replay, resetRecorder, timed } from "./lib/drivers.mjs";
import { insertRows } from "./lib/prepare.mjs";
import { shuffle } from "./lib/stats.mjs";
import { loadHandlers, loadItems } from "./lib/target.mjs";

const tStart = performance.now();
const args = JSON.parse(process.argv[2]);
const us = (ms) => ms * 1000;
const readPlan = (path) => { const j = JSON.parse(readFileSync(path, "utf8")); return j.plan ?? j; };
const emit = (value) => process.stdout.write(`@@BENCH ${JSON.stringify(value)}\n`, () => process.exit(0));

/** Config and items import no Mantle; they are loaded before any measured step. */
async function loadApp() {
  const config = (await import(args.configUrl)).default;
  const items = await loadItems(config, args.configDir);
  const byName = new Map(items.map((i) => [i.name, i]));
  const records = args.recordFile && args.mode !== "record" ? new Map(decodeJson(readFileSync(args.recordFile, "utf8")).map((r) => [r.item, r])) : new Map();
  return { config, items, byName, records };
}

const contextOf = (runtime, config, item) => {
  const caller = config.callers[item.caller];
  return { runtime, caller, store: runtime.store.as(caller, { kind: "internal", id: "bench" }), fixture: config.fixture };
};

async function importMantle() {
  const core = await import(args.mantle.core);
  const d1 = await import(args.mantle.d1);
  return { core, d1 };
}

async function bootRuntime(app, rec) {
  const { core, d1 } = await importMantle();
  const handlers = await loadHandlers(app.config.handlers, args.configDir);
  const driver = timed(nodeSqliteDriver(args.dbPath), rec);
  const runtime = await core.createMantleRuntime({ plan: readPlan(args.planPath), handlers, storage: d1.sqliteStorage(driver), schedules: true, now: () => Date.parse(app.config.now) * 1000 });
  return runtime;
}

const modes = {
  async seed() {
    const app = await loadApp();
    const { d1 } = await importMantle();
    const plan = readPlan(args.planPath);
    const driver = nodeSqliteDriver(args.dbPath);
    const storage = d1.sqliteStorage(driver);
    await storage.prepare(plan);
    const seed = await import(new URL(app.config.seed, args.configUrl).href);
    await insertRows(driver, plan, storage.dialect.codec, seed.rows(), { nowIso: app.config.now });
    await driver.batch([{ sql: "ANALYZE" }]);
    driver.db.close();
    return { ok: true };
  },

  /** Boots once and calls every item once with the recorder reset just before the call. */
  async record() {
    const app = await loadApp();
    const rec = newRecorder();
    const runtime = await bootRuntime(app, rec);
    const out = [];
    for (const item of app.items.filter((i) => !args.only || args.only.includes(i.name))) {
      try {
        const ctx = contextOf(runtime, app.config, item);
        const callArgs = item.prepare ? await item.prepare(ctx) : undefined;
        resetRecorder(rec);
        const result = await item.call(ctx, callArgs);
        out.push({ item: item.name, args: callArgs ?? null, rows: item.rows(result), calls: rec.calls.map(({ method, stmts, counts }) => ({ method, stmts, counts })) });
      } catch (error) {
        out.push({ item: item.name, error: String(error?.stack ?? error).slice(0, 2000) });
      }
    }
    writeFileSync(args.recordFile, encodeJson(out));
    return { items: out.map((r) => ({ item: r.item, rows: r.rows, error: r.error, counts: r.calls?.map((c) => c.counts) })) };
  },

  /** The cold timeline of one item: imports, plan, boot, then the first, second and third call. */
  async "cold-mantle"() {
    const app = await loadApp();
    const item = app.byName.get(args.item);
    const callArgs = app.records.get(args.item)?.args ?? undefined;
    const rec = newRecorder();
    const step = async (fn) => { const t = performance.now(); const value = await fn(); return [performance.now() - t, value]; };
    const [importCore, core] = await step(() => import(args.mantle.core));
    const [importDialect, d1] = await step(() => import(args.mantle.d1));
    const [importHandlers, handlers] = await step(() => loadHandlers(app.config.handlers, args.configDir));
    const [planMs, plan] = await step(async () => readPlan(args.planPath));
    const [boot, runtime] = await step(() => core.createMantleRuntime({ plan, handlers, storage: d1.sqliteStorage(timed(nodeSqliteDriver(args.dbPath), rec)), schedules: true, now: () => Date.parse(app.config.now) * 1000 }));
    const bootSql = rec.sqlUs / 1000;
    const ctx = contextOf(runtime, app.config, item);
    const calls = [];
    for (let i = 0; i < 3; i++) {
      resetRecorder(rec);
      const [ms, result] = await step(() => item.call(ctx, callArgs));
      calls.push({ ms, sql: rec.sqlUs / 1000, counts: rec.calls.map((c) => c.counts), rows: item.rows(result) });
    }
    return { tStart, importCore, importDialect, importHandlers, plan: planMs, boot, bootSql, first: calls[0].ms, firstSql: calls[0].sql, second: calls[1].ms, secondSql: calls[1].sql, third: calls[2].ms, rows: calls[0].rows, counts: calls[0].counts };
  },

  /** A fresh process that only opens the database and replays the recorded SQL and binds. */
  async "cold-native"() {
    const record = decodeJson(readFileSync(args.recordFile, "utf8")).find((r) => r.item === args.item);
    const rec = newRecorder();
    const t0 = performance.now();
    const driver = timed(nodeSqliteDriver(args.dbPath), rec);
    const open = performance.now() - t0;
    const runs = [];
    for (let i = 0; i < 2; i++) {
      resetRecorder(rec);
      const t = performance.now();
      const counts = await replay(driver, record.calls);
      runs.push({ ms: performance.now() - t, sql: rec.sqlUs / 1000, counts });
    }
    return { tStart, open, first: runs[0].ms, firstSql: runs[0].sql, second: runs[1].ms, counts: runs[0].counts };
  },

  /** Exact call counts per phase, under precise coverage (which distorts timing: these runs report no times). */
  async counters() {
    const coverage = await startCoverage(args.mantle.dirUrl); // before any Mantle import
    const app = await loadApp();
    const item = app.byName.get(args.item);
    const callArgs = app.records.get(args.item)?.args ?? undefined;
    const rec = newRecorder();
    const runtime = await bootRuntime(app, rec);
    const phases = { boot: await coverage.take() };
    const ctx = contextOf(runtime, app.config, item);
    for (const phase of ["first", "second"]) {
      await item.call(ctx, callArgs);
      phases[phase] = await coverage.take();
    }
    // steady state: three more calls, the last one is "warm"
    for (let i = 0; i < 3; i++) await item.call(ctx, callArgs);
    await coverage.take();
    await item.call(ctx, callArgs);
    phases.warm = await coverage.take();
    await coverage.stop();
    return { counts: Object.fromEntries(Object.entries(phases).map(([k, v]) => [k, v.counts])), status: phases.warm.status };
  },

  /** One runtime for every item: paired Mantle/native samples, rotated item order per round. */
  async warm() {
    const app = await loadApp();
    const rec = newRecorder();
    const nativeRec = newRecorder();
    const runtime = await bootRuntime(app, rec);
    const raw = nodeSqliteDriver(args.dbPath);
    const native = timed(raw, nativeRec);
    const selected = app.items.filter((i) => !args.only || args.only.includes(i.name));
    const prepared = new Map();
    for (const item of selected) {
      const ctx = contextOf(runtime, app.config, item);
      prepared.set(item.name, { ctx, args: item.prepare ? await item.prepare(ctx) : undefined });
    }
    const cpu = () => { const u = process.cpuUsage(); return u.user + u.system; };
    const results = Object.fromEntries(selected.map((i) => [i.name, { rounds: [] }]));
    const failed = new Set();

    for (let round = 0; round < args.rounds; round++) {
      globalThis.gc?.();
      const order = shuffle(selected, 1000 + round);
      if (round % 2) order.reverse();
      for (const item of order) {
        if (failed.has(item.name)) continue;
        const { ctx, args: callArgs } = prepared.get(item.name);
        const wanted = item.samples ?? args.samples;
        const warmups = round === 0 ? (item.warmup ?? args.warmup) : Math.max(3, Math.floor((item.warmup ?? args.warmup) / 4));
        globalThis.gc?.();
        const mantleOnce = async () => {
          resetRecorder(rec);
          const c0 = cpu();
          const t0 = performance.now();
          await item.call(ctx, callArgs);
          const wall = us(performance.now() - t0);
          return { wall, cpu: cpu() - c0, sql: rec.sqlUs, calls: rec.calls };
        };
        const nativeOnce = async (calls) => {
          resetRecorder(nativeRec);
          const c0 = cpu();
          const t0 = performance.now();
          await replay(native, calls);
          return { wall: us(performance.now() - t0), cpu: cpu() - c0 };
        };
        try {
          let last;
          for (let i = 0; i < warmups; i++) last = (await mantleOnce()).calls;
          const round_ = { mantleUs: [], sqlUs: [], nativeUs: [], cpuMantleUs: 0, cpuNativeUs: 0 };
          const started = performance.now();
          for (let i = 0; i < wanted; i++) {
            let m, n;
            if (i % 2 === 0) {
              m = await mantleOnce();
              n = await nativeOnce(m.calls);
            } else {
              n = await nativeOnce(last); // the previous Mantle call's statements: the SQL is identical every call
              m = await mantleOnce();
            }
            last = m.calls;
            round_.mantleUs.push(m.wall); round_.sqlUs.push(m.sql); round_.nativeUs.push(n.wall);
            round_.cpuMantleUs += m.cpu; round_.cpuNativeUs += n.cpu;
            if (performance.now() - started > args.budgetMs && i + 1 >= 10) break;
          }
          const n = round_.mantleUs.length;
          results[item.name].rounds.push({ ...round_, cpuMantleUs: round_.cpuMantleUs / n, cpuNativeUs: round_.cpuNativeUs / n });
        } catch (error) {
          failed.add(item.name);
          results[item.name] = { error: String(error?.stack ?? error).slice(0, 2000) };
        }
      }
    }
    return { results };
  },
};

try {
  if (!modes[args.mode]) throw new Error(`unknown mode ${args.mode}`);
  emit({ ok: true, ...(await modes[args.mode]()) });
} catch (error) {
  emit({ ok: false, error: String(error?.stack ?? error).slice(0, 3000) });
}
