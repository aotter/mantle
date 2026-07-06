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
  save(asset: MediaAsset): Promise<void>;
  delete(id: string): Promise<void>;
  /**
   * Newest-first page of committed assets for the admin media library
   * (#434). Cursor-paginated like `EntryRepository.list` — offset-based
   * behind an opaque token. `search` (optional) is a substring match
   * over alt/caption/id; the store owns escaping. No tag/folder filter
   * — `media_assets` carries no such column (see the repository impl).
   */
  list(args: MediaAssetListArgs): Promise<MediaAssetListResult>;
}

export interface MediaAssetListArgs {
  readonly limit?: number;
  readonly cursor?: string;
  readonly search?: string;
}

export interface MediaAssetListResult {
  readonly rows: readonly MediaAsset[];
  /** Present when there may be more rows; pass back as `cursor`. */
  readonly nextCursor?: string;
}
