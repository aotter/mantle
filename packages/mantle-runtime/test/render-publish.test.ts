import { describe, expect, it } from "vitest";
import { HtmlPublishOrchestrator } from "../src/infrastructure/render/HtmlPublishOrchestrator.js";
import { ComposeEntrySeoMetaUseCase } from "../src/usecase/render/ComposeEntrySeoMetaUseCase.js";
import { ComposeLlmsTxtUseCase } from "../src/usecase/render/ComposeLlmsTxtUseCase.js";
import { RenderEntryLiveUseCase } from "../src/usecase/render/RenderEntryLiveUseCase.js";
import {
  entryHtmlKey,
  entryMarkdownKey,
  listHtmlKey,
  llmsTxtKey,
} from "../src/domain/service/PublishKeys.js";
import { TemplateRegistry } from "../src/domain/model/TemplateRegistry.js";
import type { MediaAssetRepository } from "../src/domain/port/MediaAssetRepository.js";
import type { MediaAsset } from "../src/domain/port/MediaStorage.js";
import { InMemoryDatabase } from "./fakes/database.js";
import { InMemoryKv } from "./fakes/kv.js";
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

describe("HtmlPublishOrchestrator", () => {
  it("injects configured tracking scripts into rendered entry HTML", async () => {
    const db = new InMemoryDatabase();
    seedEntry(db, { id: "p1", data: { title: "Hi", slug: "hi", locale: "en" } });
    const templates = new TemplateRegistry();
    templates.registerEntryTemplate(
      "posts",
      ({ entry }) => `<html><head><title>${entry.data["title"]}</title></head><body>Hi</body></html>`,
    );
    const usecase = new RenderEntryLiveUseCase(
      db,
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
      db,
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

  it("writes entry HTML, .md, list HTML, and llms.txt to KV", async () => {
    const db = new InMemoryDatabase();
    const kv = new InMemoryKv();
    seedEntry(db, { id: "p1", data: { title: "Hi", slug: "hi", content: "Hello." } });
    const templates = new TemplateRegistry();
    templates.registerEntryTemplate(
      "posts",
      ({ entry }) => `<h1>${entry.data["title"] as string}</h1>`,
    );
    templates.registerListTemplate("posts", ({ entries }) => `<ul>${entries.length}</ul>`);

    const orchestrator = new HtmlPublishOrchestrator(db, kv, null, new ComposeEntrySeoMetaUseCase(db), new ComposeLlmsTxtUseCase(db), new Map());
    await orchestrator.publish({ entryId: "p1", site, templates });

    const snap = kv._snapshot();
    expect(
      snap.get(entryHtmlKey({ id: "p1", collection: "posts", status: "published", version: 1, data: { slug: "hi" }, createdAt: 1, updatedAt: 2 })),
    ).toContain("<h1>Hi</h1>");
    const md = snap.get(
      entryMarkdownKey({
        id: "p1", collection: "posts", status: "published", version: 1, data: { slug: "hi" }, createdAt: 1, updatedAt: 2,
      }),
    );
    expect(md).toContain("# Hi");
    expect(md).toContain("Hello.");
    expect(snap.get(listHtmlKey("posts", ""))).toContain("<ul>1</ul>");
    expect(snap.get(llmsTxtKey(""))).toContain("[Hi](https://example.com/posts/hi.md)");
  });

  it("throws NOT_FOUND for unknown entry id", async () => {
    const db = new InMemoryDatabase();
    const kv = new InMemoryKv();
    const orchestrator = new HtmlPublishOrchestrator(db, kv, null, new ComposeEntrySeoMetaUseCase(db), new ComposeLlmsTxtUseCase(db), new Map());
    await expect(
      orchestrator.publish({
        entryId: "ghost",
        site,
        templates: new TemplateRegistry(),
      }),
    ).rejects.toMatchObject({ diagnostic: { code: "NOT_FOUND" } });
  });

  it("unpublish removes entry blobs and rewrites derived list/llms caches", async () => {
    const db = new InMemoryDatabase();
    const kv = new InMemoryKv();
    seedEntry(db, { id: "p1", data: { title: "Hi", slug: "hi", content: "Hello." } });
    const templates = new TemplateRegistry();
    templates.registerEntryTemplate("posts", ({ entry }) => `<h1>${entry.data["title"] as string}</h1>`);
    templates.registerListTemplate("posts", ({ entries }) => `<ul>${entries.length}</ul>`);

    const orchestrator = new HtmlPublishOrchestrator(db, kv, null, new ComposeEntrySeoMetaUseCase(db), new ComposeLlmsTxtUseCase(db), new Map());
    await orchestrator.publish({ entryId: "p1", site, templates });
    db.entries.set("p1", {
      ...db.entries.get("p1")!,
      status: "draft",
      version: 2,
      updated_at: 3,
    });
    await orchestrator.unpublish({ entryId: "p1", site, templates });

    const snap = kv._snapshot();
    expect(
      snap.get(entryHtmlKey({ id: "p1", collection: "posts", status: "draft", version: 2, data: { slug: "hi" }, createdAt: 1, updatedAt: 3 })),
    ).toBeUndefined();
    expect(
      snap.get(entryMarkdownKey({ id: "p1", collection: "posts", status: "draft", version: 2, data: { slug: "hi" }, createdAt: 1, updatedAt: 3 })),
    ).toBeUndefined();
    expect(snap.get(listHtmlKey("posts", ""))).toContain("<ul>0</ul>");
    expect(snap.get(llmsTxtKey(""))).not.toContain("Hi");
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
}
