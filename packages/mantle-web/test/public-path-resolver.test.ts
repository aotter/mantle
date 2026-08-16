import { describe, expect, it } from "vitest";
import type { Entry } from "@aotter/mantle-spec";
import { createPublicPathResolver } from "../src/service/PublicPathResolver.js";

function entry(overrides: Partial<Entry> & { id?: string; collection: string }): Entry {
  return {
    id: overrides.id ?? "x",
    collection: overrides.collection,
    locale: overrides.locale,
    status: "published",
    version: 1,
    data: overrides.data ?? {},
    createdAt: 0,
    updatedAt: 0,
  };
}

describe("createPublicPathResolver", () => {
  const resolver = createPublicPathResolver({
    collectionRoutes: {
      "post-translations": { segment: "posts" },
      "page-translations": { segment: "pages", homeSlug: "home" },
      "internal-only": { segment: null },
    },
  });

  it("builds /{locale}/{segment}/{slug} for translations", () => {
    expect(
      resolver.forEntry(
        entry({ collection: "post-translations", locale: "en", data: { slug: "hello" } }),
      ),
    ).toBe("/en/posts/hello");
  });

  it("collapses homeSlug to /{locale}", () => {
    expect(
      resolver.forEntry(
        entry({ collection: "page-translations", locale: "en", data: { slug: "home" } }),
      ),
    ).toBe("/en");
  });

  it("returns null for collections with segment: null", () => {
    expect(
      resolver.forEntry(
        entry({ collection: "internal-only", locale: "en", data: { slug: "x" } }),
      ),
    ).toBeNull();
  });

  it("returns null for unmapped collections", () => {
    expect(
      resolver.forEntry(entry({ collection: "unknown", locale: "en", data: { slug: "x" } })),
    ).toBeNull();
  });

  it("lowercases the locale segment per BCP-47 URL convention", () => {
    expect(
      resolver.forEntry(
        entry({ collection: "post-translations", locale: "zh-TW", data: { slug: "hi" } }),
      ),
    ).toBe("/zh-tw/posts/hi");
  });

  it("falls back to entry.id when data.slug is malformed", () => {
    expect(
      resolver.forEntry(
        entry({
          id: "raw-id",
          collection: "post-translations",
          locale: "en",
          data: { slug: "Not A Slug!" },
        }),
      ),
    ).toBe("/en/posts/raw-id");
  });
});
