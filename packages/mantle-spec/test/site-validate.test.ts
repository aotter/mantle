import { describe, expect, it } from "vitest";
import {
  assertSiteDefaultsCanonical,
  InvalidMediaPurposesError,
  InvalidSiteDefaultsError,
  InvalidSiteIconsError,
} from "../src/domain/service/SiteDefaultsValidator.js";

describe("assertSiteDefaultsCanonical (boot-time fail-fast)", () => {
  it("accepts canonical BCP 47 locales", () => {
    expect(() =>
      assertSiteDefaultsCanonical({ locales: ["en", "zh-TW", "ja"] }),
    ).not.toThrow();
  });

  it("accepts case-recoverable non-canonical input (canonicalizer normalises)", () => {
    expect(() =>
      assertSiteDefaultsCanonical({ locales: ["en", "zh-tw"] }),
    ).not.toThrow();
  });

  it("throws InvalidSiteDefaultsError on garbage", () => {
    expect(() =>
      assertSiteDefaultsCanonical({ locales: ["english", ""] }),
    ).toThrow(InvalidSiteDefaultsError);
  });

  it("explains script-subtag rejection with region-tag alternatives", () => {
    try {
      assertSiteDefaultsCanonical({ locales: ["zh-Hant", "zh-Hans"] });
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidSiteDefaultsError);
      expect((e as Error).message).toContain("valid BCP 47");
      expect((e as Error).message).toContain("unsupported in Mantle v0.1");
      expect((e as Error).message).toContain("zh-TW");
      expect((e as Error).message).toContain("zh-CN");
    }
  });

  it("InvalidSiteDefaultsError carries the invalid list", () => {
    try {
      assertSiteDefaultsCanonical({ locales: ["english", "zh-TW", ""] });
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidSiteDefaultsError);
      expect((e as InvalidSiteDefaultsError).invalidLocales).toEqual([
        "english",
        "",
      ]);
    }
  });

  it("no-op when locales is empty / undefined", () => {
    expect(() => assertSiteDefaultsCanonical(undefined)).not.toThrow();
    expect(() => assertSiteDefaultsCanonical({})).not.toThrow();
    expect(() => assertSiteDefaultsCanonical({ locales: [] })).not.toThrow();
  });

  it("no-op when only brand / title are set", () => {
    expect(() =>
      assertSiteDefaultsCanonical({ brand: "X", title: "Y" }),
    ).not.toThrow();
  });

  it("accepts browser-safe site icons and rejects unsafe or malformed values", () => {
    expect(() => assertSiteDefaultsCanonical({
      icons: [
        { src: "/site-icon.svg", mimeType: "image/svg+xml", sizes: ["any"] },
        { src: "https://cdn.example/icon.png", mimeType: "image/png", sizes: ["64x64"] },
      ],
    })).not.toThrow();
    for (const src of ["javascript:alert(1)", "data:image/svg+xml,x", "//evil.example/x.png", "/\\evil.example/x.png", "http://example.com/x.png"]) {
      expect(() => assertSiteDefaultsCanonical({ icons: [{ src }] })).toThrow(InvalidSiteIconsError);
    }
    expect(() => assertSiteDefaultsCanonical({ icons: [] })).toThrow(InvalidSiteIconsError);
    expect(() => assertSiteDefaultsCanonical({ icons: [{ src: "/icon.png", sizes: ["64"] }] }))
      .toThrow(InvalidSiteIconsError);
  });

  describe("media.purposes object-policy validation (#272)", () => {
    const validPolicy = (name: string) => ({
      name,
      required: ["image/avif", "image/webp", "image/jpeg"],
      maxBytes: {
        "image/avif": 200_000,
        "image/webp": 300_000,
        "image/jpeg": 500_000,
      },
    });

    it("accepts slug-shaped purposes with full policy", () => {
      expect(() =>
        assertSiteDefaultsCanonical({
          media: {
            purposes: [
              validPolicy("post-cover"),
              validPolicy("product-cover"),
              validPolicy("product-gallery"),
              validPolicy("a1b2"),
            ],
          },
        }),
      ).not.toThrow();
    });

    it("no-op when media is undefined or purposes is empty", () => {
      expect(() => assertSiteDefaultsCanonical({ media: undefined })).not.toThrow();
      expect(() => assertSiteDefaultsCanonical({ media: {} })).not.toThrow();
      expect(() => assertSiteDefaultsCanonical({ media: { purposes: [] } })).not.toThrow();
    });

    it("throws InvalidMediaPurposesError on non-slug names", () => {
      const cases = ["Post-Cover", "post_cover", "-leading", "trailing-", "double--dash", ""];
      for (const bad of cases) {
        expect(() =>
          assertSiteDefaultsCanonical({ media: { purposes: [validPolicy(bad)] } }),
        ).toThrow(InvalidMediaPurposesError);
      }
    });

    it("throws when required is empty", () => {
      expect(() =>
        assertSiteDefaultsCanonical({
          media: {
            purposes: [
              { name: "post-cover", required: [], maxBytes: {} },
            ],
          },
        }),
      ).toThrow(InvalidMediaPurposesError);
    });

    it("throws when maxBytes is missing entries for required mimes", () => {
      expect(() =>
        assertSiteDefaultsCanonical({
          media: {
            purposes: [
              {
                name: "post-cover",
                required: ["image/avif", "image/webp"],
                maxBytes: { "image/avif": 200_000 },
              },
            ],
          },
        }),
      ).toThrow(InvalidMediaPurposesError);
    });

    it("throws when a required mime has a non-positive maxBytes", () => {
      expect(() =>
        assertSiteDefaultsCanonical({
          media: {
            purposes: [
              {
                name: "post-cover",
                required: ["image/avif"],
                maxBytes: { "image/avif": 0 },
              },
            ],
          },
        }),
      ).toThrow(InvalidMediaPurposesError);
    });

    it("InvalidMediaPurposesError carries structured issues", () => {
      try {
        assertSiteDefaultsCanonical({
          media: {
            purposes: [
              validPolicy("ok-one"),
              validPolicy("Bad"),
              validPolicy("ok-two"),
              { name: "missing-cap", required: ["image/avif"], maxBytes: {} },
            ],
          },
        });
        throw new Error("expected throw");
      } catch (e) {
        expect(e).toBeInstanceOf(InvalidMediaPurposesError);
        const issues = (e as InvalidMediaPurposesError).issues;
        expect(issues).toHaveLength(2);
        expect(issues[0]).toMatchObject({ name: "Bad", reason: "invalid-slug" });
        expect(issues[1]).toMatchObject({
          name: "missing-cap",
          reason: "maxBytes-missing-mime",
        });
      }
    });
  });
});
