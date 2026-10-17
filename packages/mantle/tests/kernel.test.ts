import { expect, test } from "bun:test";
import { encodeDate, encodeTimestamptz, isoDate, isoTimestamptz } from "../src/kernel/scalars.js";

test("ISO inputs refuse what Date.parse would roll over or cannot represent", () => {
  expect(encodeTimestamptz("2026-10-11T08:00:00.000001+08:00")).toBe(Date.parse("2026-10-11T00:00:00Z") * 1000 + 1);
  expect(isoTimestamptz("2026-10-11T08:00:00.000001+08:00")).toBe("2026-10-11T00:00:00.000001Z");
  for (const bad of ["2026-10-11T24:00:00Z", "2026-10-11T00:00:00", "2026-02-30T00:00:00Z"]) expect(() => encodeTimestamptz(bad)).toThrow("not a");
  expect(() => encodeTimestamptz(new Date("garbage"))).toThrow("Invalid Date");
  expect(() => encodeTimestamptz(new Date("5000-01-01T00:00:00.001Z"))).toThrow("not a valid timestamp");
  expect(() => encodeDate("2026-02-30")).toThrow("not a valid date");
});

test("D1 batch transport failures preserve the uncertain write outcome", async () => {
  const { procedure } = await import("../src/kernel/driver/d1.js");
  const cause = new Error("response lost after commit");
  const statement = { bind() { return this; }, all: async () => ({ results: [], meta: { changes: 1 } }) };
  const db = { prepare: () => statement, batch: async () => { throw cause; } };
  await expect(procedure(db, [{ sql: "UPDATE records SET value = ?", binds: [1] }], "save")).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN", path: "save", cause });
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

test("a PostgreSQL handle without begin runs single statements and refuses a multi-statement Procedure clearly", async () => {
  const { procedure } = await import("../src/kernel/driver/postgres.js");
  const rows = Object.assign([{ id: 1 }], { count: 1 });
  const tx = { unsafe: async () => rows } as never;
  expect(await procedure(tx, [{ sql: "SELECT 1", binds: [] }], "p")).toEqual([rows]);
  await expect(procedure(tx, [{ sql: "SELECT 1", binds: [] }, { sql: "SELECT 2", binds: [] }], "p")).rejects.toThrow(/cannot begin another/);
});
