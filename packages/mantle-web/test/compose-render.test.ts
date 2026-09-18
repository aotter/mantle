import { describe, expect, it } from "vitest";
import type { SchemaManifest, SiteConfig } from "@aotter/mantle-spec";
import { DatabaseEntryRepository } from "../../mantle-runtime/src/infrastructure/persistence/DatabaseEntryRepository.js";
import { ComposeLlmsTxtUseCase } from "../src/usecase/ComposeLlmsTxtUseCase.js";
import { ComposeSitemapUseCase } from "../src/usecase/ComposeSitemapUseCase.js";
import { createPublicPathResolver } from "../src/service/PublicPathResolver.js";
import { InMemoryDatabase } from "../../mantle-runtime/test/fakes/database.js";
import { CANONICAL_MIGRATIONS } from "../../mantle-runtime/src/infrastructure/boot/index.js";
import { schemaTableMigrations } from "../../mantle-runtime/src/infrastructure/storage/SqliteSchemaTables.js";

const site: SiteConfig = {
  title: "Blog",
  description: "Reference starter",
  origin: "https://example.com",
  locales: ["en", "zh-TW"],
  canonicalLocale: "en",
  brand: "Blog",
};
const paths = createPublicPathResolver({
  collectionRoutes: {
    posts: { segment: "posts" },
    guides: { segment: "guides" },
  },
});

const collections = ["posts", "guides", "post-translations", "internal"] as const;
const schemas = new Map<string, SchemaManifest>(collections.map((name) => [name, {
  apiVersion: "cms.mantle.aotter.net/v1", kind: "Schema", metadata: { name },
  spec: { title: name, schema: { type: "object", properties: {
    locale: { type: ["string", "null"] }, slug: { type: "string" },
    title: { type: "string" }, content: { type: "string" },
  } } },
}]));

async function harness(): Promise<{ db: InMemoryDatabase; repository: DatabaseEntryRepository }> {
  const db = new InMemoryDatabase();
  await db.migrations.runAll(CANONICAL_MIGRATIONS);
  await db.migrations.runAll(schemaTableMigrations(schemas.values()));
  return { db, repository: new DatabaseEntryRepository(db, schemas) };
}

async function seedPublished(
  repository: DatabaseEntryRepository,
  args: {
    id: string;
    collection: string;
    locale?: string;
    data: Record<string, unknown>;
    updatedAt?: number;
  },
): Promise<void> {
  await repository.create({
    id: args.id,
    collection: args.collection,
    status: "published",
    version: 1,
    data: { ...args.data, ...(args.locale ? { locale: args.locale } : {}) },
    authorId: null,
    now: args.updatedAt ?? 2,
  });
}

describe("ComposeLlmsTxtUseCase", () => {
  it("groups published entries by collection at the requested locale", async () => {
    const { repository } = await harness();
    await seedPublished(repository, {
      id: "p1",
      collection: "posts",
      locale: "en",
      data: { slug: "hello", title: "Hello", content: "Body" },
    });
    await seedPublished(repository, {
      id: "p2",
      collection: "posts",
      locale: "zh-TW",
      data: { slug: "ni-hao", title: "你好", content: "正文" },
    });
    const out = await new ComposeLlmsTxtUseCase(repository, paths).execute({ site, locale: "en", collections });
    expect(out?.body).toContain("[Hello]");
    expect(out?.body).not.toContain("[你好]");
  });

  it("locale: null returns only non-localized entries (matches publish semantics)", async () => {
    const { repository } = await harness();
    await seedPublished(repository, {
      id: "p1",
      collection: "posts",
      locale: "en",
      data: { slug: "hello", title: "Hello", content: "Body" },
    });
    await seedPublished(repository, {
      id: "g1",
      collection: "guides",
      data: { slug: "intro", title: "Intro", content: "Welcome" },
    });
    const out = await new ComposeLlmsTxtUseCase(repository, paths).execute({ site, locale: null, collections });
    expect(out?.body).toContain("[Intro]");
    expect(out?.body).not.toContain("[Hello]");
  });
});

describe("ComposeSitemapUseCase", () => {
  it("uses entryPublicPath by default", async () => {
    const { repository } = await harness();
    await seedPublished(repository, {
      id: "p1",
      collection: "posts",
      locale: "en",
      data: { slug: "hello" },
    });
    const out = await new ComposeSitemapUseCase(repository).execute({ site, collections });
    expect(out?.body).toMatch(/<\?xml version="1\.0"/);
    expect(out?.body).toContain("<urlset");
    expect(out?.body).toContain("<loc>https://example.com/en/posts/hello</loc>");
    expect(out?.body).toContain("<lastmod>");
  });

  it("custom pathFor remaps storage shape → public route shape", async () => {
    const { repository } = await harness();
    await seedPublished(repository, {
      id: "p1",
      collection: "post-translations",
      locale: "en",
      data: { slug: "hello" },
    });
    await seedPublished(repository, {
      id: "p2",
      collection: "post-translations",
      locale: "zh-TW",
      data: { slug: "hello" },
    });
    const out = await new ComposeSitemapUseCase(repository).execute({
      site,
      collections,
      pathFor: (e) => {
        const slug = (e.data as { slug?: string }).slug;
        const locale = e.locale?.toLowerCase();
        if (e.collection === "post-translations" && slug && locale) {
          return `/${locale}/posts/${slug}`;
        }
        return null;
      },
    });
    expect(out?.body).toContain("<loc>https://example.com/en/posts/hello</loc>");
    expect(out?.body).toContain("<loc>https://example.com/zh-tw/posts/hello</loc>");
  });

  it("pathFor returning null skips the entry", async () => {
    const { repository } = await harness();
    await seedPublished(repository, {
      id: "p1",
      collection: "posts",
      locale: "en",
      data: { slug: "hello" },
    });
    await seedPublished(repository, {
      id: "draft",
      collection: "internal",
      data: { slug: "skip" },
    });
    const out = await new ComposeSitemapUseCase(repository).execute({
      site,
      collections,
      pathFor: (e) => (e.collection === "internal" ? null : `/${e.collection}/${(e.data as { slug?: string }).slug}`),
    });
    expect(out?.body).toContain("/posts/hello");
    expect(out?.body).not.toContain("/internal/");
  });

  it("maxUrls caps the SQL read (not just the JS array)", async () => {
    const { repository } = await harness();
    for (let i = 0; i < 8; i++) {
      await seedPublished(repository, {
        id: `p${i}`,
        collection: "posts",
        locale: "en",
        data: { slug: `s${i}` },
      });
    }
    const out = await new ComposeSitemapUseCase(repository).execute({ site, collections, maxUrls: 3 });
    const urlCount = (out.body.match(/<url>/g) ?? []).length;
    expect(urlCount).toBe(3);
  });

  it("rejects custom sitemap expansion beyond protocol limits instead of dropping URLs", async () => {
    const { repository } = await harness();
    await seedPublished(repository, { id: "p1", collection: "posts", data: { slug: "hello" } });
    const sitemap = new ComposeSitemapUseCase(repository);
    await expect(sitemap.execute({ site, collections, pathFor: () => Array.from({ length: 50_001 }, (_, i) => `/item-${i}`) }))
      .rejects.toThrow("50,000 URLs");
    await expect(sitemap.index({ site, collections }, () => "/" + "x".repeat(50 * 1024 * 1024)))
      .rejects.toThrow("50 MiB");
  });

  it("XML-escapes ampersands in origins / paths", async () => {
    const { repository } = await harness();
    await seedPublished(repository, {
      id: "p1",
      collection: "posts",
      locale: "en",
      data: { slug: "a-and-b" },
    });
    const out = await new ComposeSitemapUseCase(repository).execute({
      site: { ...site, origin: "https://x.com?a=1&b=2" },
      collections,
    });
    expect(out?.body).toContain("&amp;");
    expect(out?.body).not.toMatch(/&[^a-z#]/);
  });
});
