import { DiagnosticError } from "@aotter/mantle-spec";
import type { MediaAssetRepository } from "../../domain/port/MediaAssetRepository.js";
import type { MediaAsset } from "../../domain/port/MediaStorage.js";
import type { UpdateMediaAssetRequest } from "../dto/media/index.js";
import { mediaAssetNotFoundDiagnostic } from "./diagnostics.js";

/**
 * `UpdateMediaAssetUseCase` — patch alt/caption on a committed asset
 * (#434). Variants/mime/bytes/createdAt are frozen at commit; only the
 * two operator-authored text fields are mutable here. `save` upserts by
 * id (the commit use case shares the same writer), so the read →
 * merge → save round-trips the full row while touching only alt/caption.
 *
 * A field left `undefined` in the request is preserved; an empty string
 * clears it. Rejects `MEDIA_ASSET_NOT_FOUND` when the id is absent so a
 * PATCH against a deleted asset doesn't silently re-create a partial row.
 */
export class UpdateMediaAssetUseCase {
  constructor(private readonly assets: MediaAssetRepository) {}

  async execute(request: UpdateMediaAssetRequest): Promise<MediaAsset> {
    const existing = await this.assets.findById(request.id);
    if (!existing) {
      throw new DiagnosticError(
        mediaAssetNotFoundDiagnostic("usecase/UpdateMediaAsset", request.id),
      );
    }
    const next: MediaAsset = {
      ...existing,
      alt: request.alt !== undefined ? request.alt : existing.alt,
      caption: request.caption !== undefined ? request.caption : existing.caption,
    };
    await this.assets.save(next);
    return next;
  }
}
