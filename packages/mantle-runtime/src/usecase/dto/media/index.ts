/**
 * Media use-case DTOs. Distinct from `MediaStorage` port request types:
 * the use case receives caller-supplied variant declarations, derives
 * the rest (uploadGroupId via IdGenerator, storage keys via the
 * adapter, expiresAt via the clock, per-mime maxBytes via site
 * config), and forwards port-shaped requests internally.
 *
 * The shape is multi-variant from the start (#272): one
 * `create_media_upload` call yields N presigned URLs (one per
 * format), and one `commit_media_upload` finalises the whole
 * bundle. Optimization runs agent-side in the MCP client's runtime
 * or operator tooling — the runtime never transforms bytes.
 */

import type { MediaVariantRole } from "../../../domain/port/MediaStorage.js";

export interface CreateMediaUploadRequest {
  readonly filename: string;
  readonly purpose: string;
  readonly variants: ReadonlyArray<CreateMediaUploadVariantRequest>;
  readonly alt?: string;
  readonly caption?: string;
}

export interface CreateMediaUploadVariantRequest {
  readonly mimeType: string;
  /** Caller-declared payload size. Verified at create time so the
   *  Worker rejects oversized variants before signing a PUT URL. */
  readonly byteSize: number;
  readonly role: MediaVariantRole;
}

export interface CreateMediaUploadResponse {
  /** Logical asset id — also the future `MediaAsset.id`. Caller
   *  passes this verbatim to `commit_media_upload`. */
  readonly uploadGroupId: string;
  readonly capabilities: ReadonlyArray<CreateMediaUploadVariantCapability>;
  readonly expiresAt: number;
}

export interface CreateMediaUploadVariantCapability {
  readonly mimeType: string;
  readonly role: MediaVariantRole;
  readonly method: "PUT";
  readonly uploadUrl: string;
  readonly requiredHeaders?: Readonly<Record<string, string>>;
}

export interface CommitMediaUploadRequest {
  readonly uploadGroupId: string;
  readonly alt?: string;
  readonly caption?: string;
}

/** Admin media library list request (#434). Cursor-paginated,
 *  newest-first; `search` is an optional substring over id/alt/caption. */
export interface ListMediaAssetsRequest {
  readonly limit?: number;
  readonly cursor?: string;
  readonly search?: string;
}

/** Patch alt/caption on a committed asset (#434). Only these two
 *  fields are operator-editable — variants/mime/bytes are frozen at
 *  commit. `undefined` leaves a field unchanged; an empty string
 *  clears it. */
export interface UpdateMediaAssetRequest {
  readonly id: string;
  readonly alt?: string;
  readonly caption?: string;
}
