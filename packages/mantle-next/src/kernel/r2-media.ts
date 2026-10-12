/** Native R2 binding plus an app-owned SigV4 signer. No SDK dependency. */
import { ContractError } from "./contracts.js";
import type { MediaStorage, MediaVariant } from "./site-types.js";
interface R2Head {
  readonly size: number;
  readonly httpMetadata?: { contentType?: string };
  readonly customMetadata?: Record<string, string>;
}
export interface R2Bucket {
  head(key: string): Promise<R2Head | null>;
  get(key: string): Promise<(R2Head & { readonly body: ReadableStream }) | null>;
  put(key: string, body: ReadableStream, options: { httpMetadata: { contentType: string }; customMetadata: Record<string, string> }): Promise<unknown>;
  delete(key: string | string[]): Promise<void>;
}
/** `aws4fetch`'s `AwsClient` has this shape. */
export interface S3Signer {
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
const UPLOADS = "uploads/";
const fail = (code: string, message: string) => new ContractError(code, message, "media/r2");

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
          const storageKey = `${UPLOADS}${purpose}/${uploadGroupId}/${v.role}.${EXT[v.mimeType] ?? "bin"}`;
          const target = new URL(`${s3}/${storageKey}`);
          target.searchParams.set("X-Amz-Expires", String(ttl));
          const { url } = await signer.sign(target.href, { method: "PUT", aws: { signQuery: true, service: "s3" } });
          return { mimeType: v.mimeType, role: v.role, method: "PUT" as const, uploadUrl: url, storageKey, requiredHeaders: { "Content-Type": v.mimeType } };
        })),
      };
    },

    async commitUpload({ uploadGroupId, filename, variants, alt, caption, now }) {
      // every variant is checked before any is published, so a rejected group publishes nothing
      const heads = await Promise.all(variants.map(spec => bucket.head(spec.storageKey)));
      for (const [i, spec] of variants.entries()) {
        const o = heads[i];
        if (!o) throw fail("MEDIA_OBJECT_NOT_FOUND", `variant ${spec.role} of '${uploadGroupId}' was not uploaded`);
        const mime = o.httpMetadata?.contentType ?? "application/octet-stream";
        if (mime !== spec.mimeType) throw fail("MEDIA_MIME_REJECTED", `the stored ${spec.role} is ${mime}, not ${spec.mimeType}`);
        if (o.size > spec.maxBytes) throw fail("MEDIA_VARIANT_SIZE_EXCEEDED", `the stored ${spec.role} is ${o.size} bytes, more than ${spec.maxBytes}`);
      }
      // Each attempt owns its public copies: a concurrent loser cannot overwrite or clean up a committed winner.
      const attempt = crypto.randomUUID();
      const out: MediaVariant[] = [];
      try {
        for (const [i, spec] of variants.entries()) {
          const key = `committed/${uploadGroupId}/${attempt}/${spec.role}.${EXT[spec.mimeType] ?? "bin"}`;
          const o = await bucket.get(spec.storageKey);
          // an upload URL may PUT again between the check and the copy: the copy must be what was checked
          if (!o || o.size !== heads[i]!.size || o.httpMetadata?.contentType !== spec.mimeType) {
            await o?.body.cancel().catch(() => undefined);
            throw fail("MEDIA_OBJECT_NOT_FOUND", `variant ${spec.role} of '${uploadGroupId}' changed during commit`);
          }
          // Remember a possibly published key before awaiting put: a failed response may still have stored it.
          out.push({ mimeType: spec.mimeType, publicUrl: `${base}/${key}`, storageKey: key, byteSize: o.size, role: spec.role });
          try {
            await bucket.put(key, o.body, {
              httpMetadata: { contentType: spec.mimeType },
              customMetadata: { ...o.customMetadata, committedAt: String(now), role: spec.role, uploadGroupId, filename, ...(alt ? { alt } : {}), ...(caption ? { caption } : {}) },
            });
          } catch (error) { await o.body.cancel().catch(() => undefined); throw error; }
        }
        // The use case removes upload keys only after its SQL transaction is durable.
      } catch (error) {
        const cleanup = await Promise.allSettled(out.map(v => bucket.delete(v.storageKey)));
        if (cleanup.some(r => r.status === "rejected")) throw new ContractError("PARTIAL_FAILURE", "Some copied variants could not be removed. Retry the same upload group.", "media/r2", {cause:error});
        throw error instanceof ContractError ? error : new ContractError("OUTCOME_UNKNOWN", "Object copy failed; retry the same upload group after reconciliation.", "media/r2", {cause:error});
      }
      return { id: uploadGroupId, variants: out, createdAt: now, metadata: { filename }, ...(alt !== undefined ? { alt } : {}), ...(caption !== undefined ? { caption } : {}) };
    },

    deleteObject: ({ storageKey }) => bucket.delete(storageKey),
  };
}
