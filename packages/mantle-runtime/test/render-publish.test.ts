import { describe, expect, it } from "vitest";
import { RenderEntryLiveUseCase } from "../src/usecase/render/RenderEntryLiveUseCase.js";
import { DatabaseEntryRepository } from "../src/infrastructure/persistence/DatabaseEntryRepository.js";
import { TemplateRegistry } from "../src/domain/model/TemplateRegistry.js";
import type { MediaAssetRepository } from "../src/domain/port/MediaAssetRepository.js";
import type { MediaAsset } from "../src/domain/port/MediaStorage.js";
import { InMemoryDatabase } from "./fakes/database.js";
import type { SiteConfig } from "@aotter/mantle-spec";

const site: SiteConfig = {
  title: "Blog",
  description: "",
  origin: "https://example.com",
  locales: [],
  canonicalLocale: null,
  brand: "Blog",
  media: { purposes: [] },
};

function seedEntry(
  db: InMemoryDatabase,
  args: { id: string; data: Record<string, unknown>; updated_at?: number },
): void {
  db.entries.set(args.id, {
    id: args.id,
    collection: "posts",
    status: "published",
    version: 1,
    data: JSON.stringify(args.data),
    author_id: null,
    created_at: 1,
    updated_at: args.updated_at ?? 2,
  });
}

describe("RenderEntryLiveUseCase", () => {
  it("injects configured tracking scripts into rendered entry HTML", async () => {
    const db = new InMemoryDatabase();
    seedEntry(db, { id: "p1", data: { title: "Hi", slug: "hi", locale: "en" } });
    const templates = new TemplateRegistry();
    templates.registerEntryTemplate(
      "posts",
      ({ entry }) => `<html><head><title>${entry.data["title"]}</title></head><body>Hi</body></html>`,
    );
    const usecase = new RenderEntryLiveUseCase(
      new DatabaseEntryRepository(db),
      templates,
      null,
      { execute: async () => ({ title: "", description: "" }) },
      new Map(),
      new MemoryMediaAssets(),
    );

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
    seedEntry(db, {
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

    const usecase = new RenderEntryLiveUseCase(
      new DatabaseEntryRepository(db),
      templates,
      null,
      { execute: async () => ({ title: "", description: "" }) },
      new Map(),
      repo,
    );

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

class MemoryMediaAssets implements MediaAssetRepository {
  readonly lookups: string[][] = [];
  private readonly assets: ReadonlyMap<string, MediaAsset>;

  constructor(assets: readonly MediaAsset[] = []) {
    this.assets = new Map(assets.map((item) => [item.id, item]));
  }

  async findById(id: string): Promise<MediaAsset | null> {
    return this.assets.get(id) ?? null;
  }

  async findManyByIds(ids: readonly string[]): Promise<ReadonlyMap<string, MediaAsset>> {
    this.lookups.push([...ids]);
    const out = new Map<string, MediaAsset>();
    for (const id of ids) {
      const found = this.assets.get(id);
      if (found) out.set(id, found);
    }
    return out;
  }

  async save(): Promise<void> {}

  async delete(): Promise<void> {}

  async list(
    _args: Parameters<MediaAssetRepository["list"]>[0],
  ): ReturnType<MediaAssetRepository["list"]> {
    return { rows: [...this.assets.values()] };
  }
}
