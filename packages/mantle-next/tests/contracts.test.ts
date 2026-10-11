import { expect, test } from "bun:test";
test("native failure classes preserve refusal versus unknown commit and redact payloads", async () => {
  const { databaseError } = await import("../src/kernel/contracts.js");
  const native = (code: string) => Object.assign(new Error("private SQL and credential"), { code });
  expect(databaseError(native("40001"), "write", "procedure", "postgres").code).toBe("RESOURCE_UNAVAILABLE");
  expect(databaseError(native("57P01"), "write", "procedure", "postgres").code).toBe("OUTCOME_UNKNOWN");
  expect(databaseError(native("08006"), "write", "procedure", "postgres").code).toBe("OUTCOME_UNKNOWN");
  expect(databaseError(native("23505"), "write", "procedure", "postgres").code).toBe("CONFLICT");
  // Bun.SQL: SQLSTATE in errno, a driver code in code
  expect(databaseError(Object.assign(new Error("x"), { errno: "23505", code: "ERR_POSTGRES_SERVER_ERROR" }), "write", "procedure", "postgres").code).toBe("CONFLICT");
  expect(databaseError(new Error("CONFLICT op=1: SQLITE_CONSTRAINT"), "write", "procedure", "sqlite").code).toBe("CONFLICT");
  expect(JSON.stringify(databaseError(native("23505"), "write", "procedure", "postgres"))).not.toContain("credential");
});

test("ISO inputs refuse what Date.parse would roll over or cannot represent", async () => {
  const { encodeTimestamptz, encodeDate, isoTimestamptz } = await import("../src/kernel/contracts.js");
  expect(encodeTimestamptz("2026-10-11T08:00:00.000001+08:00")).toBe(Date.parse("2026-10-11T00:00:00Z") * 1000 + 1);
  expect(isoTimestamptz("2026-10-11T08:00:00.000001+08:00")).toBe("2026-10-11T00:00:00.000001Z");
  for (const bad of ["2026-10-11T24:00:00Z", "2026-10-11T00:00:00", "2026-02-30T00:00:00Z"]) expect(() => encodeTimestamptz(bad)).toThrow("not a");
  expect(() => encodeTimestamptz(new Date("garbage"))).toThrow("Invalid Date");
  expect(() => encodeDate("2026-02-30")).toThrow("not a valid date");
});
