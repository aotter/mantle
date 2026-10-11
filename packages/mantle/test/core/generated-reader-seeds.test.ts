// @ts-nocheck differential reader behavior on the official SQLite executor
import { afterEach, describe, expect, it, vi } from "vitest";
import { sqliteStorage } from "../../src/d1/index.js";
import { createStore } from "../../src/core/store/createStore.js";
import { lowerReaderSeeds } from "../../src/core/store/readerSeeds.js";
import { StoreJson } from "../../src/core/store/json.js";
import { encodeCursor } from "../../src/core/store/cursor.js";
import { readerMemoSize } from "../../src/core/store/readers.js";
import { NOW, boot, schemas } from "../../src/testing/harness.js";
import { nodeSqlite } from "../d1/node-sqlite.test.js";

const user = subject => ({ kind: "user", subject, role: null, scopes: [], credential: "session", credentialId: null, clientId: null });
async function open() {
  const driver = nodeSqlite();
  const b = await boot({ storage: sqliteStorage(driver), driver });
  const dialect = { ...b.dialect, check: vi.fn(b.dialect.check), print: vi.fn(b.dialect.print) };
  const readerSeeds = lowerReaderSeeds(schemas, dialect);
  let fail = false;
  const executor = { maxBindings: b.executor.maxBindings, apply: x => b.executor.apply(x), select: s => { if (fail) throw Error("driver failed"); return b.executor.select(s); } };
  const deps = { executor, dialect, schemas, views: {}, now: () => NOW, newId: () => "read" };
  return { seeded: createStore({ ...deps, readerSeeds }), ordinary: createStore(deps), dialect, readerSeeds, failure: value => { fail = value; } };
}

describe("generated bounded reader seeds", () => {
  afterEach(() => vi.restoreAllMocks());
  it("has three finite shapes per schema; first/find share their canonical artifact", async () => {
    const { readerSeeds } = await open();
    expect(Object.keys(readerSeeds)).toHaveLength(Object.keys(schemas).length * 3);
    for (const key of Object.keys(schemas)) {
      const entries = Object.entries(readerSeeds).filter(([name]) => name.startsWith(`${key}\0`));
      expect(entries[1][1]).toBe(entries[2][1]);
    }
  });
  it("first use skips conversion/check/print, retains policy, and binds the current id", async () => {
    const { seeded, ordinary, dialect } = await open();
    const expected = await ordinary.as(user("o1")).db.items.find({ limit: 1 });
    const read = vi.spyOn(StoreJson.prototype, "read");
    dialect.check.mockClear(); dialect.print.mockClear();
    expect(await seeded.as(user("o1")).db.items.find({ limit: 1 })).toEqual(expected);
    expect(read).not.toHaveBeenCalled(); expect(dialect.check).not.toHaveBeenCalled(); expect(dialect.print).not.toHaveBeenCalled();
    if (expected.rows.length) {
      const id = expected.rows[0].id;
      const a = await seeded.as(user("o1")).db.items.get(id);
      read.mockClear(); dialect.check.mockClear(); dialect.print.mockClear();
      expect(await seeded.as(user("o1")).db.items.get("absent")).toBeNull();
      expect(read).not.toHaveBeenCalled(); expect(dialect.check).not.toHaveBeenCalled(); expect(dialect.print).not.toHaveBeenCalled();
      expect(a).toEqual(expected.rows[0]);
    }
    expect(await seeded.as(user("o2")).db.items.find()).toEqual(await ordinary.as(user("o2")).db.items.find());
    expect(await seeded.db.items.first()).toEqual(await ordinary.db.items.first());
  });
  it("failed requests never adopt a shape and the retry remains cold-generated", async () => {
    const { seeded, dialect, failure } = await open();
    const read = vi.spyOn(StoreJson.prototype, "read");
    dialect.check.mockClear(); dialect.print.mockClear();
    failure(true);
    await expect(seeded.db.items.first()).rejects.toThrow("driver failed");
    expect(readerMemoSize(seeded)).toBe(0);
    failure(false); await seeded.db.items.first();
    expect(readerMemoSize(seeded)).toBe(1);
    expect(read).not.toHaveBeenCalled(); expect(dialect.check).not.toHaveBeenCalled(); expect(dialect.print).not.toHaveBeenCalled();
  });
  it("a null-key page uses the canonical lazy AST and retains complete response parity", async () => {
    const { seeded, ordinary } = await open();
    const cursor = encodeCursor("items:updated_at:desc", [null, "a"]);
    const expected = await ordinary.db.items.find({ cursor, limit: 2 });
    const read = vi.spyOn(StoreJson.prototype, "read");
    expect(await seeded.db.items.find({ cursor, limit: 2 })).toEqual(expected);
    expect(read).toHaveBeenCalledTimes(1);
    await seeded.db.items.find({ cursor, limit: 2 });
    expect(read).toHaveBeenCalledTimes(1);
  });
  it("generated shapes share the same 256-entry FIFO and are seeded again after eviction", async () => {
    const { seeded, dialect } = await open();
    await seeded.db.items.first();
    const all = ["id", "version", "createdAt", "updatedAt", "authorId", "name", "cat", "stock", "note"];
    for (let mask = 1; mask <= 256; mask++) await seeded.db.items.first({ columns: all.filter((_, bit) => mask & (1 << bit)) });
    expect(readerMemoSize(seeded)).toBe(256);
    const read = vi.spyOn(StoreJson.prototype, "read");
    dialect.check.mockClear(); dialect.print.mockClear();
    await seeded.db.items.first();
    expect(readerMemoSize(seeded)).toBe(256);
    expect(read).not.toHaveBeenCalled(); expect(dialect.check).not.toHaveBeenCalled(); expect(dialect.print).not.toHaveBeenCalled();
  });
  it("unsupported shapes keep the canonical path; invalid limits/get values do not grow the memo", async () => {
    const { seeded, ordinary } = await open();
    const read = vi.spyOn(StoreJson.prototype, "read");
    expect(await seeded.db.items.find({ columns: ["id"] })).toEqual(await ordinary.db.items.find({ columns: ["id"] }));
    expect(read).toHaveBeenCalledTimes(2);
    const size = readerMemoSize(seeded);
    await expect(seeded.db.items.find({ limit: 501 })).rejects.toMatchObject({ diagnostic: { code: "INPUT_VALIDATION_FAILED" } });
    await expect(seeded.db.items.get(1)).rejects.toMatchObject({ diagnostic: { code: "INPUT_VALIDATION_FAILED" } });
    expect(readerMemoSize(seeded)).toBe(size);
  });
});
