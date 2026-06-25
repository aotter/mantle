import { AwsClient } from "aws4fetch";
import { DiagnosticError, makeDiagnostic } from "@aotter/mantle-spec";
import {
  RandomUuidGenerator,
  extensionForMime,
  type CommitUploadArgs,
  type CommitUploadVariantSpec,
  type CreateUploadArgs,
  type CreateUploadResult,
  type CreateUploadVariantSpec,
  type DeleteObjectArgs,
  type GetPublicUrlArgs,
  type IdGenerator,
  type MediaAsset,
  type MediaStorage,
  type MediaVariant,
  type UploadCapability,
} from "@aotter/mantle-runtime";

/**
 * `R2MediaStorage` — `MediaStorage` adapter backed by Cloudflare R2,
 * **public bucket only**.
 *
 * The bound R2 bucket is expected to have public access enabled and
 * (typically) a custom domain or `pub-<hash>.r2.dev` URL pointing at
 * it. Reads bypass the Worker entirely. CORS on the bucket should be
 * scoped to the admin SPA origin so browser direct PUTs work without
 * exposing other origins.
 *
 * Two access modes — both required:
 *   - `bucket` (`R2Bucket` binding) — server-side `get` / `put` /
 *     `delete`. Used at commit-time to read uploaded-object metadata
 *     and rewrite it with `committedAt`, and to clean up failed
 *     uploads.
 *   - `s3` (`AwsClient` from `aws4fetch`) — SigV4 presigned PUT URL
 *     generation. The R2 binding cannot issue presigned URLs.
 *
 * Public URL resolution is fully consumer-supplied via `publicBase`.
 * The hash in `pub-<hash>.r2.dev` is opaque (assigned only after the
 * user enables public access on the bucket); custom domains are
 * configured separately. Adapters never derive the public URL from
 * account / bucket — the consumer must wire it through the `cmsConfig`
 * env (typically `MEDIA_PUBLIC_URL_BASE`).
 *
 * # Multi-variant (#272)
 *
 * `createUpload` produces one presigned PUT URL per declared variant;
 * `commitUpload` HEAD-verifies every one. Storage keys are scoped
 * under a shared `<uploadGroupId>/` prefix so operators can eyeball
 * the variant set in R2 dashboards, and the orphan sweeper (#254)
 * can identify partially-committed groups by listing the prefix.
 *
 * Optimization runs agent-side in the MCP client's runtime. The
 * Worker never decodes / re-encodes bytes — it only verifies content-
 * type + size on the metadata returned by R2's HEAD-equivalent path
 * (`bucket.get` + `httpMetadata`).
 *
 * # Future: private bucket adapter
 *
 * A v0.2 `R2PrivateMediaStorage` will live alongside this class and
 * implement a separate `PrivateMediaStorage` port. It binds a
 * different R2 bucket — public access disabled — and routes every
 * read through a Worker policy gate (staff / subscription check)
 * before streaming via `bucket.get()` or 302-ing to a short-lived
 * signed GET. **Two buckets, two ports**, by design — see ADR-0011
 * § "Public vs private media — two buckets, two ports". Don't bolt
 * a `visibility` flag onto this class to handle private content.
 */
export class R2MediaStorage implements MediaStorage {
  constructor(
    private readonly bucket: R2Bucket,
    private readonly s3: AwsClient,
    /** S3 endpoint for THIS bucket — must include the bucket as the
     *  subdomain, e.g. `https://<bucket>.<account>.r2.cloudflarestorage.com`.
     *  Used as the host for presigned PUT URLs. */
    private readonly s3Endpoint: string,
    /** Public read-base URL — `https://media.example.com` (custom
     *  domain) or `https://pub-<hash>.r2.dev` (R2 public dev domain).
     *  Trailing slash is normalised away. */
    publicBase: string,
    /** ID source for fallback storage-key randomness when an upstream
     *  caller lands without a usable upload-group prefix (defensive).
     *  Defaults to `RandomUuidGenerator`; tests inject a deterministic
     *  fake to assert exact key strings. **Production must use a
     *  CSPRNG-backed generator** — `uploadGroupId` is bearer-token-
     *  equivalent and a predictable storageKey leaks pre-commit
     *  object locations. See `IdGenerator`'s "Security invariant". */
    private readonly idgen: IdGenerator = RandomUuidGenerator,
  ) {
    if (!publicBase) {
      throw new DiagnosticError(
        makeDiagnostic({
          code: "MEDIA_NOT_CONFIGURED",
          phase: "runtime",
          severity: "error",
          path: "adapter/R2MediaStorage",
          expected: "publicBase URL (set MEDIA_PUBLIC_URL_BASE)",
        }),
      );
    }
    this.publicBase = publicBase.replace(/\/+$/, "");
  }

  private readonly publicBase: string;

  async createUpload(args: CreateUploadArgs): Promise<CreateUploadResult> {
    const ttlSeconds = Math.max(60, Math.floor((args.expiresAt - args.now) / 1000));
    const capabilities: UploadCapability[] = [];
    for (const variant of args.variants) {
      const storageKey = this.buildVariantStorageKey(
        args.uploadGroupId,
        args.purpose,
        variant,
      );
      // Sign-as-query: PUT URL with the SigV4 signature in the query
      // string. Browsers / agents PUT to this URL and we don't ask
      // them to mint signing headers. Pinning Content-Type into the
      // signature forces clients to send EXACTLY that header — browsers
      // strip mismatches and produce 403s; Content-Length is a
      // forbidden header. The signature already constrains key +
      // method + expiry; mime + size + etag are re-verified at
      // commit-time via `bucket.get`.
      const target = new URL(`${this.s3Endpoint.replace(/\/+$/, "")}/${storageKey}`);
      target.searchParams.set("X-Amz-Expires", String(ttlSeconds));
      const signed = await this.s3.sign(target.toString(), {
        method: "PUT",
        aws: { signQuery: true, service: "s3" },
      });
      capabilities.push({
        mimeType: variant.mimeType,
        role: variant.role,
        method: "PUT",
        uploadUrl: signed.url,
        storageKey,
        publicUrl: `${this.publicBase}/${storageKey}`,
        requiredHeaders: { "Content-Type": variant.mimeType },
      });
    }
    return {
      uploadGroupId: args.uploadGroupId,
      capabilities,
      expiresAt: args.expiresAt,
    };
  }

  async commitUpload(args: CommitUploadArgs): Promise<MediaAsset> {
    const variants: MediaVariant[] = [];
    for (const spec of args.variants) {
      variants.push(await this.verifyAndCommitVariant(args, spec));
    }

    // Enforce the asset-shape invariant the renderer depends on. The
    // use case already validated this at create time; this is a
    // belt-and-suspenders check at the adapter-side commit path.
    // Exactly one primary, no duplicated (mime, role) pair (the latter
    // would have already collided on storage key in createUpload).
    const primaries = variants.filter((v) => v.role === "primary");
    if (primaries.length !== 1) {
      throw new DiagnosticError(
        makeDiagnostic({
          code: "MEDIA_VARIANTS_INCOMPLETE",
          phase: "runtime",
          severity: "error",
          path: "adapter/R2MediaStorage/commitUpload",
          expected: "exactly one variant with role='primary'",
          value: variants.map((v) => v.role).join(","),
        }),
      );
    }
    const seenKey = new Set<string>();
    for (const v of variants) {
      const key = `${v.mimeType}/${v.role}`;
      if (seenKey.has(key)) {
        throw new DiagnosticError(
          makeDiagnostic({
            code: "MEDIA_VARIANTS_INCOMPLETE",
            phase: "runtime",
            severity: "error",
            path: "adapter/R2MediaStorage/commitUpload",
            expected: "unique (mimeType, role) per variant",
            value: key,
          }),
        );
      }
      seenKey.add(key);
    }

    return {
      id: args.uploadGroupId,
      variants,
      alt: args.alt,
      caption: args.caption,
      createdAt: args.now,
      metadata: { filename: args.filename },
    };
  }

  async getPublicUrl(args: GetPublicUrlArgs): Promise<string> {
    return `${this.publicBase}/${args.storageKey}`;
  }

  async deleteObject(args: DeleteObjectArgs): Promise<void> {
    await this.bucket.delete(args.storageKey);
  }


  private async verifyAndCommitVariant(
    args: CommitUploadArgs,
    spec: CommitUploadVariantSpec,
  ): Promise<MediaVariant> {
    // Single `get` covers existence + metadata + body stream for the
    // metadata-rewrite PUT. R2 has no metadata-only patch; the PUT
    // streams `existing.body` (a ReadableStream) back without
    // materialising bytes in Worker memory.
    const existing = await this.bucket.get(spec.storageKey);
    if (!existing) throw mediaDiagnostic("MEDIA_OBJECT_NOT_FOUND", { value: args.uploadGroupId });

    const actualMime = existing.httpMetadata?.contentType ?? "application/octet-stream";
    if (actualMime !== spec.mimeType) {
      throw mediaDiagnostic("MEDIA_MIME_REJECTED", {
        value: actualMime,
        expected: spec.mimeType,
      });
    }
    if (existing.size > spec.maxBytes) {
      throw mediaDiagnostic("MEDIA_VARIANT_SIZE_EXCEEDED", {
        value: { mimeType: spec.mimeType, byteSize: existing.size },
        expected: `${spec.mimeType} byteSize <= ${spec.maxBytes}`,
      });
    }

    const customMetadata: Record<string, string> = {
      ...existing.customMetadata,
      committedAt: String(args.now),
      role: spec.role,
      uploadGroupId: args.uploadGroupId,
      filename: args.filename,
    };
    if (args.alt) customMetadata["alt"] = args.alt;
    if (args.caption) customMetadata["caption"] = args.caption;

    await this.bucket.put(spec.storageKey, existing.body, {
      httpMetadata: { contentType: actualMime },
      customMetadata,
    });

    return {
      mimeType: actualMime,
      publicUrl: `${this.publicBase}/${spec.storageKey}`,
      storageKey: spec.storageKey,
      byteSize: existing.size,
      role: spec.role,
    };
  }

  /** Object keys are server-generated. Layout:
   *
   *   <purpose>/<uploadGroupId>/<role>.<ext>
   *
   * Purpose is prefixed (when it matches a permissive slug shape) so
   * operators can eyeball "post-cover/abc123/primary.jpg" in R2
   * dashboards. The `uploadGroupId/` directory groups every variant
   * of one logical asset — orphan sweep (#254) lists a prefix to
   * find partially-committed bundles. */
  private buildVariantStorageKey(
    uploadGroupId: string,
    purpose: string,
    variant: CreateUploadVariantSpec,
  ): string {
    const purposePrefix = /^[a-z0-9-]+$/.test(purpose) ? `${purpose}/` : "";
    const groupSegment = /^[A-Za-z0-9_-]+$/.test(uploadGroupId)
      ? uploadGroupId
      : this.idgen.next();
    const ext = extensionForMime(variant.mimeType);
    return `${purposePrefix}${groupSegment}/${variant.role}.${ext}`;
  }
}

function mediaDiagnostic(
  code:
    | "MEDIA_OBJECT_NOT_FOUND"
    | "MEDIA_MIME_REJECTED"
    | "MEDIA_VARIANT_SIZE_EXCEEDED",
  fields: { value: unknown; expected?: string },
): DiagnosticError {
  return new DiagnosticError(
    makeDiagnostic({
      code,
      phase: "runtime",
      severity: "error",
      path: "adapter/R2MediaStorage/commitUpload",
      ...fields,
    }),
  );
}
