import type { MediaAsset } from "./MediaStorage.js";

/**
 * Persistent store for committed `MediaAsset` rows — the
 * `media_assets` table on the SDK-canonical schema. Owned by the
 * commit-media use case (which `save`s on successful commit) and the
 * render path (which calls `findById` / `findManyByIds` via
 * `runtime.media.resolve`).
 *
 * The table is the single source of truth for the variants set of an
 * already-uploaded asset; entry data carries only `MediaAsset.id`
 * (`x-mantle-ref: media_assets`) and the renderer resolves at render
 * time. Persisting the full asset row (not just storage keys) keeps
 * resolution to one indexed read and lets the orphan sweeper (#254)
 * identify uncommitted-but-unreferenced R2 objects by comparing
 * bucket listings against the table.
 *
 * `findManyByIds` is mandatory (not a `findById`-fan-out helper)
 * because entry-list rendering pulls N posts → N coverAssetId lookups;
 * the renderer's DataLoader-style batcher relies on a single DB round
 * trip per page.
 *
 * `delete` removes the row only — the R2 objects are deleted by
 * the use case that owns the asset deletion lifecycle, which calls
 * `MediaStorage.deleteObject` once per variant before this. Splitting
 * the two lets either side fail without leaving the other in a
 * half-deleted state the sweeper can clean up.
 */
export interface MediaAssetRepository {
  findById(id: string): Promise<MediaAsset | null>;
  findManyByIds(ids: readonly string[]): Promise<ReadonlyMap<string, MediaAsset>>;
  list(args: ListMediaAssetsArgs): Promise<ListMediaAssetsResult>;
  update(id: string, values: UpdateMediaAssetValues): Promise<MediaAsset | null>;
  save(asset: MediaAsset): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface ListMediaAssetsArgs {
  readonly limit: number;
  readonly cursor?: string;
  readonly search?: string;
}

export interface ListMediaAssetsResult {
  readonly items: ReadonlyArray<ListedMediaAsset>;
  readonly nextCursor?: string;
}

export interface ListedMediaAsset extends MediaAsset {
  readonly ownerId?: string;
}

export interface UpdateMediaAssetValues {
  readonly alt?: string;
  readonly caption?: string;
}
