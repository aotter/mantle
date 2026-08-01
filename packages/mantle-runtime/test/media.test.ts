import { describe, it, expect } from "vitest";
import type { MediaAsset, MediaStorage, MediaVariant } from "../src/domain/port/MediaStorage.js";
import type { MediaAssetRepository } from "../src/domain/port/MediaAssetRepository.js";
import {
  CommitMediaUploadUseCase,
  CreateMediaUploadUseCase,
} from "../src/usecase/media/index.js";
import { InMemoryPendingUploadRepository } from "./fakes/pending.js";
import { InMemorySiteConfigRepository } from "./fakes/site-config.js";

const DEFAULT_PURPOSES = ["post-cover", "product-cover"] as const;

class FakeMediaStorage implements MediaStorage {
  public createCalls: Parameters<MediaStorage["createUpload"]>[0][] = [];
  public commitCalls: Parameters<MediaStorage["commitUpload"]>[0][] = [];

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

  async deleteObject(): Promise<void> {
    /* noop */
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

  async save(asset: MediaAsset): Promise<void> {
    this.saved.push(asset);
    this.store.set(asset.id, asset);
  }

  async delete(id: string): Promise<void> {
    this.store.delete(id);
  }

  async list(
    args: Parameters<MediaAssetRepository["list"]>[0],
  ): ReturnType<MediaAssetRepository["list"]> {
    const search = args.search?.toLowerCase();
    const rows = [...this.store.values()].filter(
      (a) =>
        !search ||
        a.id.toLowerCase().includes(search) ||
        (a.alt ?? "").toLowerCase().includes(search) ||
        (a.caption ?? "").toLowerCase().includes(search),
    );
    return { rows };
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
  pending: InMemoryPendingUploadRepository;
  site: InMemorySiteConfigRepository;
  idgen?: CountingIdGenerator;
  allowSvg?: boolean;
}): CreateMediaUploadUseCase {
  return new CreateMediaUploadUseCase(
    opts.storage,
    opts.pending,
    fakeClock,
    opts.idgen ?? new CountingIdGenerator(),
    opts.site,
    { allowSvg: opts.allowSvg ?? false },
  );
}

describe("CreateMediaUploadUseCase (#272 multi-variant)", () => {
  it("rejects undeclared purpose with MEDIA_PURPOSE_REJECTED (fail-closed)", async () => {
    const storage = new FakeMediaStorage();
    const pending = new InMemoryPendingUploadRepository();
    const site = new InMemorySiteConfigRepository(DEFAULT_PURPOSES);
    const useCase = makeCreateUseCase({ storage, pending, site });
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
    const pending = new InMemoryPendingUploadRepository();
    const site = new InMemorySiteConfigRepository([]);
    const useCase = makeCreateUseCase({ storage, pending, site });
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
    const pending = new InMemoryPendingUploadRepository();
    const site = new InMemorySiteConfigRepository(DEFAULT_PURPOSES);
    const useCase = makeCreateUseCase({ storage, pending, site });
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
    const pending = new InMemoryPendingUploadRepository();
    const site = new InMemorySiteConfigRepository(DEFAULT_PURPOSES);
    const useCase = makeCreateUseCase({ storage, pending, site });
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
    const pending = new InMemoryPendingUploadRepository();
    const site = new InMemorySiteConfigRepository(DEFAULT_PURPOSES);
    const useCase = makeCreateUseCase({ storage, pending, site });
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
    const pending = new InMemoryPendingUploadRepository();
    const site = new InMemorySiteConfigRepository(DEFAULT_PURPOSES);
    const useCase = makeCreateUseCase({ storage, pending, site });
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
    const pending = new InMemoryPendingUploadRepository();
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
    const useCase = makeCreateUseCase({ storage, pending, site });
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
    const pending = new InMemoryPendingUploadRepository();
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
    const useCase = makeCreateUseCase({ storage, pending, site });
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
    const pending = new InMemoryPendingUploadRepository();
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
    const useCase = makeCreateUseCase({ storage, pending, site });
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
    const pending = new InMemoryPendingUploadRepository();
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
    const useCase = makeCreateUseCase({ storage, pending, site });
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
    const pending = new InMemoryPendingUploadRepository();
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
    const useCase = makeCreateUseCase({ storage, pending, site });
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
      const pending = new InMemoryPendingUploadRepository();
      const site = new InMemorySiteConfigRepository(DEFAULT_PURPOSES);
      const useCase = makeCreateUseCase({ storage, pending, site });
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
    const pending = new InMemoryPendingUploadRepository();
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
    const useCase = makeCreateUseCase({ storage, pending, site });
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
    const pending = new InMemoryPendingUploadRepository();
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
    const useCase = makeCreateUseCase({ storage, pending, site });
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
    const pending = new InMemoryPendingUploadRepository();
    const site = new InMemorySiteConfigRepository(DEFAULT_PURPOSES);
    const useCase = makeCreateUseCase({ storage, pending, site });
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
    const pending = new InMemoryPendingUploadRepository();
    const site = new InMemorySiteConfigRepository(DEFAULT_PURPOSES);
    const useCase = makeCreateUseCase({ storage, pending, site });
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
    const pending = new InMemoryPendingUploadRepository();
    const site = new InMemorySiteConfigRepository([
      {
        name: "avif-only",
        required: ["image/avif"],
        maxBytes: { "image/avif": 1_000_000 },
      },
    ]);
    const useCase = makeCreateUseCase({ storage, pending, site });
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
    const pending = new InMemoryPendingUploadRepository();
    const site = new InMemorySiteConfigRepository([
      {
        name: "post-cover",
        required: ["application/octet-stream"],
        maxBytes: { "application/octet-stream": 1_000_000 },
      },
    ]);
    const useCase = makeCreateUseCase({ storage, pending, site });
    await expect(
      useCase.execute({
        filename: "x.exe",
        purpose: "post-cover",
        variants: [{ mimeType: "application/octet-stream", byteSize: 100, role: "primary" }],
      }),
    ).rejects.toMatchObject({ diagnostic: { code: "MEDIA_MIME_REJECTED" } });
  });

  it("persists canonical pending state keyed by uploadGroupId", async () => {
    const storage = new FakeMediaStorage();
    const pending = new InMemoryPendingUploadRepository();
    const site = new InMemorySiteConfigRepository(DEFAULT_PURPOSES);
    const useCase = makeCreateUseCase({ storage, pending, site });
    const result = await useCase.execute({
      filename: "cover.png",
      purpose: "post-cover",
      variants: THREE_VARIANTS,
    });
    expect(result.uploadGroupId).toBe("asset-1");
    expect(result.capabilities).toHaveLength(3);
    const record = await pending.findById(result.uploadGroupId);
    expect(record).not.toBeNull();
    expect(record?.purpose).toBe("post-cover");
    expect(record?.filename).toBe("cover.png");
    expect(record?.variants).toHaveLength(3);
    expect(record?.variants[0]?.storageKey).toContain("asset-1");
  });

  it("forwards filename to storage.createUpload", async () => {
    const storage = new FakeMediaStorage();
    const pending = new InMemoryPendingUploadRepository();
    const site = new InMemorySiteConfigRepository(DEFAULT_PURPOSES);
    const useCase = makeCreateUseCase({ storage, pending, site });
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
    const pending = new InMemoryPendingUploadRepository();
    const site = new InMemorySiteConfigRepository([
      {
        name: "post-cover",
        required: ["image/svg+xml"],
        maxBytes: { "image/svg+xml": 1_000_000 },
      },
    ]);
    const useCase = makeCreateUseCase({ storage, pending, site });
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
    const pending = new InMemoryPendingUploadRepository();
    const site = new InMemorySiteConfigRepository([
      {
        name: "post-cover",
        required: ["image/svg+xml"],
        maxBytes: { "image/svg+xml": 1_000_000 },
      },
    ]);
    const useCase = makeCreateUseCase({ storage, pending, site, allowSvg: true });
    const r = await useCase.execute({
      filename: "x.svg",
      purpose: "post-cover",
      variants: [{ mimeType: "image/svg+xml", byteSize: 100, role: "primary" }],
    });
    expect(r.uploadGroupId).toBe("asset-1");
  });
});


describe("CommitMediaUploadUseCase (#272)", () => {
  it("returns MEDIA_UPLOAD_EXPIRED when pending state is missing", async () => {
    const storage = new FakeMediaStorage();
    const pending = new InMemoryPendingUploadRepository();
    const assets = new InMemoryMediaAssetRepository();
    const useCase = new CommitMediaUploadUseCase(storage, pending, fakeClock, assets);
    await expect(useCase.execute({ uploadGroupId: "missing" })).rejects.toMatchObject({
      diagnostic: { code: "MEDIA_UPLOAD_EXPIRED" },
    });
  });

  it("persists the committed asset + clears canonical pending state", async () => {
    const storage = new FakeMediaStorage();
    const pending = new InMemoryPendingUploadRepository();
    const site = new InMemorySiteConfigRepository(DEFAULT_PURPOSES);
    const assets = new InMemoryMediaAssetRepository();
    const create = makeCreateUseCase({ storage, pending, site });
    const created = await create.execute({
      filename: "x.png",
      purpose: "post-cover",
      variants: THREE_VARIANTS,
    });
    const commit = new CommitMediaUploadUseCase(storage, pending, fakeClock, assets);
    const asset = await commit.execute({
      uploadGroupId: created.uploadGroupId,
      alt: "an image",
      caption: "ok",
    });
    expect(asset.id).toBe(created.uploadGroupId);
    expect(asset.variants).toHaveLength(3);
    expect(asset.variants.find((v) => v.role === "primary")?.mimeType).toBe("image/jpeg");
    expect(asset.alt).toBe("an image");
    // filename round-trips from create-time pending state into the
    // commit-time CommitUploadArgs so the adapter can stamp it.
    expect(storage.commitCalls).toHaveLength(1);
    expect(storage.commitCalls[0]!.filename).toBe("x.png");
    expect(assets.saved).toHaveLength(1);
    expect(assets.saved[0]!.id).toBe(created.uploadGroupId);
    expect(await pending.findById(created.uploadGroupId)).toBeNull();
  });

  it("rejects and removes expired canonical pending state", async () => {
    const storage = new FakeMediaStorage();
    const pending = new InMemoryPendingUploadRepository();
    const assets = new InMemoryMediaAssetRepository();
    await pending.save("expired", {
      purpose: "post-cover",
      filename: "old.png",
      variants: [],
      createdAt: FROZEN_NOW - 2_000,
      expiresAt: FROZEN_NOW - 1,
    });

    const commit = new CommitMediaUploadUseCase(storage, pending, fakeClock, assets);
    await expect(commit.execute({ uploadGroupId: "expired" })).rejects.toMatchObject({
      diagnostic: { code: "MEDIA_UPLOAD_EXPIRED" },
    });
    await expect(pending.findById("expired")).resolves.toBeNull();
  });
});
