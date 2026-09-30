/**
 * Site config and media: the runtime's one optional capability over Core's product tables `site_config`, `media_assets` and
 * `pending_media_uploads` (ADR-0032 decision 11). A storage adapter given `site` defaults returns it; a runtime without it boots.
 */
import type { SiteConfig } from "../spec/index.js";

/** What the Admin settings page edits. An omitted field is unchanged; an empty string clears it. */
export interface SiteSettings {
  readonly brand?: string;
  readonly title?: string;
  readonly description?: string;
}

export interface MantleSite {
  /** Stored values over the defaults: operator fields were seeded once, deployment fields synced at boot. */
  read(): Promise<SiteConfig>;
  updateSettings(values: SiteSettings): Promise<SiteConfig>;
  /** The media library over this site's tables, its objects in `storage`. */
  media(storage: MediaStorage): MediaLibrary;
}

export type MediaVariantRole = "primary" | "alternate" | "fallback";

export interface MediaVariant {
  readonly mimeType: string;
  readonly publicUrl: string;
  readonly storageKey: string;
  readonly byteSize: number;
  readonly role: MediaVariantRole;
}

/** A committed asset. Times are milliseconds since the epoch. */
export interface MediaAsset {
  readonly id: string;
  readonly variants: readonly MediaVariant[];
  readonly alt?: string;
  readonly caption?: string;
  readonly createdAt: number;
  readonly metadata?: Readonly<Record<string, string>>;
}

/** Object storage for media, public bucket only. The bytes go to `uploadUrl` directly, never through the Worker. */
export interface MediaStorage {
  /** One short-lived PUT capability per variant, keyed under `uploadGroupId`. */
  createUpload(args: {
    readonly uploadGroupId: string;
    readonly purpose: string;
    readonly filename: string;
    readonly variants: readonly { readonly mimeType: string; readonly byteSize: number; readonly maxBytes: number; readonly role: MediaVariantRole }[];
    readonly now: number;
    readonly expiresAt: number;
  }): Promise<{
    readonly capabilities: readonly { readonly mimeType: string; readonly role: MediaVariantRole; readonly method: "PUT"; readonly uploadUrl: string; readonly storageKey: string; readonly requiredHeaders?: Readonly<Record<string, string>> }[];
  }>;
  /** Checks every stored object's type and size (`MEDIA_OBJECT_NOT_FOUND`, `MEDIA_MIME_REJECTED`, `MEDIA_VARIANT_SIZE_EXCEEDED`), all or nothing. */
  commitUpload(args: {
    readonly uploadGroupId: string;
    readonly filename: string;
    readonly variants: readonly { readonly mimeType: string; readonly role: MediaVariantRole; readonly storageKey: string; readonly maxBytes: number }[];
    readonly alt?: string;
    readonly caption?: string;
    readonly now: number;
  }): Promise<MediaAsset>;
  /** Idempotent. */
  deleteObject(args: { readonly storageKey: string }): Promise<void>;
}

/** The media use cases. Each checks its own input, so any surface can hand it a request body. */
export interface MediaLibrary {
  /** `{ filename, purpose, variants: [{ mimeType, byteSize, role }], alt?, caption? }` against the site's media purposes. */
  createUpload(request: unknown): Promise<{
    readonly uploadGroupId: string;
    readonly capabilities: readonly { readonly mimeType: string; readonly role: MediaVariantRole; readonly method: "PUT"; readonly uploadUrl: string; readonly requiredHeaders?: Readonly<Record<string, string>> }[];
    readonly expiresAt: number;
  }>;
  /** An unknown or expired group is `MEDIA_UPLOAD_EXPIRED`. */
  commitUpload(uploadGroupId: string, request?: unknown): Promise<MediaAsset>;
  /** Newest first; `search` matches id, alt and caption. */
  list(query: { readonly limit?: number; readonly cursor?: string; readonly search?: string }): Promise<{ readonly rows: readonly MediaAsset[]; readonly nextCursor?: string }>;
  get(id: string): Promise<MediaAsset>;
  /** `{ alt?, caption? }`: an omitted field is unchanged, an empty string clears it. */
  update(id: string, request: unknown): Promise<MediaAsset>;
  /** The objects first, then the row, so a partial failure can be retried with the same id. */
  delete(id: string): Promise<{ readonly deleted: true; readonly variantsRemoved: number }>;
}
