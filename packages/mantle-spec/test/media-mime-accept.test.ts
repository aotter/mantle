import { describe, expect, it } from "vitest";
import {
  expandPolicyRequired,
  parseMimeAccept,
} from "../src/domain/model/MediaMimeAccept.js";
import {
  InvalidMediaPurposesError,
  assertSiteDefaultsCanonical,
} from "../src/domain/service/SiteDefaultsValidator.js";

describe("parseMimeAccept (input-accept-style mime grammar, #282)", () => {
  it("passes a full mime through unchanged", () => {
    expect(parseMimeAccept("image/jpeg")).toEqual(["image/jpeg"]);
    expect(parseMimeAccept("image/avif")).toEqual(["image/avif"]);
  });

  it("expands shorthand subtypes to full mimes", () => {
    expect(parseMimeAccept("webp")).toEqual(["image/webp"]);
    expect(parseMimeAccept("avif")).toEqual(["image/avif"]);
    expect(parseMimeAccept("png")).toEqual(["image/png"]);
    expect(parseMimeAccept("gif")).toEqual(["image/gif"]);
    expect(parseMimeAccept("svg")).toEqual(["image/svg+xml"]);
  });

  it("treats jpg / jpeg / image/jpg as aliases for image/jpeg", () => {
    expect(parseMimeAccept("jpg")).toEqual(["image/jpeg"]);
    expect(parseMimeAccept("jpeg")).toEqual(["image/jpeg"]);
    expect(parseMimeAccept("image/jpg")).toEqual(["image/jpeg"]);
  });

  it("splits comma-lists into multiple acceptable mimes", () => {
    expect(parseMimeAccept("image/jpg,image/png")).toEqual([
      "image/jpeg",
      "image/png",
    ]);
    expect(parseMimeAccept("webp,avif")).toEqual(["image/webp", "image/avif"]);
  });

  it("tolerates whitespace around commas and entries", () => {
    expect(parseMimeAccept("  image/jpeg , image/png  ")).toEqual([
      "image/jpeg",
      "image/png",
    ]);
  });

  it("dedupes aliased forms within one entry", () => {
    // jpg + jpeg + image/jpg all collapse to image/jpeg — one slot
    expect(parseMimeAccept("jpg,jpeg,image/jpg")).toEqual(["image/jpeg"]);
  });

  it("skips empty tokens from leading/trailing commas", () => {
    expect(parseMimeAccept(",image/jpeg,,image/png,")).toEqual([
      "image/jpeg",
      "image/png",
    ]);
  });

  it("returns empty for blank input", () => {
    expect(parseMimeAccept("")).toEqual([]);
    expect(parseMimeAccept("   ")).toEqual([]);
    expect(parseMimeAccept(",,,")).toEqual([]);
  });

  it("preserves unknown mimes as-is (allowlist gates them at runtime)", () => {
    expect(parseMimeAccept("application/wibble")).toEqual([
      "application/wibble",
    ]);
  });
});

describe("expandPolicyRequired", () => {
  it("expands every slot independently, preserving slot order", () => {
    expect(
      expandPolicyRequired(["image/jpg,image/png", "webp", "avif"]),
    ).toEqual([
      ["image/jpeg", "image/png"],
      ["image/webp"],
      ["image/avif"],
    ]);
  });

  it("is identity-shaped for the canonical full-mime form (back-compat)", () => {
    expect(
      expandPolicyRequired(["image/jpeg", "image/webp", "image/avif"]),
    ).toEqual([["image/jpeg"], ["image/webp"], ["image/avif"]]);
  });
});

describe("SiteDefaultsValidator + new mime grammar", () => {
  it("accepts the new grammar end-to-end (comma-lists + shorthand)", () => {
    expect(() =>
      assertSiteDefaultsCanonical({
        media: {
          purposes: [
            {
              name: "product-cover",
              required: ["image/jpg,image/png", "webp", "avif"],
              maxBytes: {
                "image/jpeg": 500_000,
                "image/png": 600_000,
                "image/webp": 400_000,
                "image/avif": 300_000,
              },
            },
          ],
        },
      }),
    ).not.toThrow();
  });

  it("rejects overlapping mime sets across slots (ambiguous variant→slot mapping)", () => {
    expect(() =>
      assertSiteDefaultsCanonical({
        media: {
          purposes: [
            {
              name: "ambiguous",
              required: ["jpg,webp", "webp"], // webp in both slots
              maxBytes: { "image/jpeg": 1, "image/webp": 1 },
            },
          ],
        },
      }),
    ).toThrow(InvalidMediaPurposesError);
  });

  it("rejects a slot that parses to zero mimes", () => {
    expect(() =>
      assertSiteDefaultsCanonical({
        media: {
          purposes: [
            {
              name: "empty-slot",
              required: ["jpg", ",,,"], // second slot parses to []
              maxBytes: { "image/jpeg": 1 },
            },
          ],
        },
      }),
    ).toThrow(InvalidMediaPurposesError);
  });

  it("requires maxBytes keys to use FULLY-EXPANDED mimes, not shorthand", () => {
    expect(() =>
      assertSiteDefaultsCanonical({
        media: {
          purposes: [
            {
              name: "shorthand-key",
              required: ["jpg", "webp"],
              maxBytes: { jpg: 1, webp: 1 }, // wrong — must be image/jpeg etc
            },
          ],
        },
      }),
    ).toThrow(InvalidMediaPurposesError);
  });

  it("accepts the back-compat canonical form (no commas, no shorthand)", () => {
    expect(() =>
      assertSiteDefaultsCanonical({
        media: {
          purposes: [
            {
              name: "post-cover",
              required: ["image/avif", "image/webp", "image/jpeg"],
              maxBytes: {
                "image/avif": 200_000,
                "image/webp": 300_000,
                "image/jpeg": 500_000,
              },
            },
          ],
        },
      }),
    ).not.toThrow();
  });
});
