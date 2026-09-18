import { describe, expect, it } from "vitest";
import { createMantleWeb } from "../src/index.js";
import { DatabaseEntryRepository } from "../../mantle-runtime/src/infrastructure/persistence/DatabaseEntryRepository.js";
import { TemplateRegistry } from "../src/model/TemplateRegistry.js";
import type { MediaAsset } from "@aotter/mantle-runtime";
import type { MediaAssetResolver } from "../src/index.js";
import { InMemoryDatabase } from "../../mantle-runtime/test/fakes/database.js";
import type { SchemaManifest, SiteConfig } from "@aotter/mantle-spec";
import { CANONICAL_MIGRATIONS } from "../../mantle-runtime/src/infrastructure/boot/index.js";
import { schemaTableMigrations } from "../../mantle-runtime/src/infrastructure/storage/SqliteSchemaTables.js";

const site: SiteConfig = {
  title: "Blog",
  description: "",
  origin: "https://example.com",
  locales: [],
  canonicalLocale: null,
  brand: "Blog",
  media: { purposes: [] },
};

const posts: SchemaManifest = {
  apiVersion: "cms.mantle.aotter.net/v1", kind: "Schema", metadata: { name: "posts" },
  spec: { title: "Posts", schema: { type: "object", properties: {
    title: { type: "string" }, slug: { type: "string" }, locale: { type: "string" }, coverAssetId: { type: "string" },
  } } },
};

async function seedEntry(
  db: InMemoryDatabase,
  args: { id: string; data: Record<string, unknown>; updated_at?: number },
): Promise<DatabaseEntryRepository> {
  await db.migrations.runAll(CANONICAL_MIGRATIONS);
  await db.migrations.runAll(schemaTableMigrations([posts]));
  const repository = new DatabaseEntryRepository(db, new Map([["posts", posts]]));
  await repository.create({
    id: args.id,
    collection: "posts",
    status: "published",
    version: 1,
    data: args.data,
    authorId: null,
    now: args.updated_at ?? 2,
  });
  return repository;
}

describe("RenderEntryLiveUseCase", () => {
  it("injects configured tracking scripts into rendered entry HTML", async () => {
    const db = new InMemoryDatabase();
    const repository = await seedEntry(db, { id: "p1", data: { title: "Hi", slug: "hi", locale: "en" } });
    const templates = new TemplateRegistry();
    templates.registerEntryTemplate(
      "posts",
      ({ entry }) => `<html><head><title>${entry.data["title"]}</title></head><body>Hi</body></html>`,
    );
    const usecase = createMantleWeb({
      entries: repository,
      schemas: new Map([["posts", posts]]),
    }, { templates, mediaAssets: new MemoryMediaAssets() }).renderEntryLive;

    const html = await usecase.execute({
      collection: "posts",
      slug: "hi",
      locale: "en",
      site: {
        ...site,
        ga4MeasurementId: "G-ABC1234567",
        facebookPixelId: "123456789012345",
      },
    });

    expect(html).toContain("https://www.googletagmanager.com/gtag/js?id=G-ABC1234567");
    expect(html).toContain("gtag('config','G-ABC1234567')");
    expect(html).toContain("fbq('init','123456789012345')");
    expect(html).toContain("https://www.facebook.com/tr?id=123456789012345");
    expect(html?.indexOf("googletagmanager.com")).toBeLessThan(html?.indexOf("</head>") ?? 0);
  });

  it("threads resolved media assets into live entry templates", async () => {
    const db = new InMemoryDatabase();
    const repository = await seedEntry(db, {
      id: "p1",
      data: { title: "Hi", slug: "hi", locale: "en", coverAssetId: "cover" },
    });
    const templates = new TemplateRegistry();
    let renderedAssets: ReadonlyMap<string, MediaAsset> | undefined;
    templates.registerEntryTemplate("posts", (ctx) => {
      renderedAssets = ctx.mediaAssets;
      return `<h1>${ctx.mediaAssets?.get("cover")?.id ?? "missing"}</h1>`;
    });
    const repo = new MemoryMediaAssets([asset("cover")]);

    const usecase = createMantleWeb({
      entries: repository,
      schemas: new Map([["posts", posts]]),
    }, { templates, mediaAssets: repo }).renderEntryLive;

    const html = await usecase.execute({
      collection: "posts",
      slug: "hi",
      locale: "en",
      site,
    });

    expect(html).toContain("<h1>cover</h1>");
    expect(renderedAssets?.get("cover")?.id).toBe("cover");
    expect(repo.lookups).toEqual([["cover"]]);
  });

});

function asset(id: string): MediaAsset {
  return {
    id,
    variants: [
      {
        role: "primary",
        mimeType: "image/jpeg",
        storageKey: `${id}.jpg`,
        publicUrl: `https://example.com/${id}.jpg`,
        byteSize: 1,
      },
    ],
    createdAt: 1,
  };
}

class MemoryMediaAssets implements MediaAssetResolver {
  readonly lookups: string[][] = [];
  private readonly assets: ReadonlyMap<string, MediaAsset>;

  constructor(assets: readonly MediaAsset[] = []) {
    this.assets = new Map(assets.map((item) => [item.id, item]));
  }

  async resolveMany(ids: readonly string[]): Promise<ReadonlyMap<string, MediaAsset>> {
    this.lookups.push([...ids]);
    const out = new Map<string, MediaAsset>();
    for (const id of ids) {
      const found = this.assets.get(id);
      if (found) out.set(id, found);
    }
    return out;
  }

}
