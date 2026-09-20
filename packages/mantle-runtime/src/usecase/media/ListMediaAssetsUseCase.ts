import type {
  MediaAssetListResult,
  MediaAssetRepository,
} from "../../domain/port/MediaAssetRepository.js";
import type { ListMediaAssetsRequest } from "../dto/media/index.js";

/**
 * `ListMediaAssetsUseCase` — newest-first page of committed media
 * assets for the admin media library (#434). Thin over
 * `MediaAssetRepository.list`; the repo owns clamping + cursor
 * round-tripping (shared with entry listing). No manifest lookup: the
 * media library is a flat store, not a Schema collection.
 */
export class ListMediaAssetsUseCase {
  constructor(private readonly assets: MediaAssetRepository) {}

  async execute(request: ListMediaAssetsRequest): Promise<MediaAssetListResult> {
    return this.assets.list({
      limit: request.limit,
      cursor: request.cursor,
      search: request.search,
    });
  }
}
