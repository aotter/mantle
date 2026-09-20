import { describe, expect, it } from "vitest";
import { bestMatch, manifestPath } from "../src/domain/service/ManifestPathDiagnoser.js";

describe("manifestPath", () => {
  it("falls back to synthetic URI when no file paths map", () => {
    expect(manifestPath("Schema", "posts", "/spec/schema/properties")).toBe(
      "manifest:Schema/posts#/spec/schema/properties",
    );
  });

  it("uses file path + docIndex when supplied", () => {
    const fp = new Map([
      ["Schema/posts", [{ file: "/abs/manifests/site.yaml", docIndex: 0 }]],
    ]);
    expect(manifestPath("Schema", "posts", "/spec/title", fp)).toBe(
      "/abs/manifests/site.yaml#/0/spec/title",
    );
  });

  it("uses the Nth occurrence's location when `occurrence` arg is supplied (duplicate manifests)", () => {
    // PR17 codex-follow-up: with multi-occurrence file paths, each
    // duplicate diagnostic must point at its own source position
    // rather than always at the loader's last-write-wins entry.
    const fp = new Map([
      [
        "Schema/posts",
        [
          { file: "/abs/a.yaml", docIndex: 0 },
          { file: "/abs/b.yaml", docIndex: 0 },
          { file: "/abs/c.yaml", docIndex: 0 },
        ],
      ],
    ]);
    expect(manifestPath("Schema", "posts", "/metadata/name", fp, 1)).toBe(
      "/abs/a.yaml#/0/metadata/name",
    );
    expect(manifestPath("Schema", "posts", "/metadata/name", fp, 2)).toBe(
      "/abs/b.yaml#/0/metadata/name",
    );
    expect(manifestPath("Schema", "posts", "/metadata/name", fp, 3)).toBe(
      "/abs/c.yaml#/0/metadata/name",
    );
    // Out-of-range occurrence falls back to first.
    expect(manifestPath("Schema", "posts", "/metadata/name", fp, 99)).toBe(
      "/abs/a.yaml#/0/metadata/name",
    );
  });

  it("falls back to synthetic when filePaths lacks the key", () => {
    const fp = new Map<string, { file: string; docIndex: number }[]>();
    expect(manifestPath("View", "recent", "/spec/from", fp)).toBe(
      "manifest:View/recent#/spec/from",
    );
  });
});

describe("bestMatch (Levenshtein < 3)", () => {
  it("finds 1-edit typo", () => {
    expect(bestMatch("posst", ["posts", "tags", "media"])).toBe("posts");
  });

  it("finds 2-edit typo", () => {
    expect(bestMatch("postz", ["posts"])).toBe("posts");
  });

  it("returns undefined when no candidate within threshold (≥3)", () => {
    expect(bestMatch("foobar", ["posts", "tags", "media"])).toBeUndefined();
  });

  it("returns the closest of multiple near matches", () => {
    expect(bestMatch("postt", ["posts", "porst"])).toBe("posts");
  });

  it("returns undefined for empty candidate list", () => {
    expect(bestMatch("anything", [])).toBeUndefined();
  });

  it("treats exact matches as distance 0 (well within < 3)", () => {
    expect(bestMatch("posts", ["posts", "tags"])).toBe("posts");
  });

  it("handles empty target string", () => {
    // Distance equals candidate length; "ab" is length 2 → matches (< 3).
    expect(bestMatch("", ["ab", "abcd"])).toBe("ab");
  });
});
