import { expect, test } from "bun:test";
import { encodeDate, encodeTimestamptz, isoDate, isoTimestamptz } from "../src/kernel/scalars.js";

test("ISO inputs refuse what Date.parse would roll over or cannot represent", () => {
  expect(encodeTimestamptz("2026-10-11T08:00:00.000001+08:00")).toBe(Date.parse("2026-10-11T00:00:00Z") * 1000 + 1);
  expect(isoTimestamptz("2026-10-11T08:00:00.000001+08:00")).toBe("2026-10-11T00:00:00.000001Z");
  for (const bad of ["2026-10-11T24:00:00Z", "2026-10-11T00:00:00", "2026-02-30T00:00:00Z"]) expect(() => encodeTimestamptz(bad)).toThrow("not a");
  expect(() => encodeTimestamptz(new Date("garbage"))).toThrow("Invalid Date");
  expect(() => encodeDate("2026-02-30")).toThrow("not a valid date");
});

test("isoDate returns a real calendar day as it was given, and refuses anything else", () => {
  for (const day of ["2026-10-11", "2024-02-29", "0099-01-01", "1969-12-31"]) expect(isoDate(day)).toBe(day);
  for (const bad of ["2026-02-30", "2026-13-01", "2025-02-29", "2026-1-1", "2026-10-11T00:00:00Z", " 2026-10-11", ""]) expect(() => isoDate(bad)).toThrow("not a");
});


test("SQLite rollback failure retains both errors and signals an unknown outcome", async () => {
  const { transaction } = await import("../src/kernel/driver/bun-sqlite.js");
  const original = new Error("write failed"), rollback = new Error("rollback failed"), calls: string[] = [];
  const db = { query: () => { throw Error("unexpected SQL"); }, transaction: () => { throw Error("unexpected transaction"); }, exec: (sql: string) => { calls.push(sql); if (sql === "ROLLBACK") throw rollback; } };
  try { await transaction(db, async () => { throw original; }); throw Error("expected rejection"); } catch (error: any) {
    expect(error.code).toBe("OUTCOME_UNKNOWN");
    expect(error.cause).toBeInstanceOf(AggregateError);
    expect(error.cause.errors).toEqual([original, rollback]);
  }
  expect(calls).toEqual(["BEGIN IMMEDIATE", "ROLLBACK"]);
});

test("Store binds only accessed operations, retains enumeration and caches each wrapper", async () => {
  const { createStore } = await import("../src/kernel/store.js");
  const { dialect } = await import("../src/kernel/dialect/sqlite.js");
  const rules = { caller: [], trusted: [], fills: [], sets: [], lock: ["version", "eq", { k: "version" }], newId: "0" } as const;
  const db = {}, caller = { kind: "anonymous" } as const;
  let touched = 0;
  const operations = { views: {
    get unused(): (db: unknown, caller: unknown, input: number) => Promise<number> { throw Error("unused operation touched"); },
    get used() { touched++; return async (handle: unknown, owner: unknown, input: number) => { expect(handle).toBe(db); expect(owner).toBe(caller); return input; }; },
  } };
  const store = createStore(dialect, { read: () => [], procedure: async () => [] }, rules, {}, operations)(db, caller);
  expect(touched).toBe(0);
  expect(Object.keys(store.views)).toEqual(["unused", "used"]);
  expect(await store.views.used(42)).toBe(42);
  expect(store.views.used).toBe(store.views.used);
  expect(touched).toBe(1);
});

test("anonymous scoped inserts and batches refuse before any driver SQL", async () => {
  const { createStore } = await import("../src/kernel/store.js");
  const { dialect } = await import("../src/kernel/dialect/sqlite.js");
  const rules = { caller: [], trusted: [], fills: [], sets: [], lock: ["version", "eq", { k: "version" }], newId: "0" } as const;
  let calls = 0;
  const store = createStore(dialect, { read: () => { calls++; return []; }, procedure: async () => { calls++; return []; } }, rules, { scoped: { s: "private_owner" } })({}, { kind: "anonymous" });
  await expect(Promise.resolve(store.collection("scoped").insert({}))).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  await expect(store.batch([store.collection("scoped").insert({})])).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  expect(calls).toBe(0);
});
