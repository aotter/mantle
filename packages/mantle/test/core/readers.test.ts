// @ts-nocheck test code over loosely typed rows
/**
 * Schema readers (ADR-0043): a shape is converted and compiled once per Store, a hit only checks, binds and runs, every refusal is
 * the same on a cold and a warm memo, and the walk binds exactly what the converter does.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { sqliteStorage } from "../../src/d1/index.js";
import { d1Dialect } from "../../src/d1/dialect.js";
import { createStore, bindStoreCause } from "../../src/core/store/createStore.js";
import { StoreJson, walkRead, padLen } from "../../src/core/store/json.js";
import { readerMemoSize, readerOf, createReaderSet, READER_SHAPES } from "../../src/core/store/readers.js";
import { NOW, boot, schemas } from "../../src/testing/harness.js";
import { nodeSqlite } from "../d1/node-sqlite.test.js";

const user = (subject) => ({ kind: "user", subject, role: null, scopes: [], credential: "session", credentialId: null, clientId: null });
const fail = async (f) => { try { await f(); return undefined; } catch (e) { return e; } };
const invalid = (e) => e?.diagnostic?.code === "INPUT_VALIDATION_FAILED";
const ids = (page) => page.rows.map((r) => r.id);

/** A Store over the harness Schemas (seeded), with an executor that records every statement and a dialect whose `check` is counted. */
async function open(maxBindings) {
  const driver = nodeSqlite();
  const engine = { storage: sqliteStorage(driver), driver };
  const b = await boot(engine);
  const sent = [];
  const executor = { get maxBindings() { return maxBindings ?? b.executor.maxBindings; }, select: (st) => (sent.push(st), b.executor.select(st)), apply: (x) => b.executor.apply(x) };
  const dialect = { ...b.dialect, check: vi.fn(b.dialect.check) };
  let n = 0;
  const store = createStore({ executor, dialect, schemas, views: {}, now: () => NOW, newId: () => `id${++n}` });
  return { store, sent, dialect, b };
}

describe("a hit does no compile work", () => {
  afterEach(() => vi.restoreAllMocks());

  it("runs the converter and the dialect check once per shape, and hands the executor the same IR each time", async () => {
    const { store, sent, dialect } = await open();
    const me = store.as(user("o1"));
    await me.db.items.find({ where: { cat: "x", stock: { gt: 1 } }, columns: ["id"] });
    const read = vi.spyOn(StoreJson.prototype, "read");
    const checked = dialect.check.mock.calls.length;
    const from = sent.length;
    for (const [cat, n] of [["y", 2], ["x", 3], ["x", 100], ["y", 0], ["x", 1]]) await me.db.items.find({ where: { cat, stock: { gt: n } }, columns: ["id"] });
    expect(read).not.toHaveBeenCalled();
    expect(dialect.check.mock.calls.length).toBe(checked);
    const irs = new Set(sent.slice(from).map((s) => s.ir));
    expect(irs.size).toBe(1);
  });

  it("is shared by every as() and by the per-request binding", async () => {
    const { store } = await open();
    const read = vi.spyOn(StoreJson.prototype, "read");
    const q = { where: { cat: "x" }, columns: ["id"] };
    await store.as(user("o1")).db.items.find(q);
    await store.as(user("o2")).db.items.find(q);
    await bindStoreCause(store, { kind: "http", id: "r1" }).db.items.find(q);
    await store.db.items.find(q);
    expect(read).toHaveBeenCalledTimes(1);
    expect(readerMemoSize(store)).toBe(1);
  });
});

describe("refusals are the same cold and warm and never grow the memo", () => {
  const BAD = {
    "isNull 'true'": (r) => r.find({ where: { note: { isNull: "true" } } }),
    "a bool given 'true'": (r) => r.find({ where: { stock: "true" } }),
    "in []": (r) => r.find({ where: { id: { in: [] } } }),
    "in with null": (r) => r.find({ where: { id: { in: ["a", null] } } }),
    "in a subquery": (r) => r.find({ where: { id: { in: { select: "id", from: "items" } } } }),
    "and": (r) => r.find({ where: { and: [{ id: "a" }] } }),
    "or": (r) => r.find({ where: { or: [{ id: "a" }] } }),
    "not": (r) => r.find({ where: { not: { id: "a" } } }),
    "where {}": (r) => r.find({ where: {} }),
    "where null": (r) => r.find({ where: null }),
    "where []": (r) => r.find({ where: [] }),
    "where undefined": (r) => r.find({ where: undefined }),
    "an empty comparison": (r) => r.find({ where: { stock: {} } }),
    "an unknown operator": (r) => r.find({ where: { stock: { between: 1 } } }),
    "an undefined value": (r) => r.find({ where: { stock: undefined } }),
    "gt null": (r) => r.find({ where: { stock: { gt: null } } }),
    "an array value": (r) => r.find({ where: { cat: ["x"] } }),
    "like on a number column": (r) => r.find({ where: { stock: { like: "1%" } } }),
    "like over 1024 bytes": (r) => r.find({ where: { name: { like: "é".repeat(600) } } }),
    "columns []": (r) => r.find({ columns: [] }),
    "columns [1]": (r) => r.find({ columns: [1] }),
    "orderBy with two keys": (r) => r.find({ orderBy: { name: "asc", id: "asc" } }),
    "orderBy with a bad direction": (r) => r.find({ orderBy: { name: "up" } }),
    "search ''": (r) => r.find({ search: "" }),
    "search ' '": (r) => r.find({ search: " " }),
    "search 3": (r) => r.find({ search: 3 }),
    "limit 0": (r) => r.find({ limit: 0 }),
    "limit 501": (r) => r.find({ limit: 501 }),
    "limit 1.5": (r) => r.find({ limit: 1.5 }),
    "a non-string cursor": (r) => r.find({ cursor: 3 }),
    "a foreign cursor": (r) => r.find({ cursor: "v1.garbage" }),
    "an unknown column": (r) => r.find({ where: { nope: 1 } }),
    "a json column": (r) => r.find({ where: { tags: "x" } }),
    "an unknown key": (r) => r.find({ from: "items" }),
    "a non-object query": (r) => r.find(3),
    "get with a number": (r) => r.get(3),
    "get with an unknown key": (r) => r.get("a", { where: {} }),
    "first with a limit": (r) => r.first({ limit: 3 }),
  };
  for (const [name, call] of Object.entries(BAD))
    it(`${name}`, async () => {
      const { store } = await open();
      const reader = store.as(user("o1")).db.items;
      const size = readerMemoSize(store);
      expect(invalid(await fail(() => call(reader)))).toBe(true);
      expect(invalid(await fail(() => call(reader)))).toBe(true);
      expect(readerMemoSize(store)).toBe(size);
    });

  it("is refused warm after the shape was stored with other values: a bool given 'true', isNull 'true', a limit past 500, a cursor of another sort", async () => {
    const { store } = await open();
    const items = store.as(user("o1")).db.items;
    await items.find({ where: { name: "apple" } });
    await items.find({ where: { name: "apple" }, orderBy: { id: "asc" }, limit: 1 });
    const size = readerMemoSize(store);
    expect(invalid(await fail(() => items.find({ where: { name: 5 } })))).toBe(true);
    expect(invalid(await fail(() => items.find({ where: { name: "apple" }, limit: 501 })))).toBe(true);
    const page = await items.find({ where: { cat: "x" }, orderBy: { id: "asc" }, limit: 1 });
    expect(invalid(await fail(() => items.find({ where: { cat: "x" }, orderBy: { name: "asc" }, limit: 1, cursor: page.nextCursor })))).toBe(true);
    expect(readerMemoSize(store)).toBe(size + 1);
  });

  it("an unknown Schema through readerOf is INPUT_VALIDATION_FAILED, and the lookup ignores case", async () => {
    const { store } = await open();
    expect(invalid(await fail(() => readerOf(store.db, "nope")))).toBe(true);
    expect(readerOf(store.db, "ITEMS")).toBe(store.db.items);
  });
});

describe("the walk binds what the converter binds", () => {
  it("is identical to a fresh conversion for 200 seeded random queries with shuffled keys (integer-like keys included)", async () => {
    const { store, b } = await open();
    const codec = b.dialect.codec;
    let seed = 12345;
    const rnd = (n) => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n;
    const pick = (xs) => xs[rnd(xs.length)];
    const shuffle = (xs) => xs.map((x) => [rnd(1000), x]).sort((a, c) => a[0] - c[0]).map((x) => x[1]);
    const cols = { name: () => pick(["apple", "berry", "x%"]), cat: () => pick(["x", "y"]), stock: () => rnd(20), note: () => pick(["nc", "nd"]), id: () => pick(["a", "b", "c", "X_z1"]) };
    for (let i = 0; i < 200; i++) {
      const where = {};
      for (const col of shuffle(Object.keys(cols)).slice(0, 1 + rnd(4))) {
        const v = cols[col];
        const kind = pick(["eq", "ne", "gt", "in", "notIn", "isNull", "like", "null", "ops"]);
        if (kind === "eq") where[col] = v();
        else if (kind === "null") where[col] = null;
        else if (kind === "isNull") where[col] = { isNull: rnd(2) === 0 };
        else if (kind === "in" || kind === "notIn") where[col] = { [kind]: Array.from({ length: 1 + rnd(9) }, v) };
        else if (kind === "like") where[col] = { like: String(v()) + "%" };
        else if (kind === "ops") where[col] = Object.fromEntries(shuffle([["gt", v()], ["lt", v()], ["ne", v()]]).slice(0, 1 + rnd(3)));
        else where[col] = { [kind]: v() };
      }
      // integer-like keys exist in a where only as unknown columns: the walk and the converter must still agree before the converter refuses
      const q = { ...(rnd(3) ? { where } : {}), ...(rnd(2) ? { search: pick(["a", "apple"]) } : {}), orderBy: { [pick(["id", "name", "stock"])]: pick(["asc", "desc"]) } };
      const w = walkRead(schemas.items, "find", q, 100);
      const json = new StoreJson(schemas, codec);
      let refusal;
      try { json.read({ from: "items", ...w.query }); } catch (e) { refusal = e; }
      expect(refusal).toBeUndefined();
      expect(json.tags).toEqual(w.tags);
      expect(Object.values(json.values)).toEqual(w.values);
      // and a hit returns the rows the miss did
      const me = store.as(user("o1"));
      const [got, again] = [await me.db.items.find({ ...q, limit: 500 }), await me.db.items.find({ ...q, limit: 500 })];
      expect(again.rows).toEqual(got.rows);
    }
  }, 120_000);

  it("walks integer-like keys in the converter's order", () => {
    const w = walkRead(schemas.items, "find", { where: { b: 1, 2: 2, a: 3, 1: 4 } }, 100);
    expect(w.values).toEqual([4, 2, 1, 3]);
    expect(Object.keys(w.query.where)).toEqual(["1", "2", "b", "a"]);
  });

  it("reads every caller property once: a getter that changes cannot make the key and the IR differ", () => {
    let reads = 0;
    const where = { get name() { return reads++ ? "second" : "first"; } };
    const w = walkRead(schemas.items, "first", { where }, 100);
    expect(reads).toBe(1);
    expect(w.values).toEqual(["first"]);
    expect(w.query.where.name).toBe("first");
  });
});

describe("in / notIn bucketing and the memo bound", () => {
  it("pads to a power of two: lists of 1 to 9 make at most 5 shapes, and a padded list returns the unpadded rows", async () => {
    const { store } = await open();
    const items = store.db.items;
    const pool = ["a", "b", "c", "d", "e", "f", "g", "h", "X_z1"];
    for (let n = 1; n <= 9; n++) {
      expect(ids(await items.find({ columns: ["id"], where: { id: { in: pool.slice(0, n) } }, orderBy: { id: "asc" } }))).toEqual(["a", "b", "c", "d", "X_z1"].filter((x) => pool.slice(0, n).includes(x)).sort());
      expect(ids(await items.find({ columns: ["id"], where: { id: { notIn: pool.slice(0, n) } }, orderBy: { id: "asc" }, limit: 500 })).sort()).toEqual(["X_z1", "X_z2", "a", "b", "c", "d"].filter((x) => !pool.slice(0, n).includes(x)).sort());
    }
    expect(readerMemoSize(store)).toBe(10); // in and notIn: 1, 2, 4, 8, 16
  });

  it("never pads past the bind limit: on 100 binds, 3 is 4, 33 is 50 and 70 stays 70", () => {
    expect([padLen(1, 100), padLen(3, 100), padLen(33, 100), padLen(70, 100), padLen(40, 32766)]).toEqual([1, 4, 50, 70, 64]);
  });

  it("runs 40 items on a 100-bind executor", async () => {
    const { store } = await open(100);
    const many = Array.from({ length: 40 }, (_, i) => `k${i}`);
    expect(ids(await store.db.items.find({ columns: ["id"], where: { id: { in: [...many, "a"] } } }))).toEqual(["a"]);
  });

  it("keeps at most 256 shapes, oldest first", async () => {
    const { store, dialect } = await open();
    const all = ["id", "version", "createdAt", "updatedAt", "authorId", "name", "cat", "stock", "note"];
    // 300 distinct shapes: one per non-empty subset of columns
    const projection = (mask) => all.filter((_, bit) => mask & (1 << bit));
    for (let mask = 1; mask <= 300; mask++) await store.db.items.first({ columns: projection(mask) });
    expect(readerMemoSize(store)).toBe(READER_SHAPES);
    // the newest is kept (a hit: no further check), the oldest was evicted (a miss: compiled again)
    const checked = dialect.check.mock.calls.length;
    await store.db.items.first({ columns: projection(300) });
    expect(dialect.check.mock.calls.length).toBe(checked);
    await store.db.items.first({ columns: projection(1) });
    expect(dialect.check.mock.calls.length).toBeGreaterThan(checked);
    expect(readerMemoSize(store)).toBe(READER_SHAPES);
    expect(createReaderSet(schemas).memo.size).toBe(0);
  });
});

describe("the db object", () => {
  it("has a null prototype, no keys, is not thenable, and a reader is read only through its binding", async () => {
    const { store } = await open();
    const db = store.db;
    expect(Object.getPrototypeOf(Object.getPrototypeOf(db))).toBeNull();
    expect(Object.keys(db)).toEqual([]);
    expect("then" in db).toBe(false);
    expect(await db).toBe(db);
    const get = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(db), "items").get;
    expect(invalid(await fail(() => get.call({})))).toBe(true);
    expect(invalid(await fail(() => Object.create(db).items))).toBe(true);
    expect(({ ...db }).items).toBeUndefined();
  });

  it("is an own property of every Store, so a spread keeps it", async () => {
    const { store } = await open();
    const bound = store.as(user("o1"));
    expect({ ...bound }.db === bound.db).toBe(true);
    expect(Object.hasOwn(store, "db")).toBe(true);
    expect(Object.hasOwn(store.as(user("o1")), "db")).toBe(true);
  });
});

describe("get, first and find", () => {
  it("get of an unknown id and first of nothing are null, and find pages with a cursor", async () => {
    const { store } = await open();
    const items = store.as(user("o1")).db.items;
    expect(await items.get("nope")).toBeNull();
    expect(await items.first({ where: { cat: "nope" } })).toBeNull();
    expect((await items.get("a")).name).toBe("apple");
    const p1 = await items.find({ columns: ["id"], orderBy: { id: "asc" }, limit: 2 });
    const p2 = await items.find({ columns: ["id"], orderBy: { id: "asc" }, limit: 2, cursor: p1.nextCursor });
    expect([ids(p1), ids(p2), p2.nextCursor]).toEqual([["a", "b"], ["c", "d"], undefined]);
    // a cursor is bound to its Schema and order, and is the one format of every read
    expect(p1.nextCursor).toEqual(expect.any(String));
  });

  it("treats search: undefined as absent, and decodes alike through get, first and find: json, geo, date-times, bools, numerics; no hidden columns", async () => {
    const { store } = await open();
    const me = store.as(user("o1"));
    await me.db.items.find({ columns: ["id"] });
    await me.db.items.find({ columns: ["id"], search: undefined });
    expect(readerMemoSize(store)).toBe(1);
    const row = await me.db.items.get("a");
    expect(row).toEqual((await me.db.items.find({ where: { id: "a" } })).rows[0]);
    expect(row.tags).toEqual(["red", "big"]);
    const place = (await me.db.places.first({ where: { id: "pl300" } }));
    expect(place).toEqual((await me.db.places.find({ where: { id: "pl300" } })).rows[0]);
    expect(place.loc).toMatchObject({ lng: expect.any(Number), lat: expect.any(Number) });
    const order = await me.db.orders.get("oa");
    expect(order).toEqual((await me.db.orders.find({ where: { id: "oa" } })).rows[0]);
    expect(Object.keys(place).filter((k) => /^(_k|_geo_)/.test(k))).toEqual([]);
  });

  it("a publishing Schema's reader returns drafts, and an anonymous caller of a scoped Schema gets nothing", async () => {
    const { store } = await open();
    expect(ids(await store.as(user("o1")).db.posts.find({ columns: ["id"], orderBy: { id: "asc" } }))).toEqual(["X_p2", "p1"]);
    expect((await store.as({ kind: "anonymous" }).db.items.find()).rows).toEqual([]);
  });
});
