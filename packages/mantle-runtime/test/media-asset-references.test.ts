import { describe, expect, it } from "vitest";
import type { Entry } from "@aotter/mantle-spec";
import type { MediaAssetRepository } from "../src/domain/port/MediaAssetRepository.js";
import type { MediaAsset } from "../src/domain/port/MediaStorage.js";
import {
  collectMediaAssetIds,
  resolveMediaAssetsForEntries,
} from "../src/domain/service/io/MediaAssetReferences.js";

describe("MediaAssetReferences", () => {
  it("collects nested *AssetId and *AssetIds values without duplicates", () => {
    expect(
      collectMediaAssetIds({
        coverAssetId: "cover",
        emptyAssetId: "",
        galleryAssetIds: ["hero", "cover", 3, ""],
        sections: [
          { imageAssetId: "inline" },
          { nested: { sideImageAssetId: "side" } },
        ],
        nestedImage: { assetId: "nested" },
      }),
    ).toEqual(["cover", "hero", "inline", "side", "nested"]);
  });

  it("returns undefined when no repository or references are available", async () => {
    const entries = [entry({ title: "No media" })];
    await expect(resolveMediaAssetsForEntries(null, entries)).resolves.toBeUndefined();
    await expect(resolveMediaAssetsForEntries(new MemoryMediaAssets(), entries)).resolves.toBeUndefined();
  });

  it("resolves referenced assets once for render contexts", async () => {
    const repo = new MemoryMediaAssets([asset("cover"), asset("inline")]);
    const resolved = await resolveMediaAssetsForEntries(repo, [
      entry({ coverAssetId: "cover" }),
      entry({ body: [{ imageAssetId: "inline" }, { imageAssetId: "cover" }] }),
    ]);

    expect([...resolved!.keys()]).toEqual(["cover", "inline"]);
    expect(repo.lookups).toEqual([["cover", "inline"]]);
  });
});

function entry(data: Record<string, unknown>): Entry {
  return {
    id: "entry",
    collection: "posts",
    status: "published",
    version: 1,
    data,
    createdAt: 1,
    updatedAt: 2,
  };
}

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
  private readonly assets: Map<string, MediaAsset>;

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

  async save(asset: MediaAsset): Promise<void> {
    this.assets.set(asset.id, asset);
  }

  async delete(id: string): Promise<void> {
    this.assets.delete(id);
  }

  async list(
    args: Parameters<MediaAssetRepository["list"]>[0],
  ): ReturnType<MediaAssetRepository["list"]> {
    const search = args.search?.toLowerCase();
    const rows = [...this.assets.values()].filter(
      (a) =>
        !search ||
        a.id.toLowerCase().includes(search) ||
        (a.alt ?? "").toLowerCase().includes(search) ||
        (a.caption ?? "").toLowerCase().includes(search),
    );
    return { rows };
  }
}
