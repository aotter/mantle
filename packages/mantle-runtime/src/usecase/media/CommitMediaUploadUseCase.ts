import { DiagnosticError } from "@aotter/mantle-spec";
import type { Clock } from "../../domain/port/Clock.js";
import type { MediaAssetRepository } from "../../domain/port/MediaAssetRepository.js";
import type { PendingUploadRepository } from "../../domain/port/PendingUploadRepository.js";
import type {
  CommitUploadVariantSpec,
  MediaAsset,
  MediaStorage,
} from "../../domain/port/MediaStorage.js";
import type { CommitMediaUploadRequest } from "../dto/media/index.js";
import { mediaUploadExpiredDiagnostic } from "./diagnostics.js";

/**
 * Finalise the variant bundle issued by `create_media_upload`. Reads
 * the canonical `PendingUploadRecord` (each variant's expected
 * mime + size + storageKey), asks the adapter to verify every
 * uploaded object (HEAD + bytes), and on success persists the
 * resulting `MediaAsset` to the `media_assets` table.
 *
 * All-or-nothing: any variant failing HEAD-verify rejects the whole
 * commit. The orphan sweeper (#254) cleans up partially-uploaded
 * bundles whose pending record expired.
 */
export class CommitMediaUploadUseCase {
  constructor(
    private readonly storage: MediaStorage,
    private readonly pendingUploads: PendingUploadRepository,
    private readonly clock: Clock,
    private readonly assets: MediaAssetRepository,
  ) {}

  async execute(request: CommitMediaUploadRequest): Promise<MediaAsset> {
    const opPath = "usecase/CommitMediaUpload";
    const record = await this.pendingUploads.findById(request.uploadGroupId);
    if (!record || record.expiresAt <= this.clock.now()) {
      if (record) await this.pendingUploads.delete(request.uploadGroupId);
      throw new DiagnosticError(
        mediaUploadExpiredDiagnostic(opPath, request.uploadGroupId),
      );
    }

    const variantSpecs: ReadonlyArray<CommitUploadVariantSpec> = record.variants.map((v) => ({
      mimeType: v.mimeType,
      role: v.role,
      storageKey: v.storageKey,
      maxBytes: Math.min(v.maxBytes, v.expectedSize),
    }));

    const asset = await this.storage.commitUpload({
      uploadGroupId: request.uploadGroupId,
      filename: record.filename,
      variants: variantSpecs,
      alt: request.alt ?? record.alt,
      caption: request.caption ?? record.caption,
      now: this.clock.now(),
    });

    await this.assets.save(asset);

    await this.pendingUploads.delete(request.uploadGroupId);

    return asset;
  }
}
