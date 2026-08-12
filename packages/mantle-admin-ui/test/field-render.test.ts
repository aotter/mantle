import { describe, expect, it } from "vitest";
import {
  formatMoneyMinor,
  idTail,
  timestampMsForInput,
  timestampMsFromInput,
} from "../src/features/content/field-render";

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

describe("timestamp datetime input", () => {
  it("round-trips an epoch-millisecond value through local datetime input", () => {
    const timestamp = new Date(2026, 7, 12, 17, 30).getTime();
    expect(timestampMsFromInput(timestampMsForInput(timestamp))).toBe(timestamp);
  });

  it("keeps empty and invalid input empty", () => {
    expect(timestampMsForInput(null)).toBe("");
    expect(timestampMsFromInput("")).toBeNull();
    expect(timestampMsFromInput("not-a-date")).toBeNull();
  });
});
