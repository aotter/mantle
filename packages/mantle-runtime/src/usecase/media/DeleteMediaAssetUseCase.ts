import { DiagnosticError, runtimeDiagnostic } from "@aotter/mantle-spec";
import type { MediaAssetRepository } from "../../domain/port/MediaAssetRepository.js";
import type { MediaStorage } from "../../domain/port/MediaStorage.js";
import { mediaAssetNotFoundDiagnostic } from "./diagnostics.js";

/**
 * `DeleteMediaAssetUseCase` — remove a committed asset (#434).
 * Orchestrates the two-sided deletion the ports describe: delete every
 * variant's R2 object via `MediaStorage.deleteObject`, then delete the
 * `media_assets` row. Ordering matters — drop the objects first so a
 * crash or partial object failure retains the asset identity and keys
 * for an idempotent retry. During recovery the row may reference
 * already deleted objects; no cross-store atomicity is promised.
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
    // Object delete is idempotent. Retain metadata until every variant is
    // removed so a partial failure can be retried with the same asset id.
    const deletable = asset.variants.filter((v) => v.storageKey);
    const results = await Promise.allSettled(
      deletable.map((variant) =>
        this.storage.deleteObject({ storageKey: variant.storageKey }),
      ),
    );
    const failures = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failures.length) {
      throw new DiagnosticError(runtimeDiagnostic({
        code: "PARTIAL_FAILURE", severity: "error", path: "usecase/DeleteMediaAsset",
        message: "Some objects could not be removed. Retry deletion of the same asset.",
        failure: { outcome: "partial", retry: "safe", resource: "media" },
      }), { cause: new AggregateError(failures.map(r => r.reason)) });
    }
    await this.assets.delete(id);
    return { deleted: true, variantsRemoved: asset.variants.length };
  }
}
