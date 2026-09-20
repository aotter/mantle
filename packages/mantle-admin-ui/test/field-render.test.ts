import { describe, expect, it } from "vitest";
import {
  dateFromFieldValue,
  formatMoneyMinor,
  idTail,
} from "../src/features/content/field-render";

describe("dateFromFieldValue", () => {
  it("accepts epoch milliseconds and ISO strings but rejects invalid values", () => {
    expect(dateFromFieldValue(1_786_405_800_000)?.getTime()).toBe(1_786_405_800_000);
    expect(dateFromFieldValue("2026-08-12T09:30:00.000Z")?.toISOString()).toBe("2026-08-12T09:30:00.000Z");
    expect(dateFromFieldValue("not-a-date")).toBeUndefined();
  });
});

describe("idTail", () => {
  it("returns the last N characters, not the first", () => {
    expect(idTail("entry_o_9f2c8b1a4d3e", 8)).toBe("8b1a4d3e");
    expect(idTail("entry_o_9f2c8b1a4d3e", 8)).not.toBe("entry_o_");
  });

  it("defaults to an 8-character tail", () => {
    expect(idTail("entry_o_9f2c8b1a4d3e")).toBe("9f2c8b1a4d3e".slice(-8));
  });

  it("returns the id unchanged when it's already shorter than the requested length", () => {
    expect(idTail("short", 8)).toBe("short");
  });

  it("returns the id unchanged when it's exactly the requested length", () => {
    expect(idTail("12345678", 8)).toBe("12345678");
  });
});

describe("formatMoneyMinor", () => {
  it("formats using the sibling currency code via Intl.NumberFormat, no hardcoded symbol map", () => {
    const formatted = formatMoneyMinor(128_000, "TWD");
    expect(formatted).toContain("1,280");
  });

  it("formats USD distinctly from TWD for the same minor-unit value", () => {
    const usd = formatMoneyMinor(128_000, "USD");
    const twd = formatMoneyMinor(128_000, "TWD");
    expect(usd).not.toBe(twd);
  });

  it("falls back to plain grouped formatting when currency is missing", () => {
    const formatted = formatMoneyMinor(128_000, undefined);
    expect(formatted).toBe(new Intl.NumberFormat().format(1280));
  });

  it("falls back to plain grouped formatting when currency is an invalid ISO code", () => {
    const formatted = formatMoneyMinor(128_000, "NOT_A_CURRENCY");
    expect(formatted).toBe(new Intl.NumberFormat().format(1280));
  });

  it("returns null for a non-numeric value", () => {
    expect(formatMoneyMinor("128000", "USD")).toBeNull();
    expect(formatMoneyMinor(undefined, "USD")).toBeNull();
  });
});
