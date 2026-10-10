// Store read cost: `store.select` (before), Schema readers (after, ADR-0043) and the same statement run natively.
//
//   pnpm --filter @aotter/mantle build && node packages/mantle/spike/bench-readers.mjs [--cold-only|--warm-only]
//
// Not run in CI. Needs Node 22 (node:sqlite). Reports microseconds of Mantle overhead per call: the call's wall time minus the time
// spent inside the driver. A reader's counters check that a warm call runs no conversion and no dialect check.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const dist = new URL("../dist/", import.meta.url);
const load = (p) => import(new URL(p, dist));
const hr = () => process.hrtime.bigint();
const us = (ns) => Number(ns) / 1000;
const pct = (xs, p) => xs.slice().sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))];
const ROWS = 20_000;
const OWNERS = 20;

/** A DatabaseDriver over node:sqlite that accumulates the time spent inside it. */
function timedDriver(db) {
  const driver = { db, spent: 0n, async batch(statements) {
    const t = hr();
    driver.last = statements.at(-1);
    try {
      return statements.map(({ sql, binds }) => {
        const s = db.prepare(sql);
        const args = (binds ?? []).map((b) => (typeof b === "boolean" ? Number(b) : b ?? null));
        return { rows: s.columns().length ? s.all(...args).map((r) => ({ ...r })) : (s.run(...args), []) };
      });
    } finally { driver.spent += hr() - t; }
  } };
  return driver;
}

/** The harness's converged fixture Schemas, plus about 20k rows of `items` over 20 owners. */
async function open(file) {
  const { sqliteStorage } = await load("d1/index.js");
  const { NOW, schemas } = await load("testing/harness.js");
  const { RUNTIME_PLAN_VERSION } = await load("spec/index.js");
  const { createStore } = await load("core/store/createStore.js");
  const db = new DatabaseSync(file);
  const driver = timedDriver(db);
  const fresh = !db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'items'").all().length;
  const storage = sqliteStorage(driver);
  const { name, version } = storage.dialect;
  const plan = { version: RUNTIME_PLAN_VERSION, dialect: { name, version }, fingerprint: "bench", views: {}, procedures: {}, triggers: {},
    schemas: Object.fromEntries(Object.entries(schemas).map(([n, d]) => [n, { ...d, name: n, names: {}, schema: { type: "object" } }])) };
  const { executor: inner } = await storage.prepare(plan);
  const b = { executor: inner, dialect: storage.dialect, schemas };
  if (fresh) {
    db.exec("BEGIN");
    const ins = db.prepare("INSERT INTO items (id, owner, created_at, updated_at, name, cat, stock, tags, note) VALUES (?, ?, ?, ?, ?, ?, ?, '[]', ?)");
    for (let i = 0; i < ROWS; i++) ins.run(`k${String(i).padStart(6, "0")}`, `o${i % OWNERS}`, NOW - i, NOW - i * 7, `name ${i}`, `c${i % 9}`, i % 100, i % 5 ? null : `note ${i}`);
    db.exec("CREATE INDEX IF NOT EXISTS bench_owner_updated ON items (owner, updated_at)");
    db.exec("COMMIT");
  }
  const sent = [];
  const executor = { maxBindings: b.executor.maxBindings, select: (st) => (sent.push(st), b.executor.select(st)), apply: (x) => b.executor.apply(x) };
  let n = 0;
  const store = createStore({ executor, dialect: b.dialect, schemas: b.schemas, views: {}, now: () => NOW, newId: () => `id${++n}` });
  return { db, driver, store, sent, dialect: b.dialect };
}

const user = (subject) => ({ kind: "user", subject, role: null, scopes: [], credential: "session", credentialId: null, clientId: null });

/** Each shape: how to call a reader, how to call select, and the values that vary per call. */
const SHAPES = {
  "get(id)": { reader: (s, i) => s.db.items.get(`k${String((i * 37) % ROWS).padStart(6, "0")}`), select: (s, i) => s.select({ from: "items", where: { id: `k${String((i * 37) % ROWS).padStart(6, "0")}` }, limit: 1 }) },
  "first(eq)": { reader: (s, i) => s.db.items.first({ where: { cat: `c${i % 9}` } }), select: (s, i) => s.select({ from: "items", where: { cat: `c${i % 9}` }, limit: 1 }) },
  "find(eq, gte) x50": { reader: (s, i) => s.db.items.find({ where: { cat: `c${i % 9}`, stock: { gte: i % 90 } }, limit: 50 }), select: (s, i) => s.select({ from: "items", where: { cat: `c${i % 9}`, stock: { gte: i % 90 } }, limit: 50 }) },
  "find(in 7)": { reader: (s, i) => s.db.items.find({ columns: ["id", "name"], where: { id: { in: Array.from({ length: 7 }, (_, j) => `k${String((i + j) % ROWS).padStart(6, "0")}`) } } }), select: (s, i) => s.select({ from: "items", columns: ["id", "name"], where: { id: { in: Array.from({ length: 7 }, (_, j) => `k${String((i + j) % ROWS).padStart(6, "0")}`) } } }) },
  "find(search)": { reader: (s, i) => s.db.items.find({ search: `k${String(i % ROWS).padStart(6, "0")}` }), select: (s, i) => s.select({ from: "items", search: `k${String(i % ROWS).padStart(6, "0")}` }) },
  "find page 2": {
    setup: async (s) => ({ cursor: (await s.db.items.find({ where: { cat: "c1" }, orderBy: { id: "asc" }, limit: 50 })).nextCursor }),
    reader: (s, i, ctx) => s.db.items.find({ where: { cat: "c1" }, orderBy: { id: "asc" }, limit: 50, cursor: ctx.cursor }),
    select: (s, i, ctx) => s.select({ from: "items", where: { cat: "c1" }, orderBy: { id: "asc" }, limit: 50, cursor: ctx.cursor }),
  },
};

async function warm() {
  const { StoreJson } = await load("core/store/json.js");
  const dir = mkdtempSync(join(tmpdir(), "bench-readers-"));
  const file = join(dir, "bench.sqlite");
  try {
    const { db, driver, store, sent, dialect } = await open(file);
    const me = store.as(user("o3"));
    const rows = [];
    for (const [name, shape] of Object.entries(SHAPES)) {
      const ctx = shape.setup ? await shape.setup(me) : {};
      const measure = async (call) => {
        for (let i = 0; i < 200; i++) await call(me, i, ctx);
        const over = [];
        for (let i = 0; i < 5000; i++) {
          const spent = driver.spent;
          const t = hr();
          await call(me, i, ctx);
          over.push(us(hr() - t - (driver.spent - spent)));
        }
        return over;
      };
      const select = await measure(shape.select);
      await shape.reader(me, 1, ctx); // the shape's first call converts and compiles; the counters see only what follows
      // counters: a warm reader runs no conversion and no dialect check
      const read = StoreJson.prototype.read;
      let conversions = 0;
      StoreJson.prototype.read = function (...a) { conversions++; return read.apply(this, a); };
      const check = dialect.check;
      let checks = 0;
      dialect.check = (...a) => (checks++, check(...a));
      const reader = await measure(shape.reader);
      StoreJson.prototype.read = read;
      dialect.check = check;
      // the same statement natively: the printed SQL and binds of the last reader call
      const last = driver.last;
      const native = [];
      if (last?.sql) {
        const stmt = db.prepare(last.sql);
        for (let i = 0; i < 5000; i++) { const t = hr(); stmt.all(...last.binds.map((b) => b ?? null)); native.push(us(hr() - t)); }
      }
      rows.push({ shape: name, selectP50: pct(select, 0.5), selectP95: pct(select, 0.95), readerP50: pct(reader, 0.5), readerP95: pct(reader, 0.95), nativeP50: native.length ? pct(native, 0.5) : NaN, conversions, checks });
    }
    console.log("\nWARM: Mantle overhead per call (wall minus driver), microseconds; native is the driver call alone for the same statement");
    console.table(rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === "number" ? Math.round(v * 10) / 10 : v]))));
    if (rows.some((r) => r.conversions || r.checks)) { console.error("a warm reader converted or checked"); process.exitCode = 1; }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** One cold sample in a fresh process: boot, the first call of each shape, then the second with other values and another caller. */
async function coldSample(file) {
  const t0 = hr();
  const { driver, store } = await open(file);
  const boot = us(hr() - t0);
  const me = store.as(user("o3"));
  const out = { boot };
  for (const [name, shape] of Object.entries(SHAPES)) {
    if (shape.setup) continue;
    const timed = async (caller, i) => { const spent = driver.spent; const t = hr(); await shape.reader(caller, i, {}); return us(hr() - t - (driver.spent - spent)); };
    out[name] = { first: await timed(me, 1), second: await timed(me, 2), otherCaller: await timed(store.as(user("o4")), 3) };
  }
  console.log(JSON.stringify(out));
}

async function cold() {
  const dir = mkdtempSync(join(tmpdir(), "bench-readers-cold-"));
  const file = join(dir, "bench.sqlite");
  try {
    await (await open(file)).db.close();
    const samples = Array.from({ length: 20 }, () => JSON.parse(spawnSync(process.execPath, ["--no-warnings", fileURLToPath(import.meta.url), "--cold-sample", file], { encoding: "utf8" }).stdout));
    console.log(`\nCOLD: ${samples.length} fresh processes; microseconds of Mantle overhead (p50 over samples). boot is runtime boot plus the seeded database open`);
    console.log("boot", Math.round(pct(samples.map((s) => s.boot), 0.5)));
    console.table(Object.fromEntries(Object.keys(SHAPES).filter((n) => samples[0][n]).map((n) => [n, Object.fromEntries(["first", "second", "otherCaller"].map((k) => [k, Math.round(pct(samples.map((s) => s[n][k]), 0.5) * 10) / 10]))])));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

const arg = process.argv[2];
if (arg === "--cold-sample") await coldSample(process.argv[3]);
else {
  if (arg !== "--cold-only") await warm();
  if (arg !== "--warm-only") await cold();
}
