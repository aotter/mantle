import type { MediaVariantRole } from "../port/MediaStorage.js";

/** Canonical create-to-commit state for one media upload group. */
export interface PendingUploadRecord {
  readonly purpose: string;
  readonly filename: string;
  readonly variants: ReadonlyArray<PendingUploadVariant>;
  readonly alt?: string;
  readonly caption?: string;
  readonly expiresAt: number;
  readonly createdAt: number;
}

export interface PendingUploadVariant {
  readonly mimeType: string;
  readonly role: MediaVariantRole;
  readonly storageKey: string;
  readonly expectedSize: number;
  readonly maxBytes: number;
}
