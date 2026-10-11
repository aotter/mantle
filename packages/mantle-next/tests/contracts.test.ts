import { expect, test } from "bun:test";
test("ISO inputs refuse what Date.parse would roll over or cannot represent", async () => {
  const { encodeTimestamptz, encodeDate, isoTimestamptz } = await import("../src/kernel/contracts.js");
  expect(encodeTimestamptz("2026-10-11T08:00:00.000001+08:00")).toBe(Date.parse("2026-10-11T00:00:00Z") * 1000 + 1);
  expect(isoTimestamptz("2026-10-11T08:00:00.000001+08:00")).toBe("2026-10-11T00:00:00.000001Z");
  for (const bad of ["2026-10-11T24:00:00Z", "2026-10-11T00:00:00", "2026-02-30T00:00:00Z"]) expect(() => encodeTimestamptz(bad)).toThrow("not a");
  expect(() => encodeTimestamptz(new Date("garbage"))).toThrow("Invalid Date");
  expect(() => encodeDate("2026-02-30")).toThrow("not a valid date");
});
