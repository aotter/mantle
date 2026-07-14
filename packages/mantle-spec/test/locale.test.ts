import { describe, expect, it } from "vitest";
import { InvalidLocaleError, URL_LOCALE } from "../src/domain/model/Locale.js";
import {
  canonicalizeLocaleList,
  safeCanonicalLocale,
  toCanonicalLocale,
  toUrlLocale,
} from "../src/domain/service/LocaleCanonicalizer.js";

describe("toCanonicalLocale", () => {
  it("preserves canonical form for already-canonical values", () => {
    expect(toCanonicalLocale("zh-TW")).toBe("zh-TW");
    expect(toCanonicalLocale("en-US")).toBe("en-US");
    expect(toCanonicalLocale("pt-BR")).toBe("pt-BR");
    expect(toCanonicalLocale("en")).toBe("en");
  });

  it("uppercases the region", () => {
    expect(toCanonicalLocale("zh-tw")).toBe("zh-TW");
    expect(toCanonicalLocale("en-us")).toBe("en-US");
  });

  it("lowercases the language", () => {
    expect(toCanonicalLocale("ZH-TW")).toBe("zh-TW");
    expect(toCanonicalLocale("EN-us")).toBe("en-US");
  });

  it("accepts underscore separator", () => {
    expect(toCanonicalLocale("zh_TW")).toBe("zh-TW");
    expect(toCanonicalLocale("en_us")).toBe("en-US");
  });

  it("accepts no-separator 4-char form", () => {
    expect(toCanonicalLocale("zhTW")).toBe("zh-TW");
    expect(toCanonicalLocale("enus")).toBe("en-US");
  });

  it("accepts language-only", () => {
    expect(toCanonicalLocale("zh")).toBe("zh");
    expect(toCanonicalLocale("EN")).toBe("en");
  });

  it("throws InvalidLocaleError on empty input", () => {
    expect(() => toCanonicalLocale("")).toThrow(InvalidLocaleError);
  });

  it("throws InvalidLocaleError on non-string", () => {
    // @ts-expect-error testing non-string runtime input
    expect(() => toCanonicalLocale(undefined)).toThrow(InvalidLocaleError);
    // @ts-expect-error testing non-string runtime input
    expect(() => toCanonicalLocale(null)).toThrow(InvalidLocaleError);
  });

  it("throws on garbage input", () => {
    expect(() => toCanonicalLocale("12-34")).toThrow(InvalidLocaleError);
    expect(() => toCanonicalLocale("z")).toThrow(InvalidLocaleError);
    expect(() => toCanonicalLocale("zhongwen")).toThrow(InvalidLocaleError);
    expect(() => toCanonicalLocale("zh-T")).toThrow(InvalidLocaleError);
    // Note: "zh-TW-extra" leaks through as "zh-TW" because the parser
    // only reads parts[0] and parts[1] without bounding parts.length.
    // This matches POC behavior (port-exact); fixing it is a separate
    // concern.
  });

  it("rejects script subtags in Mantle v0.1", () => {
    expect(() => toCanonicalLocale("zh-Hant")).toThrow(InvalidLocaleError);
    expect(() => toCanonicalLocale("zh-Hans")).toThrow(InvalidLocaleError);
    expect(() => toCanonicalLocale("sr-Latn")).toThrow(InvalidLocaleError);
    expect(() => toCanonicalLocale("sr-Cyrl")).toThrow(InvalidLocaleError);
    expect(() => toCanonicalLocale("zh-Hant-HK")).toThrow(InvalidLocaleError);
  });

  it("InvalidLocaleError carries the original input in its message", () => {
    try {
      toCanonicalLocale("garbage");
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidLocaleError);
      expect((err as Error).message).toContain("garbage");
      expect((err as Error).name).toBe("InvalidLocaleError");
    }
  });
});

describe("safeCanonicalLocale", () => {
  it("returns canonical form for valid input", () => {
    expect(safeCanonicalLocale("zh-tw")).toBe("zh-TW");
  });

  it("returns input unchanged for invalid input (no throw)", () => {
    expect(safeCanonicalLocale("garbage")).toBe("garbage");
    expect(safeCanonicalLocale("")).toBe("");
  });
});

describe("canonicalizeLocaleList", () => {
  it("partitions valid and invalid in one pass", () => {
    const { valid, invalid } = canonicalizeLocaleList(["zh-tw", "en", "garbage", "12"]);
    expect(valid).toEqual(["zh-TW", "en"]);
    expect(invalid).toEqual(["garbage", "12"]);
  });

  it("preserves input order in valid", () => {
    const { valid } = canonicalizeLocaleList(["en", "zh-tw", "ja"]);
    expect(valid).toEqual(["en", "zh-TW", "ja"]);
  });

  it("dedupes after canonicalization", () => {
    const { valid } = canonicalizeLocaleList(["zh-tw", "zh-TW", "ZH_tw"]);
    expect(valid).toEqual(["zh-TW"]);
  });

  it("returns empty arrays for empty input", () => {
    expect(canonicalizeLocaleList([])).toEqual({ valid: [], invalid: [] });
  });

  it("handles all-invalid input", () => {
    const { valid, invalid } = canonicalizeLocaleList(["", "garbage", "12-34"]);
    expect(valid).toEqual([]);
    expect(invalid).toEqual(["", "garbage", "12-34"]);
  });
});

describe("toUrlLocale", () => {
  it("lowercases canonical form", () => {
    expect(toUrlLocale("zh-TW")).toBe("zh-tw");
    expect(toUrlLocale("en-US")).toBe("en-us");
    expect(toUrlLocale("en")).toBe("en");
  });
});

describe("URL_LOCALE regex", () => {
  it("matches lowercase BCP 47 forms", () => {
    expect(URL_LOCALE.test("zh-tw")).toBe(true);
    expect(URL_LOCALE.test("en")).toBe(true);
    expect(URL_LOCALE.test("en-us")).toBe(true);
  });

  it("rejects uppercase, mixed-case, garbage", () => {
    expect(URL_LOCALE.test("zh-TW")).toBe(false);
    expect(URL_LOCALE.test("ZH-tw")).toBe(false);
    expect(URL_LOCALE.test("foo")).toBe(false);
    expect(URL_LOCALE.test("")).toBe(false);
  });
});
