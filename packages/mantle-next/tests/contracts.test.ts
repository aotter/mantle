import { expect, test } from "bun:test";
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
