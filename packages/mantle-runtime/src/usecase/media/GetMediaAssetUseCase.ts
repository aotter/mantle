import { DiagnosticError } from "@aotter/mantle-spec";
import type { MediaAssetRepository } from "../../domain/port/MediaAssetRepository.js";
import type { MediaAsset } from "../../domain/port/MediaStorage.js";
import { mediaAssetNotFoundDiagnostic } from "./diagnostics.js";

/**
 * `GetMediaAssetUseCase` — one committed asset by id (#434). Throws
 * `MEDIA_ASSET_NOT_FOUND` (404 on the wire) when absent, so the admin
 * detail/picker surfaces get a structured 404 rather than a bare null.
 */
export class GetMediaAssetUseCase {
  constructor(private readonly assets: MediaAssetRepository) {}

  async execute(id: string): Promise<MediaAsset> {
    const asset = await this.assets.findById(id);
    if (!asset) {
      throw new DiagnosticError(
        mediaAssetNotFoundDiagnostic("usecase/GetMediaAsset", id),
      );
    }
    return asset;
  }
}
