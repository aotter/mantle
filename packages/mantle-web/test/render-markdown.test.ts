import { describe, expect, it } from "vitest";
import {
  serializeEntryAsMarkdown,
  serializeLlmsTxt,
} from "../src/service/MarkdownSerializer.js";
import type { Entry, SiteConfig } from "@aotter/mantle-spec";

const site: SiteConfig = {
  title: "Blog",
  description: "All the posts.",
  origin: "https://example.com",
  locales: ["en-US"],
  canonicalLocale: "en-US",
  brand: "Blog",
};

function entry(data: Record<string, unknown>, locale?: string): Entry {
  return {
    id: "p1",
    collection: "posts",
    status: "published",
    version: 1,
    data,
    createdAt: 1,
    updatedAt: 2,
    ...(locale ? { locale } : {}),
  };
}

describe("serializeEntryAsMarkdown", () => {
  it("emits frontmatter + heading + content for entries with content", () => {
    const md = serializeEntryAsMarkdown(
      entry({ title: "Hello", content: "Body text", slug: "hello" }, "en-US"),
    );
    expect(md).toContain("title: Hello");
    expect(md).toContain("# Hello");
    expect(md).toContain("Body text");
    expect(md).toContain("locale: en-US");
  });

  it("skips entries without a content field", () => {
    expect(serializeEntryAsMarkdown(entry({ title: "no body" }))).toBeNull();
  });

  it("includes description as a blockquote when present", () => {
    const md = serializeEntryAsMarkdown(
      entry({ title: "T", description: "summary", content: "body" }),
    );
    expect(md).toContain("> summary");
  });

  it("uses summary for product-style entries", () => {
    const md = serializeEntryAsMarkdown(
      entry({ title: "T", summary: "Useful product", slug: "t" }),
    );
    expect(md).toContain("description: Useful product");
    expect(md).toContain("Useful product");
  });

  it("serializes structured page sections without a content field", () => {
    const md = serializeEntryAsMarkdown(entry({
      title: "About",
      sections: [{
        type: "content",
        title: "Our story",
        body: "Built for the ocean.",
        items: [{ title: "North", body: "A clear direction." }],
      }],
    }));
    expect(md).toContain("## Our story");
    expect(md).toContain("Built for the ocean.");
    expect(md).toContain("**North:** A clear direction.");
  });

  it("rejects blank content instead of emitting an empty mirror", () => {
    expect(serializeEntryAsMarkdown(entry({ title: "Blank", content: "  " }))).toBeNull();
  });
});

describe("serializeLlmsTxt", () => {
  it("emits a per-collection section with bullets per content-bearing entry", () => {
    const out = serializeLlmsTxt({
      site,
      locale: "en-US",
      entriesByCollection: new Map([
        [
          "posts",
          [
            entry({ title: "T1", slug: "t1", content: "c1" }, "en-US"),
            entry({ title: "T2", slug: "t2" }, "en-US"),
          ],
        ],
      ]),
      pathFor: (e) => `/en-us/posts/${e.data["slug"]}`,
    });
    expect(out).toContain("# Blog");
    expect(out).toContain("## posts");
    expect(out).toContain("[T1](https://example.com/en-us/posts/t1.md)");
    expect(out).not.toContain("T2");
  });

  it("omits Locale: line for empty-string locale", () => {
    const out = serializeLlmsTxt({
      site,
      locale: "",
      entriesByCollection: new Map(),
      pathFor: () => null,
    });
    expect(out).toBeNull();
  });
});
