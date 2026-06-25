/**
 * Optional first-party media storage — **public bucket only**. Not
 * part of the required v0.1.0 provisioning path: starters must keep
 * working without an implementation.
 *
 * # Multi-variant by default (#272)
 *
 * Every committed `MediaAsset` carries one or more `variants` — at
 * minimum the format `<img>` falls back to (`role: "primary"`), and
 * typically additional formats (`webp`, `avif`) the renderer prefers
 * via `<picture>`. Variant *bytes* are produced agent-side by
 * `@aotter/mantle-media-tools` (sharp / libvips); the Worker only
 * receives already-processed uploads and enforces policy. workerd
 * has no usable image-processing stack — pushing optimization onto
 * the agent sidesteps that entirely.
 *
 * # Scope: public bucket only
 *
 * `getPublicUrl()` returns an unconditional public URL; reads bypass
 * the Worker (`MEDIA_PUBLIC_URL_BASE` → CDN → R2). Each variant's
 * `publicUrl` is frozen at commit time. The asset is persisted to the
 * `media_assets` table by the commit use case; entries reference it
 * by `MediaAsset.id` (`x-mantle-ref: media_assets`) and the renderer
 * calls `runtime.media.resolve(id)` to materialise the full variants
 * set at render time.
 *
 * **Private content (subscription-gated, fan-club, signed-GET, etc.)
 * is a separate port + separate R2 bucket in v0.2** — see ADR-0011
 * § "Public vs private media — two buckets, two ports". The private
 * port will live alongside this one (`PrivateMediaStorage`); current
 * callers stay untouched. Don't bolt a `visibility` flag onto this
 * port to retrofit private semantics — that's not the seam.
 *
 * Method-arg shapes use the `*Args` suffix (matching `EntryRepository`)
 * to leave the `*Request` / `*Response` namespace for use-case DTOs in
 * `usecase/dto/media/`.
 */
export interface MediaStorage {
  /** Issue presigned direct-upload capabilities for every declared
   *  variant of one logical asset. The adapter mints storage keys
   *  (typically under a shared `<uploadGroupId>/` prefix) and signs a
   *  PUT URL per variant. */
  createUpload(args: CreateUploadArgs): Promise<CreateUploadResult>;

  /** Commit a previously-PUT variant bundle. The adapter HEADs every
   *  storageKey, verifies actual mime + bytes, and returns a fully
   *  populated `MediaAsset` — the use case then persists it to the
   *  `media_assets` table via `MediaAssetRepository.save`. All-or-
   *  nothing: any variant failing verification rejects the whole
   *  commit. */
  commitUpload(args: CommitUploadArgs): Promise<MediaAsset>;

  /** Resolve the stable public URL for a single stored object by
   *  storageKey. Used by adapter internals and the orphan sweeper
   *  (#254); render paths read URLs straight off `MediaAsset.variants`
   *  rather than calling this per request. */
  getPublicUrl(args: GetPublicUrlArgs): Promise<string>;

  /** Delete a single stored object. The use-case-level deletion path
   *  orchestrates "lookup by asset id → delete every variant object →
   *  delete media_assets row" by calling this once per variant. */
  deleteObject(args: DeleteObjectArgs): Promise<void>;

}


/** Variant role within a logical asset.
 *
 * - `primary` — the `<img>` / fallback rendering. Every asset has
 *   exactly one. Conventionally jpeg / png (universal browser support).
 * - `alternate` — additional format candidates the renderer prefers
 *   via `<picture><source>`. Modern formats (avif, webp).
 * - `fallback` — reserved for future use (e.g. very-small thumbnail
 *   for above-the-fold inlining). Not currently emitted by the
 *   `media-tools` agent script.
 */
export type MediaVariantRole = "primary" | "alternate" | "fallback";

export interface CreateUploadArgs {
  /** Logical asset id — also the future `MediaAsset.id`. Minted by
   *  the use case via `IdGenerator`; the adapter uses it as the
   *  storage-key prefix so every variant of one asset lives under a
   *  common path. */
  readonly uploadGroupId: string;
  readonly purpose: string;
  /** Original filename — stamped into each variant's customMetadata
   *  at commit time. Storage keys remain server-generated; the
   *  filename is purely for operator visibility in R2 / S3 dashboards
   *  and for renderers that want to recover a download name. */
  readonly filename: string;
  readonly variants: ReadonlyArray<CreateUploadVariantSpec>;
  readonly now: number;
  readonly expiresAt: number;
  /** Optional opaque metadata the adapter may stamp onto the stored
   *  objects (e.g. customer tag, deployment env). Not interpreted. */
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface CreateUploadVariantSpec {
  readonly mimeType: string;
  /** Caller-declared payload size. The use case already verified it
   *  satisfies `maxBytes`; passed through so the adapter can forward
   *  it as a Content-Length hint where the backend supports one. */
  readonly byteSize: number;
  /** Per-mime cap, sourced from `siteDefaults.media.purposes[name].maxBytes`. */
  readonly maxBytes: number;
  readonly role: MediaVariantRole;
}

export interface CreateUploadResult {
  readonly uploadGroupId: string;
  readonly capabilities: ReadonlyArray<UploadCapability>;
  readonly expiresAt: number;
}

export interface UploadCapability {
  readonly mimeType: string;
  readonly role: MediaVariantRole;
  readonly method: "PUT";
  readonly uploadUrl: string;
  readonly storageKey: string;
  readonly publicUrl: string;
  readonly requiredHeaders?: Readonly<Record<string, string>>;
}

/**
 * Adapter contract: for each variant, before populating the returned
 * `MediaAsset`, verify the stored object's actual content-type
 * matches `mimeType` and actual byte size ≤ `maxBytes`. Any failure
 * rejects the whole bundle with `DiagnosticError(MEDIA_MIME_REJECTED)`
 * or `MEDIA_VARIANT_SIZE_EXCEEDED`. Without adapter-side verification,
 * a caller can declare `image/png` and PUT a PDF.
 */
export interface CommitUploadArgs {
  readonly uploadGroupId: string;
  /** Original filename forwarded from the create-time call; adapter
   *  stamps it into each variant's customMetadata so operator
   *  dashboards see the human-meaningful name alongside the
   *  server-generated storage key. */
  readonly filename: string;
  readonly variants: ReadonlyArray<CommitUploadVariantSpec>;
  readonly alt?: string;
  readonly caption?: string;
  readonly now: number;
}

export interface CommitUploadVariantSpec {
  readonly mimeType: string;
  readonly role: MediaVariantRole;
  readonly storageKey: string;
  readonly maxBytes: number;
}

export interface GetPublicUrlArgs {
  readonly storageKey: string;
}

export interface DeleteObjectArgs {
  readonly storageKey: string;
}

/**
 * Committed asset — what `commitUpload` returns and what the
 * `media_assets` table persists. Renderers consume `variants`
 * directly; `<picture>` emits one `<source>` per non-primary
 * variant with `<img>` falling back to the primary one. There is
 * no top-level `publicUrl` — that single-URL world is what
 * #272 replaces.
 */
export interface MediaAsset {
  readonly id: string;
  readonly variants: ReadonlyArray<MediaVariant>;
  readonly alt?: string;
  readonly caption?: string;
  readonly createdAt: number;
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface MediaVariant {
  readonly mimeType: string;
  readonly publicUrl: string;
  readonly storageKey: string;
  readonly byteSize: number;
  readonly role: MediaVariantRole;
}

/** Pick the primary variant (the one `<img>` falls back to). Helper
 *  for renderers / SSR that want one URL when they don't care about
 *  the full `<picture>` form. Throws if the asset has no primary —
 *  the use case rejects commits in that shape, so a runtime-reachable
 *  asset always has one. */
export function pickPrimaryVariant(asset: MediaAsset): MediaVariant {
  const primary = asset.variants.find((v) => v.role === "primary");
  if (!primary) {
    throw new Error(
      `MediaAsset ${asset.id} has no primary variant — commit invariant violated`,
    );
  }
  return primary;
}
