import { describe, expect, test } from "bun:test";
import * as z from "zod/mini";
import { validate } from "../src/kernel/checked.js";
import { ContractError, encodeNumeric, decodeNumeric, encodeTimestamptz, decodeTimestamptz, encodeDate } from "../src/kernel/contracts.js";
describe("generated boundary primitives", () => {
  test("official defaults, nullability and unknown-key refusal", () => {
    const schema = z.strictObject({ amount: z._default(z.number().check(z.gte(0)), 0), note: z.nullable(z.string()) });
    expect(validate(schema, { note: null }, "input")).toEqual({ amount: 0, note: null });
    expect(() => validate(schema, { note: null, extra: true }, "input")).toThrow(ContractError);
    expect(() => validate(schema, { amount: -1, note: null }, "input")).toThrow(ContractError);
  });
  test("cyclic values fail; shared objects do not invent a cycle", () => {
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    expect(() => validate(z.unknown(), cyclic, "input")).toThrow(ContractError);
    const shared = { v: 1 };
    expect(validate(z.unknown(), { a: shared, b: shared }, "input")).toEqual({ a: shared, b: shared });
  });
  test("legacy scalar precision and impossible dates", () => {
    expect(decodeNumeric(encodeNumeric("12.34", 8, 2), 2)).toBe("12.34");
    expect(() => encodeNumeric("12.345", 8, 2)).toThrow();
    expect(() => encodeDate("2026-02-30")).toThrow();
    expect(decodeTimestamptz(encodeTimestamptz("2026-10-11T00:00:00.123456Z"))).toBe("2026-10-11T00:00:00.123456Z");
  });
});
test("native PG wire values preserve baseline integers and timestamp precision", async () => {
  const { decodeField } = await import("../src/kernel/contracts.js");
  expect(decodeField(20, "120")).toBe(120);
  expect(decodeField(20, "9007199254740993")).toBe("9007199254740993");
  expect(decodeField(1184, "2026-10-11 08:00:00.123456+08")).toBe("2026-10-11T00:00:00.123456Z");
  expect(decodeField(1700, "12.34", 524294)).toBe("12.34");
  expect(decodeField(1700, "12.34")).toBe(12.34);
});
test("output validation is classified; getters fail safely", () => {
  try { validate(z.number(), "bad", "output", "OUTPUT_VALIDATION_FAILED"); }
  catch (error) { expect((error as ContractError).code).toBe("OUTPUT_VALIDATION_FAILED"); }
  const dangerous = { get value() { throw new Error("private payload"); } };
  expect(() => validate(z.unknown(), dangerous, "input")).toThrow("the schema cannot check this value");
});
test("native failure classes preserve refusal versus unknown commit and redact payloads", async () => {
  const { databaseError } = await import("../src/kernel/contracts.js");
  const native = (code: string) => Object.assign(new Error("private SQL and credential"), { code });
  expect(databaseError(native("40001"), "write", "procedure", "postgres").code).toBe("RESOURCE_UNAVAILABLE");
  expect(databaseError(native("57P01"), "write", "procedure", "postgres").code).toBe("OUTCOME_UNKNOWN");
  expect(databaseError(native("08006"), "write", "procedure", "postgres").code).toBe("OUTCOME_UNKNOWN");
  expect(databaseError(native("23505"), "write", "procedure", "postgres").code).toBe("CONFLICT");
  expect(databaseError(new Error("CONFLICT op=1: SQLITE_CONSTRAINT"), "write", "procedure", "sqlite").code).toBe("CONFLICT");
  expect(JSON.stringify(databaseError(native("23505"), "write", "procedure", "postgres"))).not.toContain("credential");
});
