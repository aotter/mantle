import { DiagnosticError } from "@aotter/mantle-spec";
import type { MediaAssetRepository } from "../../domain/port/MediaAssetRepository.js";
import type { MediaStorage } from "../../domain/port/MediaStorage.js";
import { mediaAssetNotFoundDiagnostic } from "./diagnostics.js";

/**
 * `DeleteMediaAssetUseCase` — remove a committed asset (#434).
 * Orchestrates the two-sided deletion the ports describe: delete every
 * variant's R2 object via `MediaStorage.deleteObject`, then delete the
 * `media_assets` row. Ordering matters — drop the objects first so a
 * crash between the two leaves an orphan *row* (which the sweeper can
 * reconcile from a bucket listing) rather than a dangling *reference*
 * to bytes that are already gone.
 *
 * # Reference safety (v1 decision)
 *
 * Entries reference assets by id (`x-mantle-ref: media_assets`) with no
 * reverse index. A full back-scan across every collection's JSON blobs
 * to block/anonymise a referenced asset is O(all-content) per delete —
 * too heavy for the admin path at this stage. v1 deletes cleanly and
 * unconditionally; a stale reference resolves to null at render time
 * (renderers already tolerate a missing asset). A cheap warn-on-
 * reference (or a maintained reverse index) is a follow-up, not a
 * blocker for shipping delete.
 */
export class DeleteMediaAssetUseCase {
  constructor(
    private readonly storage: MediaStorage,
    private readonly assets: MediaAssetRepository,
  ) {}

  async execute(id: string): Promise<{ deleted: true; variantsRemoved: number }> {
    const asset = await this.assets.findById(id);
    if (!asset) {
      throw new DiagnosticError(
        mediaAssetNotFoundDiagnostic("usecase/DeleteMediaAsset", id),
      );
    }
    for (const variant of asset.variants) {
      await this.storage.deleteObject({ storageKey: variant.storageKey });
    }
    await this.assets.delete(id);
    return { deleted: true, variantsRemoved: asset.variants.length };
  }
}
