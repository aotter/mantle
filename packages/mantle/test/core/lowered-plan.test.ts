// @ts-nocheck test code over loosely typed plans and rows
/** ADR-0044 at the plan level: what `withLowering` writes, when a runtime uses it, and what verifyPlan and boot do with a plan that lies. */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { LocalD1 } from "../../src/cloudflare/testing/d1.js";
import { DiagnosticError, createMantleRuntime, verifyPlan } from "../../src/core/index.js";
import { loweringStatus, withLowering } from "../../src/core/sql/lowered.js";
import { MANTLE_VERSION } from "../../src/core/version.js";
import { d1Dialect } from "../../src/d1/dialect.js";
import { sqliteStorage } from "../../src/d1/index.js";
import { postgresDialect } from "../../src/postgres/dialect.js";
import { PgStoreExecutor } from "../../src/postgres/executor.js";
import * as pgCompile from "../../src/postgres/compile/index.js";
import { anonymous, compile, deterministic, handlers, reseal, user } from "./lowered-fixture.js";

let plan, lowered, pgPlan;
const dbs: LocalD1[] = [];
const db = async () => { const d = await LocalD1.create(); dbs.push(d); return d; };
beforeAll(async () => {
  plan = await compile();
  ({ plan: lowered } = await withLowering(plan, d1Dialect));
  pgPlan = (await withLowering(await compile(pgCompile), postgresDialect())).plan;
}, 60_000);
afterAll(() => Promise.all(dbs.map((d) => d.dispose())));

const failure = async (p: Promise<unknown>) => (await p.then(() => undefined, (e) => e)) as DiagnosticError | undefined;
const boot = async (p, storage?) => createMantleRuntime({ plan: p, handlers, storage: storage ?? sqliteStorage(await db()), schedules: true, ...deterministic() });
/** The storage with its dialect's check counted. */
const counted = async (options = {}) => {
  const storage = sqliteStorage(await db(), options);
  const check = vi.fn(storage.dialect.check);
  return { storage: { ...storage, dialect: { ...storage.dialect, check } }, check };
};
const withWarn = async <T>(f: () => Promise<T>) => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  try { return { result: await f(), warnings: warn.mock.calls.map((c) => String(c[0])) }; } finally { warn.mockRestore(); }
};

describe("withLowering", () => {
  it("is deterministic, covered by the fingerprint, survives JSON, and keeps the plan's key order", async () => {
    const again = (await withLowering(plan, d1Dialect)).plan;
    expect(again).toEqual(lowered);
    expect(again.fingerprint).toBe(lowered.fingerprint);
    expect(lowered.fingerprint).not.toBe(plan.fingerprint);
    expect(JSON.parse(JSON.stringify(lowered))).toEqual(lowered);
    expect(Object.keys(lowered)).toEqual([...Object.keys(plan), "lowered"]);
    // lowering again, from a lowered plan, changes nothing
    expect((await withLowering(lowered, d1Dialect)).plan).toEqual(lowered);
  });

  it("holds every View and inline Procedure, by mode, with the default paged shapes and no ASTs", async () => {
    const l = lowered.lowered;
    expect(l).toMatchObject({ mantle: MANTLE_VERSION, dialect: { name: "@aotter/mantle/d1", key: "" } });
    expect(Object.keys(l.views)).toEqual(["shelf", "low-stock", "everything"]);
    expect(Object.keys(l.views.shelf)).toEqual(["public"]);
    expect(Object.keys(l.views["low-stock"])).toEqual(["caller", "trusted"]);
    expect(Object.keys(l.procedures)).toEqual(["add-item", "take"]);
    expect(Object.keys(l.procedures["add-item"])).toEqual(["caller", "trusted"]);
    // the key's count and an all-non-null cursor, and the page size is a bind
    const shelf = l.views.shelf.public;
    expect(Object.keys(shelf.paged)).toHaveLength(2);
    expect(Object.values(shelf.paged).every((p) => p.sources.at(-1)?.limit === true && /LIMIT \?\d+$/.test(p.sql))).toBe(true);
    expect(Object.keys(l.views.everything.caller.paged)).toHaveLength(1); // no ORDER BY: no cursor shape
    expect(JSON.stringify(l)).not.toContain("SelectStmt");
    // the hook set reaches the insert's statement
    expect(l.procedures["add-item"].caller[0]).toMatchObject({ hooked: true, returns: true, verb: "insert", target: "items" });
    expect(l.procedures.take.caller[0]).toMatchObject({ verb: "update", target: "items" });
    expect(l.procedures.take.caller[0].hooked).toBeUndefined();
  });

  it("leaves a dialect without a printer, and a restricted one, with the plan it was given", async () => {
    const { print: _p, ...bare } = d1Dialect;
    expect((await withLowering(plan, bare)).plan).toBe(plan);
    expect((await withLowering(plan, sqliteStorage({} as never, { restrict: () => [] }).dialect)).plan).toBe(plan);
  });

  it("names a program the runtime would refuse, and leaves it out", async () => {
    const text = (await import("./lowered-fixture.js")).MANIFESTS;
    const refused = await compile(undefined, text);
    const body = structuredClone(refused);
    // a View whose IR the dialect refuses once it is tampered with: lowering skips it, as a run would refuse it
    body.views.shelf.stmts[0].SelectStmt.targetList.push({ ResTarget: { val: { FuncCall: { funcname: [{ String: { sval: "no_such_function" } }], args: [] } } } });
    const { plan: out, warnings } = await withLowering(body, d1Dialect);
    expect(warnings.join("\n")).toMatch(/plan#\/views\/shelf \(public\)/);
    expect(out.lowered.views.shelf).toBeUndefined();
    expect(out.lowered.views["low-stock"]).toBeDefined();
  });
});

describe("boot", () => {
  it("a plan without lowered statements (every existing plan) boots, reports absent and runs through the cache path", async () => {
    const { storage, check } = await counted();
    const { result: rt, warnings } = await withWarn(() => boot(plan, storage));
    expect(rt.bootReport().lowered).toBe("absent");
    expect(warnings).toEqual([]);
    await rt.store.as(anonymous).view("shelf");
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("another Mantle version lowered it: boots, warns once, reports why, and checks on first use", async () => {
    const stale = await reseal(lowered, (p) => ({ ...p, lowered: { ...p.lowered, mantle: "9.9.9" } }));
    const { storage, check } = await counted();
    const { result: rt, warnings } = await withWarn(() => boot(stale, storage));
    expect(rt.bootReport().lowered).toBe("mantle-version");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/mantle-version.*mantle generate/s);
    expect(await rt.store.as(anonymous).view("shelf")).toMatchObject({ rows: [] });
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("a restricted dialect never uses lowered statements: restrict runs on first use, and nothing is warned", async () => {
    const restrict = vi.fn(() => []);
    const { storage } = await counted({ restrict });
    const { result: rt, warnings } = await withWarn(() => boot(lowered, storage));
    expect(rt.bootReport().lowered).toBe("restricted");
    expect(warnings).toEqual([]);
    await rt.store.as(anonymous).view("shelf");
    expect(restrict).toHaveBeenCalledTimes(1);
    // and a refusal of its own still refuses
    const refuse = await counted({ restrict: () => [{ code: "SQL_FUNCTION", path: "x", message: "no", severity: "error" }] });
    const { result: refusing } = await withWarn(() => boot(lowered, refuse.storage));
    expect((await failure(refusing.store.as(anonymous).view("shelf")))?.diagnostic.message).toMatch(/no/);
  });

  it("another dialect, or a PostgreSQL time zone the plan was not lowered for, is 'dialect'", async () => {
    expect(loweringStatus(pgPlan, postgresDialect())).toBe("used");
    expect(loweringStatus(pgPlan, postgresDialect("Asia/Taipei"))).toBe("dialect");
    expect(pgPlan.lowered.dialect.key).toBe("UTC");
    // the dialect stub of verifyPlan: boot needs only {dialect, prepare}, and no database
    const rec = { query: async () => ({ rows: [], rowCount: 0, fields: [] }), end: async () => undefined };
    const storage = (dialect) => ({ dialect, prepare: async (p) => ({ executor: new PgStoreExecutor(async () => rec as never, p.schemas, new Map()) }) });
    const { result: rt, warnings } = await withWarn(() => createMantleRuntime({ plan: pgPlan, handlers, storage: storage(postgresDialect("Asia/Taipei")), schedules: true }));
    expect(rt.bootReport().lowered).toBe("dialect");
    expect(warnings).toHaveLength(1);
    expect((await createMantleRuntime({ plan: pgPlan, handlers, storage: storage(postgresDialect()), schedules: true })).bootReport().lowered).toBe("used");
    // a plan lowered for SQLite is not used by PostgreSQL either: the dialect name differs, and boot refuses it before that
    expect(loweringStatus(lowered, postgresDialect())).toBe("dialect");
  });

  it("refuses a lowered statement edited without a new fingerprint", async () => {
    const edited = structuredClone(lowered);
    edited.lowered.views.shelf.public.sql = "SELECT id FROM items";
    expect((await failure(boot(edited)))?.diagnostic.code).toBe("PLAN_FINGERPRINT_MISMATCH");
  });

  it("a malformed lowered section with a good fingerprint is not seeded, warns, and every call still works", async () => {
    for (const bad of [
      (l) => { l.views.shelf.public.binds = "x"; },
      (l) => { l.views.ghost = { caller: l.views.shelf.public }; },
      (l) => { l.procedures["add-item"].caller.pop(); },
      (l) => { l.views.shelf.public.paged = { "[\"vvvvv=\",null,[]]": l.views.shelf.public.paged[Object.keys(l.views.shelf.public.paged)[0]] }; },
    ]) {
      const broken = await reseal(lowered, (p) => (bad(p.lowered), p));
      const { storage, check } = await counted();
      const { result: rt, warnings } = await withWarn(() => boot(broken, storage));
      expect(rt.bootReport().lowered).toBe("used"); // the status is the plan's; seeding failed softly
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/lowered statements not used/);
      await rt.invokeProcedure({ procedure: "add-item", input: { name: "pear", stock: 3 }, caller: user("o1"), cause: { kind: "http", id: "t" } });
      expect((await rt.store.as(anonymous).view("shelf")).rows).toEqual([]);
      expect((await rt.store.as(user("o1")).view("low-stock")).rows).toMatchObject([{ name: "pear", stock: 3 }]);
      expect(check).toHaveBeenCalled();
    }
  });

  it("a unique violation through a lowered inline Procedure is still a CONFLICT naming its operation", async () => {
    const { storage } = await counted();
    const rt = await boot(lowered, storage);
    const add = (name) => rt.invokeProcedure({ procedure: "add-item", input: { name, stock: 1 }, caller: user("o1"), cause: { kind: "http", id: "t" } });
    await add("apple");
    const e = await failure(add("apple"));
    expect(e?.diagnostic).toMatchObject({ code: "CONFLICT", conflict: { reason: "unique", opIndex: 0 } });
  });
});

describe("the page size is a bind", () => {
  for (const [name, p] of [["lowered", () => lowered], ["compiled at run time", () => plan]] as const) {
    it(`${name}: any limit pages the same rows on SQLite, with a cursor from the statement of another limit`, async () => {
      const rt = await boot(p());
      for (const n of ["a", "b", "c", "d", "e"]) await rt.invokeProcedure({ procedure: "add-item", input: { name: n, stock: 1 }, caller: user("o1"), cause: { kind: "http", id: n } });
      const names = (r) => r.rows.map((x) => x.name);
      const view = rt.store.as(user("o1"));
      for (const limit of [1, 2, 3, 5, 6, 500]) {
        const seen = [];
        let cursor;
        for (let guard = 0; guard < 10; guard++) {
          const page = await view.view("shelf", { limit, cursor });
          seen.push(...names(page));
          if (!page.nextCursor) break;
          cursor = page.nextCursor;
        }
        expect(seen, `limit ${limit}`).toEqual(["a", "b", "c", "d", "e"]);
      }
      // a cursor minted at one size continues at another
      const first = await view.view("shelf", { limit: 2 });
      expect(names(await view.view("shelf", { limit: 3, cursor: first.nextCursor }))).toEqual(["c", "d", "e"]);
      // a View with no ORDER BY is one page, and refused past it
      expect((await rt.store.as(user("o1")).view("everything", { limit: 5 })).rows).toHaveLength(5);
      expect((await failure(rt.store.as(user("o1")).view("everything", { limit: 4 })))?.diagnostic.message).toMatch(/more than 4 rows/);
    });
  }
});

describe("verifyPlan", () => {
  it("accepts the plan generate wrote, and refuses lowered text edited by someone who re-sealed the plan", async () => {
    expect(await verifyPlan(lowered, sqliteStorage({} as never))).toEqual([]);
    expect(await verifyPlan(pgPlan, { dialect: postgresDialect() })).toEqual([]);
    const tampered = await reseal(lowered, (p) => { p.lowered.views["low-stock"].caller.sql = p.lowered.views["low-stock"].caller.sql.replace("ORDER BY", "ORDER BY 1 -- "); return p; });
    const found = await verifyPlan(tampered, sqliteStorage({} as never));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ path: "plan#/lowered", message: expect.stringMatching(/^LOWERING_MISMATCH:/) });
    // another bind recipe, or a statement dropped, is the same lie
    for (const change of [(l) => { l.views.shelf.public.binds = []; }, (l) => { delete l.views.shelf; }, (l) => { l.mantle = MANTLE_VERSION; l.procedures["add-item"].caller[0].verb = "delete"; }]) {
      const lie = await reseal(lowered, (p) => (change(p.lowered), p));
      expect((await verifyPlan(lie, sqliteStorage({} as never))).map((d) => d.path), JSON.stringify(change.toString())).toEqual(["plan#/lowered"]);
    }
  });

  it("compares only what this Mantle and dialect would run: a restricted dialect, another version or another dialect is not compared", async () => {
    const tampered = await reseal(lowered, (p) => { p.lowered.views["low-stock"].caller.sql = "SELECT 1"; return p; });
    expect(await verifyPlan(tampered, sqliteStorage({} as never, { restrict: () => [] }))).toEqual([]);
    const other = await reseal(tampered, (p) => ({ ...p, lowered: { ...p.lowered, mantle: "9.9.9" } }));
    expect(await verifyPlan(other, sqliteStorage({} as never))).toEqual([]);
  });

  it("bounds a lowered section before it reads it: unknown programs, and no object", async () => {
    const unknown = await reseal(lowered, (p) => { p.lowered.views.ghost = p.lowered.views.shelf; p.lowered.procedures.ghost = p.lowered.procedures.take; return p; });
    expect((await verifyPlan(unknown, sqliteStorage({} as never))).map((d) => d.path).sort()).toEqual(["plan#/lowered/procedures/ghost", "plan#/lowered/views/ghost"]);
    for (const nonsense of [null, 7, [], { views: [], procedures: {} }]) {
      const bad = await reseal(lowered, (p) => ({ ...p, lowered: nonsense }));
      expect((await verifyPlan(bad, sqliteStorage({} as never))).map((d) => d.path)).toEqual(["plan#/lowered"]);
    }
  });
});
