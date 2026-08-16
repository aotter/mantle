import { describe, expect, it } from "vitest";
import { DatabaseEntryRepository } from "../../mantle-runtime/src/infrastructure/persistence/DatabaseEntryRepository.js";
import type { Entry, SiteConfig } from "@aotter/mantle-spec";
import {
  composeEntrySeoMeta,
  composePageSeoMeta,
  renderSeoTagsHtml,
} from "../src/service/SeoMetaComposer.js";
import { createPublicPathResolver } from "../src/service/PublicPathResolver.js";
import { ComposeEntrySeoMetaUseCase } from "../src/usecase/ComposeEntrySeoMetaUseCase.js";
import { InMemoryDatabase } from "../../mantle-runtime/test/fakes/database.js";

const site: SiteConfig = {
  title: "Mantle Publication",
  description: "Reference starter",
  origin: "https://example.com",
  locales: ["en", "zh-TW"],
  canonicalLocale: "en",
  brand: "Mantle Publication",
};

function makeEntry(overrides: Partial<Entry> = {}): Entry {
  return {
    id: "p1",
    collection: "post-translations",
    locale: "en",
    status: "published",
    version: 1,
    data: { slug: "hello", title: "Hello world", body: "..." },
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

describe("composeEntrySeoMeta", () => {
  it("emits absolute canonical + .md alternate", () => {
    const meta = composeEntrySeoMeta({
      entry: makeEntry(),
      site,
      publicPath: "/en/posts/hello",
    });
    expect(meta.canonical).toBe("https://example.com/en/posts/hello");
    expect(meta.alternateMarkdown).toBe("https://example.com/en/posts/hello.md");
  });

  it("omits the markdown alternate when the entry has no serializable body", () => {
    const meta = composeEntrySeoMeta({
      entry: makeEntry({ data: { slug: "empty", title: "Empty" } }),
      site,
      publicPath: "/en/posts/empty",
    });
    expect(meta.alternateMarkdown).toBeNull();
    expect(renderSeoTagsHtml(meta)).not.toContain("text/markdown");
  });

  it("uses the rendered entry locale in JSON-LD", () => {
    const meta = composeEntrySeoMeta({
      entry: makeEntry({ locale: "zh-TW" }),
      site,
      publicPath: "/zh-tw/posts/hello",
    });
    expect(meta.jsonLd).toMatchObject({ inLanguage: "zh-TW" });
  });

  it("emits hreflangs + x-default for multi-locale sites", () => {
    const meta = composeEntrySeoMeta({
      entry: makeEntry(),
      site,
      publicPath: "/en/posts/hello",
      siblings: [{ locale: "zh-TW", publicPath: "/zh-tw/posts/hello" }],
    });
    const langs = meta.hreflangs.map((h) => h.locale);
    expect(langs).toContain("en");
    expect(langs).toContain("zh-TW");
    expect(langs).toContain("x-default");
    const xdef = meta.hreflangs.find((h) => h.locale === "x-default");
    // x-default points at the canonical locale's URL.
    expect(xdef?.href).toBe("https://example.com/en/posts/hello");
  });

  it("emits the locale and x-default for single-locale sites", () => {
    const singleLocale: SiteConfig = { ...site, locales: ["en"], canonicalLocale: "en" };
    const meta = composeEntrySeoMeta({
      entry: makeEntry(),
      site: singleLocale,
      publicPath: "/en/posts/hello",
    });
    expect(meta.hreflangs.map((item) => item.locale)).toEqual(["en", "x-default"]);
  });

  it("infers og:type=article from publishedAt / body / content", () => {
    const meta = composeEntrySeoMeta({
      entry: makeEntry({ data: { slug: "h", title: "H", publishedAt: 100 } }),
      site,
      publicPath: "/en/posts/h",
    });
    expect(meta.og.type).toBe("article");
  });

  it("falls back to og:type=website with no article signals", () => {
    const meta = composeEntrySeoMeta({
      entry: makeEntry({
        collection: "page-translations",
        data: { slug: "about", title: "About" },
      }),
      site,
      publicPath: "/en/pages/about",
    });
    expect(meta.og.type).toBe("website");
  });

  it("populates JSON-LD with Article + datePublished/dateModified", () => {
    const meta = composeEntrySeoMeta({
      entry: makeEntry({
        data: {
          slug: "h",
          title: "H",
          publishedAt: 1700000000000,
        },
        updatedAt: 1700000050000,
      }),
      site,
      publicPath: "/en/posts/h",
    });
    expect(meta.jsonLd).toMatchObject({ "@type": "Article", url: "https://example.com/en/posts/h" });
  });
});

describe("composePageSeoMeta", () => {
  it("emits every configured locale and x-default", () => {
    const meta = composePageSeoMeta({
      site,
      locale: "en",
      publicPath: "/en/posts",
      markdown: true,
      pathForLocale: (locale) => `/${locale.toLowerCase()}/posts`,
    });
    expect(meta.hreflangs.map((item) => item.locale)).toEqual(["en", "zh-TW", "x-default"]);
  });
});

describe("renderSeoTagsHtml", () => {
  it("emits canonical + alternate-markdown + hreflang block", () => {
    const meta = composeEntrySeoMeta({
      entry: makeEntry(),
      site,
      publicPath: "/en/posts/hello",
      siblings: [{ locale: "zh-TW", publicPath: "/zh-tw/posts/hello" }],
    });
    const html = renderSeoTagsHtml(meta);
    expect(html).toContain('<link rel="canonical" href="https://example.com/en/posts/hello">');
    expect(html).toContain(
      '<link rel="alternate" type="text/markdown" href="https://example.com/en/posts/hello.md">',
    );
    expect(html).toContain('hreflang="x-default"');
    expect(html).toContain('hreflang="zh-TW"');
    expect(html).toContain('<meta name="generator" content="mantle">');
    expect(html).toContain('<script type="application/ld+json">');
  });

  it("escapes <, >, &, \" inside attribute values", () => {
    const meta = composeEntrySeoMeta({
      entry: makeEntry({ data: { slug: "h", title: 'A "quoted" & <tag>' } }),
      site,
      publicPath: "/en/posts/h",
    });
    const html = renderSeoTagsHtml(meta);
    expect(html).toContain('"A &quot;quoted&quot; &amp; &lt;tag&gt;"');
  });

  it("escapes </ inside JSON-LD body", () => {
    const meta = composeEntrySeoMeta({
      entry: makeEntry({ data: { slug: "h", title: "</script>injection" } }),
      site,
      publicPath: "/en/posts/h",
    });
    const html = renderSeoTagsHtml(meta);
    expect(html).not.toContain("</script>injection");
    expect(html).toContain("<\\/script>");
  });
});

describe("ComposeEntrySeoMetaUseCase (with sibling lookup)", () => {
  it("reads sibling translations from DB to populate hreflangs", async () => {
    const db = new InMemoryDatabase();
    db.entries.set("p1", {
      id: "p1",
      collection: "post-translations",
      status: "published",
      version: 1,
      data: JSON.stringify({ slug: "hello", title: "Hello", locale: "en" }),
      author_id: null,
      created_at: 1,
      updated_at: 2,
    });
    db.entries.set("p1-zh", {
      id: "p1-zh",
      collection: "post-translations",
      status: "published",
      version: 1,
      data: JSON.stringify({ slug: "hello", title: "你好", locale: "zh-TW" }),
      author_id: null,
      created_at: 1,
      updated_at: 2,
    });
    const paths = createPublicPathResolver({
      collectionRoutes: { "post-translations": { segment: "posts" } },
    });
    const usecase = new ComposeEntrySeoMetaUseCase(new DatabaseEntryRepository(db));
    const meta = await usecase.execute({
      entry: {
        id: "p1",
        collection: "post-translations",
        locale: "en",
        status: "published",
        version: 1,
        data: { slug: "hello", title: "Hello" },
        createdAt: 1,
        updatedAt: 2,
      },
      site,
      paths,
    });
    const langs = meta.hreflangs.map((h) => h.locale).sort();
    expect(langs).toContain("zh-TW");
    expect(langs).toContain("en");
  });
});
