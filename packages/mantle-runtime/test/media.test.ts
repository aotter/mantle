import { describe, it, expect } from "vitest";
import type { MediaAsset, MediaStorage, MediaVariant } from "../src/domain/port/MediaStorage.js";
import type { MediaAssetRepository } from "../src/domain/port/MediaAssetRepository.js";
import {
  AdminMediaLibraryUseCase,
  CommitMediaUploadUseCase,
  CreateMediaUploadUseCase,
  UploadMediaVariantUseCase,
} from "../src/usecase/media/index.js";
import { DatabaseMediaAssetRepository } from "../src/infrastructure/persistence/DatabaseMediaAssetRepository.js";
import { InMemoryKv } from "./fakes/kv.js";
import { InMemoryDatabase } from "./fakes/database.js";
import { InMemorySiteConfigRepository } from "./fakes/site-config.js";

const DEFAULT_PURPOSES = ["post-cover", "product-cover"] as const;

class FakeMediaStorage implements MediaStorage {
  public createCalls: Parameters<MediaStorage["createUpload"]>[0][] = [];
  public commitCalls: Parameters<MediaStorage["commitUpload"]>[0][] = [];
  public putVariantCalls: Parameters<MediaStorage["putVariantBytes"]>[0][] = [];
  public deleteCalls: Parameters<MediaStorage["deleteObject"]>[0][] = [];
  public failDelete = false;

  async createUpload(args: Parameters<MediaStorage["createUpload"]>[0]) {
    this.createCalls.push(args);
    return {
      uploadGroupId: args.uploadGroupId,
      capabilities: args.variants.map((v) => ({
        mimeType: v.mimeType,
        role: v.role,
        method: "PUT" as const,
        uploadUrl: `https://r2.example/${args.uploadGroupId}/${v.role}?signed=1`,
        storageKey: `${args.purpose}/${args.uploadGroupId}/${v.role}`,
        publicUrl: `https://media.example/${args.purpose}/${args.uploadGroupId}/${v.role}`,
        requiredHeaders: { "Content-Type": v.mimeType },
      })),
      expiresAt: args.expiresAt,
    };
  }

  async commitUpload(args: Parameters<MediaStorage["commitUpload"]>[0]) {
    this.commitCalls.push(args);
    const variants: MediaVariant[] = args.variants.map((v) => ({
      mimeType: v.mimeType,
      publicUrl: `https://media.example/${v.storageKey}`,
      storageKey: v.storageKey,
      byteSize: 1024,
      role: v.role,
    }));
    return {
      id: args.uploadGroupId,
      variants,
      alt: args.alt,
      caption: args.caption,
      createdAt: args.now,
    };
  }

  async getPublicUrl(args: Parameters<MediaStorage["getPublicUrl"]>[0]) {
    return `https://media.example/${args.storageKey}`;
  }

  async deleteObject(args: Parameters<MediaStorage["deleteObject"]>[0]): Promise<void> {
    this.deleteCalls.push(args);
    if (this.failDelete) throw new Error("delete failed");
  }

  async putVariantBytes(args: Parameters<MediaStorage["putVariantBytes"]>[0]) {
    this.putVariantCalls.push(args);
    return {
      storageKey: `${args.purpose}/${args.uploadGroupId}/${args.role}`,
    };
  }
}

class InMemoryMediaAssetRepository implements MediaAssetRepository {
  public saved: MediaAsset[] = [];
  private store = new Map<string, MediaAsset>();

  async findById(id: string): Promise<MediaAsset | null> {
    return this.store.get(id) ?? null;
  }

  async findManyByIds(ids: readonly string[]): Promise<ReadonlyMap<string, MediaAsset>> {
    const out = new Map<string, MediaAsset>();
    for (const id of ids) {
      const a = this.store.get(id);
      if (a) out.set(id, a);
    }
    return out;
  }

  async list(): Promise<{ items: MediaAsset[]; nextCursor?: string }> {
    return { items: [...this.store.values()] };
  }

  async update(id: string, values: { alt?: string; caption?: string }): Promise<MediaAsset | null> {
    const existing = this.store.get(id);
    if (!existing) return null;
    const next = { ...existing, alt: values.alt ?? existing.alt, caption: values.caption ?? existing.caption };
    this.store.set(id, next);
    return next;
  }

  async save(asset: MediaAsset): Promise<void> {
    this.saved.push(asset);
    this.store.set(asset.id, asset);
  }

  async delete(id: string): Promise<void> {
    this.store.delete(id);
  }
}

const FROZEN_NOW = 1_700_000_000_000;
const fakeClock = { now: () => FROZEN_NOW };

class CountingIdGenerator {
  private n = 0;
  next(): string {
    this.n += 1;
    return `asset-${this.n}`;
  }
}

const THREE_VARIANTS = [
  { mimeType: "image/avif", byteSize: 60_000, role: "alternate" as const },
  { mimeType: "image/webp", byteSize: 80_000, role: "alternate" as const },
  { mimeType: "image/jpeg", byteSize: 110_000, role: "primary" as const },
];

function makeCreateUseCase(opts: {
  storage: FakeMediaStorage;
  kv: InMemoryKv;
  site: InMemorySiteConfigRepository;
  idgen?: CountingIdGenerator;
  allowSvg?: boolean;
}): CreateMediaUploadUseCase {
  return new CreateMediaUploadUseCase(
    opts.storage,
    opts.kv,
    fakeClock,
    opts.idgen ?? new CountingIdGenerator(),
    opts.site,
    { allowSvg: opts.allowSvg ?? false },
  );
}

describe("CreateMediaUploadUseCase (#272 multi-variant)", () => {
  it("rejects undeclared purpose with MEDIA_PURPOSE_REJECTED (fail-closed)", async () => {
    const storage = new FakeMediaStorage();
    const kv = new InMemoryKv();
    const site = new InMemorySiteConfigRepository(DEFAULT_PURPOSES);
    const useCase = makeCreateUseCase({ storage, kv, site });
    await expect(
      useCase.execute({
        filename: "x.png",
        purpose: "not-declared",
        variants: THREE_VARIANTS,
      }),
    ).rejects.toMatchObject({ diagnostic: { code: "MEDIA_PURPOSE_REJECTED" } });
  });

  it("rejects every purpose when none declared (fail-closed)", async () => {
    const storage = new FakeMediaStorage();
    const kv = new InMemoryKv();
    const site = new InMemorySiteConfigRepository([]);
    const useCase = makeCreateUseCase({ storage, kv, site });
    await expect(
      useCase.execute({
        filename: "x.png",
        purpose: "post-cover",
        variants: THREE_VARIANTS,
      }),
    ).rejects.toMatchObject({ diagnostic: { code: "MEDIA_PURPOSE_REJECTED" } });
  });

  it("rejects when variants don't cover the required mime set", async () => {
    const storage = new FakeMediaStorage();
    const kv = new InMemoryKv();
    const site = new InMemorySiteConfigRepository(DEFAULT_PURPOSES);
    const useCase = makeCreateUseCase({ storage, kv, site });
    await expect(
      useCase.execute({
        filename: "x.png",
        purpose: "post-cover",
        variants: [
          { mimeType: "image/jpeg", byteSize: 100, role: "primary" },
          // missing webp + avif
        ],
      }),
    ).rejects.toMatchObject({ diagnostic: { code: "MEDIA_VARIANTS_INCOMPLETE" } });
  });

  it("rejects when no primary variant is declared", async () => {
    const storage = new FakeMediaStorage();
    const kv = new InMemoryKv();
    const site = new InMemorySiteConfigRepository(DEFAULT_PURPOSES);
    const useCase = makeCreateUseCase({ storage, kv, site });
    await expect(
      useCase.execute({
        filename: "x.png",
        purpose: "post-cover",
        variants: THREE_VARIANTS.map((v) => ({ ...v, role: "alternate" as const })),
      }),
    ).rejects.toMatchObject({ diagnostic: { code: "MEDIA_VARIANTS_INCOMPLETE" } });
  });

  it("rejects when two variants share role='primary' (storage-key collision)", async () => {
    const storage = new FakeMediaStorage();
    const kv = new InMemoryKv();
    const site = new InMemorySiteConfigRepository(DEFAULT_PURPOSES);
    const useCase = makeCreateUseCase({ storage, kv, site });
    await expect(
      useCase.execute({
        filename: "x.png",
        purpose: "post-cover",
        variants: [
          { mimeType: "image/avif", byteSize: 60_000, role: "primary" },
          { mimeType: "image/webp", byteSize: 80_000, role: "alternate" },
          { mimeType: "image/jpeg", byteSize: 110_000, role: "primary" },
        ],
      }),
    ).rejects.toMatchObject({ diagnostic: { code: "MEDIA_VARIANTS_INCOMPLETE" } });
    expect(storage.createCalls).toHaveLength(0);
  });

  it("rejects when two variants share the same (mimeType, role) pair", async () => {
    const storage = new FakeMediaStorage();
    const kv = new InMemoryKv();
    const site = new InMemorySiteConfigRepository(DEFAULT_PURPOSES);
    const useCase = makeCreateUseCase({ storage, kv, site });
    await expect(
      useCase.execute({
        filename: "x.png",
        purpose: "post-cover",
        variants: [
          { mimeType: "image/avif", byteSize: 60_000, role: "alternate" },
          { mimeType: "image/avif", byteSize: 50_000, role: "alternate" },
          { mimeType: "image/webp", byteSize: 80_000, role: "alternate" },
          { mimeType: "image/jpeg", byteSize: 110_000, role: "primary" },
        ],
      }),
    ).rejects.toMatchObject({ diagnostic: { code: "MEDIA_VARIANTS_INCOMPLETE" } });
    expect(storage.createCalls).toHaveLength(0);
  });

  // #282 grammar: a single purpose can declare slot 0 as a comma-list
  // of acceptable mimes (jpg OR png) so per-asset the agent ships
  // whichever the source warrants. This is the load-bearing case for
  // the "PNG-primary for transparent assets, JPEG-primary for photos
  // under one purpose" motivation; SiteDefaultsValidator covers the
  // policy parsing in mantle-spec's media-mime-accept.test.ts, this
  // covers the use-case-level upload validation.
  it("accepts png-primary for a slot declared as 'image/jpg,image/png'", async () => {
    const storage = new FakeMediaStorage();
    const kv = new InMemoryKv();
    const site = new InMemorySiteConfigRepository([
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
    ]);
    const useCase = makeCreateUseCase({ storage, kv, site });
    const result = await useCase.execute({
      filename: "logo.png",
      purpose: "product-cover",
      variants: [
        { mimeType: "image/png", byteSize: 90_000, role: "primary" },
        { mimeType: "image/webp", byteSize: 70_000, role: "alternate" },
        { mimeType: "image/avif", byteSize: 50_000, role: "alternate" },
      ],
    });
    expect(result.uploadGroupId).toBeDefined();
    expect(result.capabilities).toHaveLength(3);
  });

  it("accepts jpeg-primary for the same slot 0 = 'image/jpg,image/png' policy", async () => {
    const storage = new FakeMediaStorage();
    const kv = new InMemoryKv();
    const site = new InMemorySiteConfigRepository([
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
    ]);
    const useCase = makeCreateUseCase({ storage, kv, site });
    const result = await useCase.execute({
      filename: "photo.jpg",
      purpose: "product-cover",
      variants: [
        { mimeType: "image/jpeg", byteSize: 200_000, role: "primary" },
        { mimeType: "image/webp", byteSize: 150_000, role: "alternate" },
        { mimeType: "image/avif", byteSize: 100_000, role: "alternate" },
      ],
    });
    expect(result.uploadGroupId).toBeDefined();
  });

  // Variant role is independently declared by the agent (see
  // MediaMimeAccept.ts file header + SiteConfig.ts MediaPurposePolicy
  // docstring). The use case enforces exactly one primary but does
  // NOT bind primary to slot 0 — this is required for back-compat
  // with alpha.14 fixtures like ["image/avif", "image/webp",
  // "image/jpeg"] that ship jpeg as primary despite avif filling
  // slot 0. Test guards against a future refactor silently tightening
  // primary→slot-0.
  it("accepts a primary variant whose mime is not in slot 0 (role independent of slot position)", async () => {
    const storage = new FakeMediaStorage();
    const kv = new InMemoryKv();
    const site = new InMemorySiteConfigRepository([
      {
        name: "product-cover",
        // slot 0 = avif, slot 1 = webp, slot 2 = jpeg
        required: ["image/avif", "image/webp", "image/jpeg"],
        maxBytes: {
          "image/avif": 300_000,
          "image/webp": 400_000,
          "image/jpeg": 500_000,
        },
      },
    ]);
    const useCase = makeCreateUseCase({ storage, kv, site });
    const result = await useCase.execute({
      filename: "photo.jpg",
      purpose: "product-cover",
      variants: [
        // jpeg (slot 2) carries role: "primary" — slot 0 is avif but
        // the primary role lives in slot 2. Use case must accept this.
        { mimeType: "image/avif", byteSize: 50_000, role: "alternate" },
        { mimeType: "image/webp", byteSize: 80_000, role: "alternate" },
        { mimeType: "image/jpeg", byteSize: 200_000, role: "primary" },
      ],
    });
    expect(result.uploadGroupId).toBeDefined();
    expect(result.capabilities).toHaveLength(3);
    const primaries = result.capabilities.filter((c) => c.role === "primary");
    expect(primaries).toHaveLength(1);
    expect(primaries[0]!.mimeType).toBe("image/jpeg");
  });

  it("rejects a third option that isn't in slot 0's accepted set", async () => {
    const storage = new FakeMediaStorage();
    const kv = new InMemoryKv();
    const site = new InMemorySiteConfigRepository([
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
    ]);
    const useCase = makeCreateUseCase({ storage, kv, site });
    await expect(
      useCase.execute({
        filename: "x.gif",
        purpose: "product-cover",
        variants: [
          // gif isn't in slot 0's {jpeg, png} set, and isn't in any
          // other slot either — extras get rejected.
          { mimeType: "image/gif", byteSize: 90_000, role: "primary" },
          { mimeType: "image/webp", byteSize: 70_000, role: "alternate" },
          { mimeType: "image/avif", byteSize: 50_000, role: "alternate" },
        ],
      }),
    ).rejects.toMatchObject({ diagnostic: { code: "MEDIA_VARIANTS_INCOMPLETE" } });
    expect(storage.createCalls).toHaveLength(0);
  });

  it("rejects extra mime types outside the purpose's required set", async () => {
    const storage = new FakeMediaStorage();
    const kv = new InMemoryKv();
    const site = new InMemorySiteConfigRepository([
      {
        name: "post-cover",
        required: ["image/avif", "image/webp", "image/jpeg"],
        maxBytes: {
          "image/avif": 200_000,
          "image/webp": 300_000,
          "image/jpeg": 500_000,
        },
      },
    ]);
    const useCase = makeCreateUseCase({ storage, kv, site });
    await expect(
      useCase.execute({
        filename: "x.jpg",
        purpose: "post-cover",
        variants: [
          { mimeType: "image/avif", byteSize: 60_000, role: "alternate" },
          { mimeType: "image/webp", byteSize: 80_000, role: "alternate" },
          { mimeType: "image/jpeg", byteSize: 110_000, role: "primary" },
          // Not in policy.required — would land without a cap.
          { mimeType: "image/png", byteSize: 10_000_000, role: "alternate" },
        ],
      }),
    ).rejects.toMatchObject({ diagnostic: { code: "MEDIA_VARIANTS_INCOMPLETE" } });
    expect(storage.createCalls).toHaveLength(0);
  });

  it.each([0, -1, 0.5, NaN, Number.MAX_SAFE_INTEGER + 1])(
    "rejects non-positive-integer byteSize: %s",
    async (badSize) => {
      const storage = new FakeMediaStorage();
      const kv = new InMemoryKv();
      const site = new InMemorySiteConfigRepository(DEFAULT_PURPOSES);
      const useCase = makeCreateUseCase({ storage, kv, site });
      await expect(
        useCase.execute({
          filename: "x.jpg",
          purpose: "post-cover",
          variants: [
            { mimeType: "image/avif", byteSize: 60_000, role: "alternate" },
            { mimeType: "image/webp", byteSize: 80_000, role: "alternate" },
            { mimeType: "image/jpeg", byteSize: badSize, role: "primary" },
          ],
        }),
      ).rejects.toMatchObject({ diagnostic: { code: "MEDIA_VARIANT_SIZE_EXCEEDED" } });
      expect(storage.createCalls).toHaveLength(0);
    },
  );

  it("rejects oversized variant at create time (before signing)", async () => {
    const storage = new FakeMediaStorage();
    const kv = new InMemoryKv();
    const site = new InMemorySiteConfigRepository([
      {
        name: "post-cover",
        required: ["image/avif", "image/webp", "image/jpeg"],
        maxBytes: {
          "image/avif": 50_000,
          "image/webp": 80_000,
          "image/jpeg": 100_000,
        },
      },
    ]);
    const useCase = makeCreateUseCase({ storage, kv, site });
    await expect(
      useCase.execute({
        filename: "x.jpg",
        purpose: "post-cover",
        variants: [
          { mimeType: "image/avif", byteSize: 40_000, role: "alternate" },
          { mimeType: "image/webp", byteSize: 60_000, role: "alternate" },
          // jpeg overshoots the 100k cap — must reject BEFORE storage.createUpload
          { mimeType: "image/jpeg", byteSize: 150_000, role: "primary" },
        ],
      }),
    ).rejects.toMatchObject({ diagnostic: { code: "MEDIA_VARIANT_SIZE_EXCEEDED" } });
    expect(storage.createCalls).toHaveLength(0);
  });

  it("forwards per-mime maxBytes from the purpose policy to the adapter", async () => {
    const storage = new FakeMediaStorage();
    const kv = new InMemoryKv();
    const site = new InMemorySiteConfigRepository([
      {
        name: "post-cover",
        required: ["image/avif", "image/webp", "image/jpeg"],
        maxBytes: {
          "image/avif": 50_000,
          "image/webp": 80_000,
          "image/jpeg": 100_000,
        },
      },
    ]);
    const useCase = makeCreateUseCase({ storage, kv, site });
    await useCase.execute({
      filename: "x.png",
      purpose: "post-cover",
      variants: [
        { mimeType: "image/avif", byteSize: 40_000, role: "alternate" },
        { mimeType: "image/webp", byteSize: 60_000, role: "alternate" },
        { mimeType: "image/jpeg", byteSize: 90_000, role: "primary" },
      ],
    });
    expect(storage.createCalls).toHaveLength(1);
    expect(storage.createCalls[0]!.variants.map((v) => v.maxBytes)).toEqual([
      50_000,
      80_000,
      100_000,
    ]);
  });

  it("rejects suspicious sizing: avif > jpeg", async () => {
    const storage = new FakeMediaStorage();
    const kv = new InMemoryKv();
    const site = new InMemorySiteConfigRepository(DEFAULT_PURPOSES);
    const useCase = makeCreateUseCase({ storage, kv, site });
    await expect(
      useCase.execute({
        filename: "unoptimized.jpg",
        purpose: "post-cover",
        variants: [
          { mimeType: "image/avif", byteSize: 200_000, role: "alternate" },
          { mimeType: "image/webp", byteSize: 80_000, role: "alternate" },
          { mimeType: "image/jpeg", byteSize: 100_000, role: "primary" },
        ],
      }),
    ).rejects.toMatchObject({ diagnostic: { code: "MEDIA_VARIANTS_SUSPICIOUS_SIZE" } });
  });

  it("rejects suspicious sizing: webp > jpeg", async () => {
    const storage = new FakeMediaStorage();
    const kv = new InMemoryKv();
    const site = new InMemorySiteConfigRepository(DEFAULT_PURPOSES);
    const useCase = makeCreateUseCase({ storage, kv, site });
    await expect(
      useCase.execute({
        filename: "unoptimized.jpg",
        purpose: "post-cover",
        variants: [
          { mimeType: "image/avif", byteSize: 60_000, role: "alternate" },
          { mimeType: "image/webp", byteSize: 150_000, role: "alternate" },
          { mimeType: "image/jpeg", byteSize: 100_000, role: "primary" },
        ],
      }),
    ).rejects.toMatchObject({ diagnostic: { code: "MEDIA_VARIANTS_SUSPICIOUS_SIZE" } });
  });

  it("skips suspicious-sizing check when no classic fallback present", async () => {
    const storage = new FakeMediaStorage();
    const kv = new InMemoryKv();
    const site = new InMemorySiteConfigRepository([
      {
        name: "avif-only",
        required: ["image/avif"],
        maxBytes: { "image/avif": 1_000_000 },
      },
    ]);
    const useCase = makeCreateUseCase({ storage, kv, site });
    await expect(
      useCase.execute({
        filename: "avif-only.avif",
        purpose: "avif-only",
        variants: [{ mimeType: "image/avif", byteSize: 200_000, role: "primary" }],
      }),
    ).resolves.toMatchObject({ capabilities: expect.any(Array) });
  });

  it("rejects mime types outside the allowlist on any variant", async () => {
    const storage = new FakeMediaStorage();
    const kv = new InMemoryKv();
    const site = new InMemorySiteConfigRepository([
      {
        name: "post-cover",
        required: ["application/octet-stream"],
        maxBytes: { "application/octet-stream": 1_000_000 },
      },
    ]);
    const useCase = makeCreateUseCase({ storage, kv, site });
    await expect(
      useCase.execute({
        filename: "x.exe",
        purpose: "post-cover",
        variants: [{ mimeType: "application/octet-stream", byteSize: 100, role: "primary" }],
      }),
    ).rejects.toMatchObject({ diagnostic: { code: "MEDIA_MIME_REJECTED" } });
  });

  it("persists a KV record keyed by uploadGroupId", async () => {
    const storage = new FakeMediaStorage();
    const kv = new InMemoryKv();
    const site = new InMemorySiteConfigRepository(DEFAULT_PURPOSES);
    const useCase = makeCreateUseCase({ storage, kv, site });
    const result = await useCase.execute({
      filename: "cover.png",
      purpose: "post-cover",
      variants: THREE_VARIANTS,
    });
    expect(result.uploadGroupId).toBe("asset-1");
    expect(result.capabilities).toHaveLength(3);
    const raw = await kv.get(`media:pending:${result.uploadGroupId}`);
    expect(raw).not.toBeNull();
    const record = JSON.parse(raw!);
    expect(record.purpose).toBe("post-cover");
    expect(record.filename).toBe("cover.png");
    expect(record.variants).toHaveLength(3);
    expect(record.variants[0].storageKey).toContain("asset-1");
  });

  it("forwards filename to storage.createUpload", async () => {
    const storage = new FakeMediaStorage();
    const kv = new InMemoryKv();
    const site = new InMemorySiteConfigRepository(DEFAULT_PURPOSES);
    const useCase = makeCreateUseCase({ storage, kv, site });
    await useCase.execute({
      filename: "hero-2026.png",
      purpose: "post-cover",
      variants: THREE_VARIANTS,
    });
    expect(storage.createCalls).toHaveLength(1);
    expect(storage.createCalls[0]!.filename).toBe("hero-2026.png");
  });

  it("rejects SVG by default", async () => {
    const storage = new FakeMediaStorage();
    const kv = new InMemoryKv();
    const site = new InMemorySiteConfigRepository([
      {
        name: "post-cover",
        required: ["image/svg+xml"],
        maxBytes: { "image/svg+xml": 1_000_000 },
      },
    ]);
    const useCase = makeCreateUseCase({ storage, kv, site });
    await expect(
      useCase.execute({
        filename: "x.svg",
        purpose: "post-cover",
        variants: [{ mimeType: "image/svg+xml", byteSize: 100, role: "primary" }],
      }),
    ).rejects.toMatchObject({ diagnostic: { code: "MEDIA_SVG_REJECTED" } });
  });

  it("accepts SVG when allowSvg flag is on", async () => {
    const storage = new FakeMediaStorage();
    const kv = new InMemoryKv();
    const site = new InMemorySiteConfigRepository([
      {
        name: "post-cover",
        required: ["image/svg+xml"],
        maxBytes: { "image/svg+xml": 1_000_000 },
      },
    ]);
    const useCase = makeCreateUseCase({ storage, kv, site, allowSvg: true });
    const r = await useCase.execute({
      filename: "x.svg",
      purpose: "post-cover",
      variants: [{ mimeType: "image/svg+xml", byteSize: 100, role: "primary" }],
    });
    expect(r.uploadGroupId).toBe("asset-1");
  });
});

describe("AdminMediaLibraryUseCase", () => {
  it("lists media with stable cursors and searches names without variants JSON", async () => {
    const repo = new DatabaseMediaAssetRepository(new InMemoryDatabase());
    await repo.save(asset("asset-a", 30, "Cover", "visible caption", "hidden-variant-name"));
    await repo.save(asset("asset-b", 20, "Gallery", "secondary", "plain"));
    await repo.save(asset("asset-c", 10, "Manual", "docs", "plain"));
    const useCase = new AdminMediaLibraryUseCase(repo, new FakeMediaStorage());

    const first = await useCase.list({ limit: 2 });
    expect(first.items.map((item) => item.id)).toEqual(["asset-a", "asset-b"]);
    expect(first.next_cursor).toBeTruthy();

    const second = await useCase.list({ limit: 2, cursor: first.next_cursor ?? undefined });
    expect(second.items.map((item) => item.id)).toEqual(["asset-c"]);
    expect(second.next_cursor).toBeNull();

    const searched = await useCase.list({ limit: 10, search: "hidden-variant-name" });
    expect(searched.items).toEqual([]);
    const caption = await useCase.list({ limit: 10, search: "visible" });
    expect(caption.items.map((item) => item.id)).toEqual(["asset-a"]);
  });

  it("updates alt and caption through the repository", async () => {
    const repo = new DatabaseMediaAssetRepository(new InMemoryDatabase());
    await repo.save(asset("asset-a", 30, "Old alt", "Old caption"));
    const useCase = new AdminMediaLibraryUseCase(repo, new FakeMediaStorage());

    const updated = await useCase.update({
      id: "asset-a",
      alt: "New alt",
      caption: "New caption",
    });

    expect(updated).toMatchObject({
      id: "asset-a",
      alt: "New alt",
      caption: "New caption",
      primaryUrl: "https://media.example/asset-a/primary",
    });
  });

  it("deletes storage variants before deleting the database row", async () => {
    const repo = new DatabaseMediaAssetRepository(new InMemoryDatabase());
    await repo.save(asset("asset-a", 30, "Cover", "Caption", "primary", true));
    const storage = new FakeMediaStorage();
    const useCase = new AdminMediaLibraryUseCase(repo, storage);

    await expect(useCase.delete({ id: "asset-a" })).resolves.toEqual({ removed: true });

    expect(storage.deleteCalls.map((call) => call.storageKey)).toEqual([
      "asset-a/primary",
      "asset-a/alternate",
    ]);
    await expect(repo.findById("asset-a")).resolves.toBeNull();
  });

  it("keeps the database row when storage deletion fails", async () => {
    const repo = new DatabaseMediaAssetRepository(new InMemoryDatabase());
    await repo.save(asset("asset-a", 30, "Cover", "Caption"));
    const storage = new FakeMediaStorage();
    storage.failDelete = true;
    const useCase = new AdminMediaLibraryUseCase(repo, storage);

    await expect(useCase.delete({ id: "asset-a" })).rejects.toThrow("delete failed");

    await expect(repo.findById("asset-a")).resolves.toMatchObject({ id: "asset-a" });
  });
});

function asset(
  id: string,
  createdAt: number,
  alt?: string,
  caption?: string,
  storageName = "primary",
  includeAlternate = false,
): MediaAsset {
  return {
    id,
    alt,
    caption,
    createdAt,
    variants: [
      {
        role: "primary",
        mimeType: "image/jpeg",
        storageKey: `${id}/${storageName}`,
        publicUrl: `https://media.example/${id}/${storageName}`,
        byteSize: 100,
      },
      ...(includeAlternate
        ? [{
            role: "alternate" as const,
            mimeType: "image/webp",
            storageKey: `${id}/alternate`,
            publicUrl: `https://media.example/${id}/alternate`,
            byteSize: 80,
          }]
        : []),
    ],
  };
}

describe("UploadMediaVariantUseCase (#283 sandboxed-agent path)", () => {
  async function seedPendingUpload(opts: {
    storage: FakeMediaStorage;
    kv: InMemoryKv;
    site: InMemorySiteConfigRepository;
    purpose?: string;
    variants?: typeof THREE_VARIANTS;
  }): Promise<string> {
    const create = makeCreateUseCase({
      storage: opts.storage,
      kv: opts.kv,
      site: opts.site,
    });
    const created = await create.execute({
      filename: "x.png",
      purpose: opts.purpose ?? "post-cover",
      variants: opts.variants ?? THREE_VARIANTS,
    });
    return created.uploadGroupId;
  }

  it("returns MEDIA_UPLOAD_EXPIRED when the pending KV record is missing", async () => {
    const storage = new FakeMediaStorage();
    const kv = new InMemoryKv();
    const useCase = new UploadMediaVariantUseCase(storage, kv, fakeClock);
    await expect(
      useCase.execute({
        uploadGroupId: "never-created",
        role: "primary",
        mimeType: "image/jpeg",
        bytes: new Uint8Array(100),
      }),
    ).rejects.toMatchObject({ diagnostic: { code: "MEDIA_UPLOAD_EXPIRED" } });
    expect(storage.putVariantCalls).toHaveLength(0);
  });

  it("writes bytes to storage when (role, mimeType) matches a declared variant", async () => {
    const storage = new FakeMediaStorage();
    const kv = new InMemoryKv();
    const site = new InMemorySiteConfigRepository(DEFAULT_PURPOSES);
    const uploadGroupId = await seedPendingUpload({ storage, kv, site });

    const useCase = new UploadMediaVariantUseCase(storage, kv, fakeClock);
    const bytes = new Uint8Array(50_000);
    const result = await useCase.execute({
      uploadGroupId,
      role: "primary",
      mimeType: "image/jpeg",
      bytes,
    });
    expect(result.byteSize).toBe(50_000);
    expect(result.storageKey).toBe(`post-cover/${uploadGroupId}/primary`);
    expect(storage.putVariantCalls).toHaveLength(1);
    expect(storage.putVariantCalls[0]!.purpose).toBe("post-cover");
    expect(storage.putVariantCalls[0]!.role).toBe("primary");
    expect(storage.putVariantCalls[0]!.mimeType).toBe("image/jpeg");
    expect(storage.putVariantCalls[0]!.filename).toBe("x.png");
    expect(storage.putVariantCalls[0]!.bytes).toBe(bytes);
  });

  it("rejects when (role, mimeType) doesn't match any declared variant", async () => {
    const storage = new FakeMediaStorage();
    const kv = new InMemoryKv();
    const site = new InMemorySiteConfigRepository(DEFAULT_PURPOSES);
    const uploadGroupId = await seedPendingUpload({ storage, kv, site });

    const useCase = new UploadMediaVariantUseCase(storage, kv, fakeClock);
    await expect(
      useCase.execute({
        uploadGroupId,
        // declared: primary=jpeg, alternate=avif/webp. primary=avif
        // isn't in the declared set → reject.
        role: "primary",
        mimeType: "image/avif",
        bytes: new Uint8Array(50_000),
      }),
    ).rejects.toMatchObject({ diagnostic: { code: "MEDIA_MIME_REJECTED" } });
    expect(storage.putVariantCalls).toHaveLength(0);
  });

  it("rejects a mimeType not declared for this purpose at all", async () => {
    const storage = new FakeMediaStorage();
    const kv = new InMemoryKv();
    const site = new InMemorySiteConfigRepository(DEFAULT_PURPOSES);
    const uploadGroupId = await seedPendingUpload({ storage, kv, site });

    const useCase = new UploadMediaVariantUseCase(storage, kv, fakeClock);
    await expect(
      useCase.execute({
        uploadGroupId,
        role: "alternate",
        mimeType: "image/gif", // never declared on post-cover
        bytes: new Uint8Array(50_000),
      }),
    ).rejects.toMatchObject({ diagnostic: { code: "MEDIA_MIME_REJECTED" } });
    expect(storage.putVariantCalls).toHaveLength(0);
  });

  it("returns MEDIA_UPLOAD_EXPIRED when the pending record's expiresAt is in the past", async () => {
    const storage = new FakeMediaStorage();
    const kv = new InMemoryKv();
    const site = new InMemorySiteConfigRepository(DEFAULT_PURPOSES);
    const uploadGroupId = await seedPendingUpload({ storage, kv, site });

    // Advance the clock past the pending record's expiresAt. The
    // record was minted at FROZEN_NOW + UPLOAD_URL_TTL_SECONDS * 1000;
    // jump well past that boundary so the wall-clock check fires
    // even though the KV record is still readable in this in-memory
    // fake (which doesn't honor TTL).
    const advancedClock = { now: () => FROZEN_NOW + 60 * 60 * 1000 };
    const useCase = new UploadMediaVariantUseCase(storage, kv, advancedClock);
    await expect(
      useCase.execute({
        uploadGroupId,
        role: "primary",
        mimeType: "image/jpeg",
        bytes: new Uint8Array(100),
      }),
    ).rejects.toMatchObject({ diagnostic: { code: "MEDIA_UPLOAD_EXPIRED" } });
    expect(storage.putVariantCalls).toHaveLength(0);
  });

  it("rejects when payload byteSize exceeds the declared maxBytes for that variant", async () => {
    const storage = new FakeMediaStorage();
    const kv = new InMemoryKv();
    // Custom purpose with a tiny per-mime maxBytes so a small
    // payload trips the cap without needing to materialise a huge
    // buffer in the test.
    const site = new InMemorySiteConfigRepository([
      {
        name: "tiny",
        required: ["image/jpeg"],
        maxBytes: { "image/jpeg": 1_000 },
      },
    ]);
    const uploadGroupId = await seedPendingUpload({
      storage,
      kv,
      site,
      purpose: "tiny",
      variants: [
        { mimeType: "image/jpeg", byteSize: 500, role: "primary" as const },
      ],
    });

    const useCase = new UploadMediaVariantUseCase(storage, kv, fakeClock);
    await expect(
      useCase.execute({
        uploadGroupId,
        role: "primary",
        mimeType: "image/jpeg",
        // 2,000 bytes > policy.maxBytes.image/jpeg (1,000)
        bytes: new Uint8Array(2_000),
      }),
    ).rejects.toMatchObject({ diagnostic: { code: "MEDIA_VARIANT_SIZE_EXCEEDED" } });
    expect(storage.putVariantCalls).toHaveLength(0);
  });
});

describe("CommitMediaUploadUseCase (#272)", () => {
  it("returns MEDIA_UPLOAD_EXPIRED when KV record is missing", async () => {
    const storage = new FakeMediaStorage();
    const kv = new InMemoryKv();
    const assets = new InMemoryMediaAssetRepository();
    const useCase = new CommitMediaUploadUseCase(storage, kv, fakeClock, assets);
    await expect(useCase.execute({ uploadGroupId: "missing" })).rejects.toMatchObject({
      diagnostic: { code: "MEDIA_UPLOAD_EXPIRED" },
    });
  });

  it("persists the committed asset + clears the pending KV record", async () => {
    const storage = new FakeMediaStorage();
    const kv = new InMemoryKv();
    const site = new InMemorySiteConfigRepository(DEFAULT_PURPOSES);
    const assets = new InMemoryMediaAssetRepository();
    const create = makeCreateUseCase({ storage, kv, site });
    const created = await create.execute({
      filename: "x.png",
      purpose: "post-cover",
      variants: THREE_VARIANTS,
    });
    const commit = new CommitMediaUploadUseCase(storage, kv, fakeClock, assets);
    const asset = await commit.execute({
      uploadGroupId: created.uploadGroupId,
      alt: "an image",
      caption: "ok",
    });
    expect(asset.id).toBe(created.uploadGroupId);
    expect(asset.variants).toHaveLength(3);
    expect(asset.variants.find((v) => v.role === "primary")?.mimeType).toBe("image/jpeg");
    expect(asset.alt).toBe("an image");
    // filename round-trips from create-time KV record into the
    // commit-time CommitUploadArgs so the adapter can stamp it.
    expect(storage.commitCalls).toHaveLength(1);
    expect(storage.commitCalls[0]!.filename).toBe("x.png");
    expect(assets.saved).toHaveLength(1);
    expect(assets.saved[0]!.id).toBe(created.uploadGroupId);
    expect(await kv.get(`media:pending:${created.uploadGroupId}`)).toBeNull();
  });
});
