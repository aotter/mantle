// @ts-nocheck test code over loosely typed plans and rows
import { afterAll, beforeAll, expect, it, vi } from "vitest";

vi.mock("../../src/d1/print.js", async (load) => { const m = await load(); return { ...m, print: vi.fn(m.print) }; });
vi.mock("../../src/core/sql/policy.js", async (load) => { const m = await load(); return { ...m, applyPolicy: vi.fn(m.applyPolicy) }; });

import { LocalD1 } from "../../src/cloudflare/testing/d1.js";
import { createMantleRuntime, verifyPlan } from "../../src/core/index.js";
import { withLowering } from "../../src/core/sql/lowered.js";
import { lifecycleHookSets } from "../../src/core/runtime/hooks.js";
import { runProcedure } from "../../src/core/sql/run.js";
import { applyPolicy } from "../../src/core/sql/policy.js";
import { print } from "../../src/d1/print.js";
import { d1Dialect } from "../../src/d1/dialect.js";
import { sqliteStorage } from "../../src/d1/index.js";
import { postgresDialect } from "../../src/postgres/dialect.js";
import * as pgCompile from "../../src/postgres/compile/index.js";
import { MANIFESTS, compile, deterministic, reseal, user } from "./lowered-fixture.js";

const text = MANIFESTS.replace("lifecycle: operational", "lifecycle: publishing")
  .replace("on: [after_create]", "on: [before_create, before_update, before_delete, after_create, after_update, after_delete]") + `---
apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: { name: twice }
spec:
  requires: { auth: { all: [ctx.user] } }
  input: { type: object, required: [id], properties: { id: { type: string } } }
  output: { type: object }
  handler: { sql: "UPDATE items SET stock = stock - 1 WHERE id = input.id; UPDATE items SET stock = stock - 1 WHERE id = input.id" }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: { name: remove }
spec:
  requires: { auth: { all: [ctx.user] } }
  input: { type: object, required: [id], properties: { id: { type: string } } }
  output: { type: object }
  handler: { sql: "DELETE FROM items WHERE input.id = id RETURNING id" }
`;
let lowered, plain;
const dbs = [];
beforeAll(async () => {
  lowered = (await withLowering(await compile(undefined, text), d1Dialect)).plan;
  plain = await reseal(lowered, (p) => { delete p.lowered; return p; });
}, 60_000);
afterAll(() => Promise.all(dbs.map((d) => d.dispose())));

async function boot(plan) {
  const db = await LocalD1.create(); dbs.push(db);
  const storage = sqliteStorage(db), check = vi.fn(storage.dialect.check), events = [];
  let executor;
  const counted = { ...storage, dialect: { ...storage.dialect, check }, prepare: async (p) => {
    const prepared = await storage.prepare(p); executor = prepared.executor; return prepared;
  } };
  let changeDuringHook = false;
  const runtime = await createMantleRuntime({ plan, storage: counted, ...deterministic(), handlers: {
    audit: async (_input, ctx) => {
      events.push({ hook: ctx.cause.hook, rows: ctx.cause.rows });
      if (changeDuringHook && ctx.cause.hook === "before_update") {
        changeDuringHook = false;
        await db.exec({ sql: "UPDATE items SET stock = 17, version = version + 1 WHERE id = ?", binds: [ctx.cause.rows[0].id] });
      }
      if (ctx.cause.rows[0]?.name === "veto") throw new Error("hook veto");
      return {};
    },
  } });
  return { runtime, check, events, db, executor, dialect: counted.dialect, change: () => { changeDuringHook = true; } };
}
const call = (b, procedure, input, subject = "owner") => b.runtime.invokeProcedure({ procedure, input, caller: user(subject), cause: { kind: "http", id: "test" } });
const reset = (b) => { b.check.mockClear(); vi.mocked(applyPolicy).mockClear(); vi.mocked(print).mockClear(); };
const counts = (b) => ({ check: b.check.mock.calls.length, policy: vi.mocked(applyPolicy).mock.calls.length, print: vi.mocked(print).mock.calls.length });
const fail = (p) => p.then(() => undefined, (e) => e);
const mask = (x) => JSON.stringify(x).replace(/[0-9a-f]{32}/g, "<id>");
const idOf = (x) => x.results[0][0].id;

it("lowers lifecycle reads and locked writes under both modes and both printers, and verifies their provenance", async () => {
  const pg = (await withLowering(await compile(pgCompile, text), postgresDialect())).plan;
  for (const [p, dialect] of [[lowered, d1Dialect], [pg, postgresDialect()]]) {
    for (const mode of ["caller", "trusted"]) {
      expect(p.lowered.procedures["add-item"][mode][0].preRead.kind).toBe("read");
      expect(p.lowered.procedures.take[mode][0]).toMatchObject({ preRead: { kind: "read" }, one: { kind: "row" } });
      expect(p.lowered.procedures.remove[mode][0].one.binds).toContainEqual({ k: "version" });
    }
    expect(await verifyPlan(p, { dialect })).toEqual([]);
    for (const key of ["preRead", "one"]) {
      const bad = await reseal(p, (body) => { body.lowered.procedures.take.caller[0][key].sql = "SELECT 1"; return body; });
      expect((await verifyPlan(bad, { dialect })).some((d) => d.message.includes("LOWERING_MISMATCH"))).toBe(true);
    }
  }
});

it("does no cold or warm check/policy/print while rebinding hook snapshots, target ids and quantities per call", async () => {
  const b = await boot(lowered);
  reset(b);
  const id = idOf(await call(b, "add-item", { name: "one", stock: 10 }));
  expect(counts(b)).toEqual({ check: 0, policy: 0, print: 0 });
  b.events.length = 0;
  for (const qty of [1, 2]) {
    reset(b);
    await call(b, "take", { id, qty });
    expect(counts(b)).toEqual({ check: 0, policy: 0, print: 0 });
  }
  expect(b.events.map((e) => e.hook)).toEqual(["before_update", "after_update", "before_update", "after_update"]);
  expect(b.events.filter((e) => e.hook === "before_update").map((e) => e.rows[0].stock)).toEqual([10, 9]);
  reset(b);
  await call(b, "remove", { id });
  expect(counts(b)).toEqual({ check: 0, policy: 0, print: 0 });
});

it("matches the ordinary path's scope, veto, publishing protection and whole-batch version-pin rollback", async () => {
  const outcomes = [];
  for (const plan of [lowered, plain]) {
    const b = await boot(plan);
    const id = idOf(await call(b, "add-item", { name: "stable", stock: 10 }));
    b.events.length = 0;
    expect((await fail(call(b, "take", { id, qty: 1 }, "other"))).diagnostic.code).toBe("CONFLICT");
    expect(b.events).toEqual([]); // fail closed before a hook sees another owner's entry
    expect(await fail(call(b, "add-item", { name: "veto", stock: 4 }))).toBeDefined();
    expect((await fail(call(b, "twice", { id }))).diagnostic.code).toBe("CONFLICT");
    expect((await b.db.all("SELECT stock, version FROM items WHERE id = ?", id))[0]).toEqual({ stock: 10, version: 1 });
    b.change();
    expect((await fail(call(b, "take", { id, qty: 2 }))).diagnostic.code).toBe("CONFLICT");
    expect((await b.db.all("SELECT stock, version FROM items WHERE id = ?", id))[0]).toEqual({ stock: 17, version: 2 });
    await b.runtime.store.as(user("owner")).write([{ update: "items", where: { id }, set: { status: "published" } }]);
    expect((await fail(call(b, "take", { id, qty: 1 }))).diagnostic.code).toBe("CONFLICT");
    outcomes.push(mask({ events: b.events, rows: await b.db.all("SELECT id, name, stock, version, status FROM items ORDER BY name") }));
  }
  expect(outcomes[0]).toBe(outcomes[1]);
});

it("bounds nested auxiliary SQL and refuses recursive auxiliaries before lowering comparison", async () => {
  const recursive = await reseal(lowered, (p) => { p.lowered.procedures.take.caller[0].one.one = p.lowered.procedures.take.caller[0].preRead; return p; });
  expect((await verifyPlan(recursive, { dialect: d1Dialect })).some((d) => d.path.endsWith("/one") && d.message.includes("without nested"))).toBe(true);
  const oversized = await reseal(lowered, (p) => { p.lowered.procedures.take.caller[0].preRead.sql = "x".repeat(8_000_001); return p; });
  expect((await verifyPlan(oversized, { dialect: d1Dialect })).some((d) => d.message.includes("characters of lowered SQL"))).toBe(true);
});

it("legacy lowered plans without auxiliaries fall back, and Store writes still bypass the seeds", async () => {
  const legacy = await reseal(lowered, (p) => {
    for (const modes of Object.values(p.lowered.procedures)) for (const statements of Object.values(modes)) for (const s of statements) { delete s.preRead; delete s.one; }
    return p;
  });
  const b = await boot(legacy);
  const id = idOf(await call(b, "add-item", { name: "legacy", stock: 5 }));
  reset(b);
  await call(b, "take", { id, qty: 1 });
  expect(counts(b).policy).toBeGreaterThan(0);
  expect(counts(b).print).toBeGreaterThan(0);
  reset(b);
  await b.runtime.store.as(user("owner")).write([{ update: "items", where: { id }, set: { stock: 3 } }]);
  expect(counts(b).check).toBeGreaterThan(0);
  expect(counts(b).policy).toBeGreaterThan(0);
});

it("position and visibility probes bypass lifecycle seeds, including locked writes", async () => {
  const b = await boot(lowered);
  const id = idOf(await call(b, "add-item", { name: "probe", stock: 10 }));
  const proc = lowered.procedures.take;
  const lifecycle = { ...lifecycleHookSets(lowered), dispatcher: { before: async () => {}, after: async () => {} } };
  for (const probe of [{ seen: new Set() }, { unsafeNoVisibility: true }]) {
    reset(b);
    await runProcedure({ ...probe, executor: b.executor, dialect: b.dialect, schemas: lowered.schemas, mode: "caller", lifecycle },
      { kind: "procedure", inputs: proc.inputs, ir: proc.handler.sql.stmts },
      { caller: user("owner"), cause: { kind: "http", id: "probe" }, bind: { uid: "owner", now: 1_800_000_000_000_000, input: { id, qty: 1 } } });
    expect(counts(b).check).toBeGreaterThan(0);
    expect(counts(b).policy).toBeGreaterThan(0);
    expect(counts(b).print).toBeGreaterThan(0);
  }
});

it("an operational before hook adds no implicit pin", async () => {
  const operational = (await withLowering(await compile(undefined, text.replace("lifecycle: publishing", "lifecycle: operational")), d1Dialect)).plan;
  expect(operational.lowered.procedures.take.caller[0].preRead).toBeDefined();
  expect(operational.lowered.procedures.take.caller[0].one).toBeUndefined();
  const b = await boot(operational);
  const id = idOf(await call(b, "add-item", { name: "unlocked", stock: 10 }));
  b.change();
  await call(b, "take", { id, qty: 1 });
  expect((await b.db.all("SELECT stock, version FROM items WHERE id = ?", id))[0]).toEqual({ stock: 16, version: 3 });
});

it("an empty insert's before hook remains an empty entry, with no preRead SQL", async () => {
  const empty = await reseal(plain, (p) => {
    const stmt = p.procedures["add-item"].handler.sql.stmts[0].InsertStmt;
    stmt.cols = []; stmt.selectStmt.SelectStmt.valuesLists[0].List.items = [];
    return p;
  });
  const p = (await withLowering(empty, d1Dialect)).plan;
  expect(p.lowered.procedures["add-item"].caller[0].preRead).toBeNull();
  expect(await verifyPlan(p, { dialect: d1Dialect })).toEqual([]);
  const b = await boot(p);
  reset(b);
  await call(b, "add-item", { name: "unused", stock: 10 });
  expect(b.events[0]).toEqual({ hook: "before_create", rows: [{}] });
  expect(counts(b)).toEqual({ check: 0, policy: 0, print: 0 });
});
