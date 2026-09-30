/**
 * `MediaStorage` on R2, public bucket only. The binding reads, rewrites and deletes objects; it cannot presign, so the PUT
 * URLs are SigV4 query-signed by the host's S3 client (`new AwsClient({ accessKeyId, secretAccessKey, region: "auto", service: "s3" })` from `aws4fetch`).
 * Reads bypass the Worker: `publicBase` is the bucket's custom domain or `pub-<hash>.r2.dev`.
 */
import { DiagnosticError, makeDiagnostic, type DiagnosticCode } from "../spec/index.js";
import type { MediaStorage, MediaVariant } from "../core/site.js";

interface R2Object {
  readonly size: number;
  readonly body: ReadableStream;
  readonly httpMetadata?: { contentType?: string };
  readonly customMetadata?: Record<string, string>;
}
interface R2Bucket {
  get(key: string): Promise<R2Object | null>;
  put(key: string, body: ReadableStream, options: { httpMetadata: { contentType: string }; customMetadata: Record<string, string> }): Promise<unknown>;
  delete(key: string): Promise<void>;
}
/** `aws4fetch`'s `AwsClient` has this shape. */
interface S3Signer {
  sign(url: string, init: { method: "PUT"; aws: { signQuery: true; service: "s3" } }): Promise<{ url: string }>;
}

export interface R2MediaStorageOptions {
  readonly bucket: R2Bucket;
  readonly signer: S3Signer;
  /** This bucket's S3 endpoint, e.g. `https://<bucket>.<account>.r2.cloudflarestorage.com`. */
  readonly endpoint: string;
  readonly publicBase: string;
}

const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/avif": "avif", "image/gif": "gif" };
const fail = (code: DiagnosticCode, message: string, value?: unknown) =>
  new DiagnosticError(makeDiagnostic({ code, phase: "runtime", severity: "error", path: "media/r2", message, ...(value === undefined ? {} : { value }) }));

export function r2MediaStorage({ bucket, signer, endpoint, publicBase }: R2MediaStorageOptions): MediaStorage {
  if (!publicBase) throw fail("MEDIA_NOT_CONFIGURED", "R2 media storage needs publicBase, the bucket's public URL");
  const base = publicBase.replace(/\/+$/, "");
  const s3 = endpoint.replace(/\/+$/, "");
  return {
    async createUpload({ uploadGroupId, purpose, variants, now, expiresAt }) {
      const ttl = Math.max(60, Math.floor((expiresAt - now) / 1000));
      return {
        capabilities: await Promise.all(variants.map(async (v) => {
          // server-made keys, one directory per asset so its variants list together
          const storageKey = `${purpose}/${uploadGroupId}/${v.role}.${EXT[v.mimeType] ?? "bin"}`;
          const target = new URL(`${s3}/${storageKey}`);
          target.searchParams.set("X-Amz-Expires", String(ttl));
          const { url } = await signer.sign(target.href, { method: "PUT", aws: { signQuery: true, service: "s3" } });
          // the type and size are checked again at commit: a browser may not set Content-Length, and a signature cannot hold it
          return { mimeType: v.mimeType, role: v.role, method: "PUT" as const, uploadUrl: url, storageKey, requiredHeaders: { "Content-Type": v.mimeType } };
        })),
      };
    },

    async commitUpload({ uploadGroupId, filename, variants, alt, caption, now }) {
      const out: MediaVariant[] = [];
      for (const spec of variants) {
        const o = await bucket.get(spec.storageKey);
        if (!o) throw fail("MEDIA_OBJECT_NOT_FOUND", `variant ${spec.role} of '${uploadGroupId}' was not uploaded`, uploadGroupId);
        try {
          const mime = o.httpMetadata?.contentType ?? "application/octet-stream";
          if (mime !== spec.mimeType) throw fail("MEDIA_MIME_REJECTED", `the stored ${spec.role} is ${mime}, not ${spec.mimeType}`, mime);
          if (o.size > spec.maxBytes) throw fail("MEDIA_VARIANT_SIZE_EXCEEDED", `the stored ${spec.role} is ${o.size} bytes, more than ${spec.maxBytes}`, o.size);
          // R2 has no metadata-only update: the object streams back into itself with the commit stamped on
          await bucket.put(spec.storageKey, o.body, {
            httpMetadata: { contentType: mime },
            customMetadata: { ...o.customMetadata, committedAt: String(now), role: spec.role, uploadGroupId, filename, ...(alt ? { alt } : {}), ...(caption ? { caption } : {}) },
          });
        } catch (e) {
          await o.body.cancel().catch(() => undefined);
          throw e;
        }
        out.push({ mimeType: spec.mimeType, publicUrl: `${base}/${spec.storageKey}`, storageKey: spec.storageKey, byteSize: o.size, role: spec.role });
      }
      return { id: uploadGroupId, variants: out, createdAt: now, metadata: { filename }, ...(alt !== undefined ? { alt } : {}), ...(caption !== undefined ? { caption } : {}) };
    },

    deleteObject: ({ storageKey }) => bucket.delete(storageKey),
  };
}
