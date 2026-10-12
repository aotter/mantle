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
