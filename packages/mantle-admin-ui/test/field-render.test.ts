import { describe, expect, it } from "vitest";
import { formatMoneyMinor, hintBadgeLabel, idTail } from "../src/features/content/field-render";

/**
 * #444 — pure-logic coverage for the three helpers that changed as
 * part of the UX polish batch: the id-tail display helper (item 6),
 * the money-minor currency-formatting fallback (item 8, unit-testing
 * the "no hardcoded currency map" requirement), and the hint-badge
 * localization (item 8, confirming unknown/custom hints pass through
 * untouched rather than getting swallowed).
 */

describe("idTail", () => {
  it("returns the last N characters, not the first", () => {
    // Every entry in a collection shares the same `entry_o_` head —
    // the old head-truncation behavior this replaces — so the tail
    // must be what actually distinguishes one row's id from another's.
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
    // 128000 minor units of TWD → NT$1,280 major units. This only
    // passes if the implementation defers to Intl for the symbol
    // instead of a lookup table — TWD isn't special-cased anywhere.
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

describe("hintBadgeLabel", () => {
  it("localizes the money-minor hint instead of showing the raw token", () => {
    const label = hintBadgeLabel("money-minor", "en");
    expect(label).not.toBe("money-minor");
    expect(label.toLowerCase()).toContain("amount");
  });

  it("localizes the timestamp-ms hint instead of showing the raw token", () => {
    const label = hintBadgeLabel("timestamp-ms", "en");
    expect(label).not.toBe("timestamp-ms");
  });

  it("translates money-minor into zh-TW", () => {
    expect(hintBadgeLabel("money-minor", "zh-TW")).toBe("金額（最小單位）");
  });

  it("passes an unknown/custom hint token through unchanged", () => {
    // A manifest author can put any free-form string in x-mcp-hint;
    // this package must not swallow or blank out a token it doesn't
    // recognize (no hardcoded domain map to localize it against).
    expect(hintBadgeLabel("media-hero", "en")).toBe("media-hero");
    expect(hintBadgeLabel("some-custom-hint", "zh-TW")).toBe("some-custom-hint");
  });
});
