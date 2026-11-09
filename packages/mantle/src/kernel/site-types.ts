/** Optional site/media DTOs; asset times keep the 0.2 millisecond wire shape. */
export interface SiteIcon { readonly src: string; readonly mimeType?: string; readonly sizes?: readonly string[]; readonly theme?: "light" | "dark" }
export interface MediaPurposePolicy {
  readonly name: string;
  readonly required: readonly string[];
  readonly maxBytes: Readonly<Record<string, number>>;
  /**
   * `"public"` (the default when omitted) stores this purpose's assets in the public storage, each variant with a
   * permanent `publicUrl`. `"private"` stores them in the `private` storage of the `media` option and gives them no
   * URL on any surface; read one through `MediaLibrary.signRead` or `MediaStorage.signRead`. A purpose's visibility
   * does not change: moving it means moving its objects.
   */
  readonly visibility?: "public" | "private";
}
export interface SiteDefaults { readonly brand?: string; readonly title?: string; readonly description?: string; readonly origin?: string; readonly locales?: readonly string[]; readonly icons?: readonly SiteIcon[]; readonly media?: { readonly purposes?: readonly MediaPurposePolicy[] } }
export interface SiteConfig { readonly brand: string; readonly title: string; readonly description: string; readonly origin: string; readonly locales: readonly string[]; readonly canonicalLocale: string | null; readonly icons: readonly SiteIcon[]; readonly media: { readonly purposes: readonly MediaPurposePolicy[] } }
export interface SiteSettings {
  readonly brand?: string;
  readonly title?: string;
  readonly description?: string;
}

export interface MantleSite {
  /** Stored operator values over generated defaults; deployment fields are code constants. */
  read(): Promise<SiteConfig>;
  updateSettings(values: SiteSettings): Promise<SiteConfig>;
  /**
   * The media library over this site's tables, its objects in `storage`. A private purpose with no private storage is
   * `MEDIA_NOT_CONFIGURED` here.
   */
  media(storage: MediaStorageOption): MediaLibrary;
}

export type MediaVariantRole = "primary" | "alternate" | "fallback";

export interface MediaVariant {
  readonly mimeType: string;
  /** Absent on a private asset. */
  readonly publicUrl?: string;
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
  /** `"private"` when the asset's purpose is private: its variants have no `publicUrl`. Absent means public. */
  readonly visibility?: "private";
}

/**
 * The `media` option: one `MediaStorage`, which holds every purpose's objects and serves them publicly, or a public
 * and a private storage. Private purposes go to `private`.
 */
export type MediaStorageOption = MediaStorage | { readonly public: MediaStorage; readonly private: MediaStorage };

/** Object storage for media. The bytes go to `uploadUrl` directly, never through the Worker. */
export interface MediaStorage {
  /** The origin every `uploadUrl` PUTs to, such as the bucket's S3 endpoint: what an MCP App that uploads declares in its CSP `connectDomains`. */
  readonly uploadOrigin?: string;
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
  /**
   * Checks every uploaded object's type and size (`MEDIA_OBJECT_NOT_FOUND`, `MEDIA_MIME_REJECTED`, `MEDIA_VARIANT_SIZE_EXCEEDED`), all or
   * nothing, and publishes it under attempt-owned keys no upload URL reaches. Concurrent attempts must never overwrite
   * or remove each other's copies. On a rejection the caller deletes the upload keys.
   */
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
  /**
   * A short-lived read URL for one committed object, valid for `expiresIn` seconds. Optional; a private storage
   * implements it so its assets can be read at all. Mantle calls it only from `MediaLibrary.signRead`: no list, get or
   * commit signs anything. An application that lets other callers read a private asset calls it itself, after its own
   * check (for example in a `ref` handler), with a `storageKey` from the asset's variants. A signed URL is a bearer
   * capability: an MCP tool returns it only in the result `_meta` (`withResultMeta`), never in model-visible content.
   */
  signRead?(args: { readonly storageKey: string; readonly expiresIn: number }): Promise<string>;
}

/** The media use cases. Each checks its own input, so any surface can hand it a request body. */
export interface MediaLibrary {
  /** `{ filename, purpose, variants: [{ mimeType, byteSize, role }], alt?, caption? }` against the site's media purposes. */
  createUpload(request: unknown): Promise<{
    readonly uploadGroupId: string;
    readonly capabilities: readonly { readonly mimeType: string; readonly role: MediaVariantRole; readonly method: "PUT"; readonly uploadUrl: string; readonly requiredHeaders?: Readonly<Record<string, string>> }[];
    readonly expiresAt: number;
  }>;
  /** An unknown or expired group is `MEDIA_UPLOAD_EXPIRED`; one another server created is `MEDIA_NOT_OWNED`, as is its asset id in the calls below. */
  commitUpload(uploadGroupId: string, request?: unknown): Promise<MediaAsset>;
  /** Newest first; `search` matches the exact id, or text in alt or caption (up to 48 characters; a longer one matches the id alone). */
  list(query: { readonly limit?: number; readonly cursor?: string; readonly search?: string }): Promise<{ readonly rows: readonly MediaAsset[]; readonly nextCursor?: string }>;
  get(id: string): Promise<MediaAsset>;
  /** `{ alt?, caption? }`: an omitted field is unchanged, an empty string clears it. */
  update(id: string, request: unknown): Promise<MediaAsset>;
  /**
   * Read URLs for each variant: a public asset's `publicUrl`, or a private asset's `MediaStorage.signRead` URL valid
   * for `expiresIn` seconds (default 300), with `expiresAt` in milliseconds. A private storage without `signRead` is
   * `MEDIA_NOT_CONFIGURED`.
   */
  signRead(id: string, expiresIn?: number): Promise<{ readonly id: string; readonly variants: readonly { readonly mimeType: string; readonly role: MediaVariantRole; readonly url: string }[]; readonly expiresAt?: number }>;
  /** The objects first, then the row, so a partial failure can be retried with the same id. */
  delete(id: string): Promise<{ readonly deleted: true; readonly variantsRemoved: number }>;
}
