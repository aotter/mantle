import { DiagnosticError } from "@aotter/mantle-spec";
import type { MediaAssetRepository } from "../../domain/port/MediaAssetRepository.js";
import type {
  MediaAsset,
  MediaStorage,
  MediaVariant,
} from "../../domain/port/MediaStorage.js";
import { mediaAssetNotFoundDiagnostic } from "./diagnostics.js";

export class AdminMediaLibraryUseCase {
  constructor(
    private readonly assets: MediaAssetRepository,
    private readonly storage: MediaStorage,
  ) {}

  async list(request: ListAdminMediaAssetsRequest): Promise<ListAdminMediaAssetsResponse> {
    const result = await this.assets.list({
      limit: request.limit,
      cursor: request.cursor,
      search: request.search,
    });
    return {
      items: result.items.map((asset) => adminMediaAsset(asset, asset.ownerId ?? null)),
      next_cursor: result.nextCursor ?? null,
    };
  }

  async update(request: UpdateAdminMediaAssetRequest): Promise<AdminMediaAsset> {
    const updated = await this.assets.update(request.id, {
      alt: stringOrUndefined(request.alt),
      caption: stringOrUndefined(request.caption),
    });
    if (!updated) {
      throw new DiagnosticError(mediaAssetNotFoundDiagnostic("usecase/AdminMediaLibrary/update", request.id));
    }
    return adminMediaAsset(updated, null);
  }

  async delete(request: DeleteAdminMediaAssetRequest): Promise<DeleteAdminMediaAssetResponse> {
    const asset = await this.assets.findById(request.id);
    if (!asset) {
      throw new DiagnosticError(mediaAssetNotFoundDiagnostic("usecase/AdminMediaLibrary/delete", request.id));
    }

    for (const variant of asset.variants) {
      await this.storage.deleteObject({ storageKey: variant.storageKey });
    }
    await this.assets.delete(request.id);
    return { removed: true };
  }
}

export interface ListAdminMediaAssetsRequest {
  readonly limit: number;
  readonly cursor?: string;
  readonly search?: string;
}

export interface ListAdminMediaAssetsResponse {
  readonly items: ReadonlyArray<AdminMediaAsset>;
  readonly next_cursor: string | null;
}

export interface UpdateAdminMediaAssetRequest {
  readonly id: string;
  readonly alt?: string | null;
  readonly caption?: string | null;
}

export interface DeleteAdminMediaAssetRequest {
  readonly id: string;
}

export interface DeleteAdminMediaAssetResponse {
  readonly removed: true;
}

export interface AdminMediaAsset {
  readonly id: string;
  readonly alt: string | null;
  readonly caption: string | null;
  readonly createdAt: number;
  readonly ownerId: string | null;
  readonly variants: ReadonlyArray<AdminMediaVariant>;
  readonly primaryUrl: string | null;
  readonly primaryMimeType: string | null;
  readonly totalBytes: number;
  readonly metadata: Readonly<Record<string, string>> | null;
}

export interface AdminMediaVariant {
  readonly mimeType: string;
  readonly publicUrl: string;
  readonly storageKey: string;
  readonly byteSize: number;
  readonly role: MediaVariant["role"];
}

function adminMediaAsset(asset: MediaAsset, ownerId: string | null): AdminMediaAsset {
  const primary = asset.variants.find((variant) => variant.role === "primary") ?? asset.variants[0] ?? null;
  return {
    id: asset.id,
    alt: asset.alt ?? null,
    caption: asset.caption ?? null,
    createdAt: asset.createdAt,
    ownerId,
    variants: asset.variants.map((variant) => ({
      mimeType: variant.mimeType,
      publicUrl: variant.publicUrl,
      storageKey: variant.storageKey,
      byteSize: variant.byteSize,
      role: variant.role,
    })),
    primaryUrl: primary?.publicUrl ?? null,
    primaryMimeType: primary?.mimeType ?? null,
    totalBytes: asset.variants.reduce((sum, variant) => sum + variant.byteSize, 0),
    metadata: asset.metadata ?? null,
  };
}

function stringOrUndefined(value: string | null | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}
