/** Native R2 binding plus an app-owned SigV4 signer. No SDK dependency. */
import { ContractError } from "./contracts.js";
import { mediaError } from "./media.js";
import type { MediaStorage, MediaVariant } from "./site-types.js";
interface R2Head {
  readonly size: number;
  readonly httpMetadata?: { contentType?: string };
  readonly customMetadata?: Record<string, string>;
}
export interface R2Bucket {
  head(key: string): Promise<R2Head | null>;
  get(key: string): Promise<(R2Head & { readonly body: ReadableStream }) | null>;
  put(
    key: string,
    body: ReadableStream,
    options: {
      httpMetadata: { contentType: string; contentDisposition?: string };
      customMetadata: Record<string, string>;
    },
  ): Promise<unknown>;
  delete(key: string | string[]): Promise<void>;
}
/** `aws4fetch`'s `AwsClient` has this shape. */
export interface S3Signer {
  /**
   * A query-signed URL. A PUT passes its `Content-Type` in `headers` with `allHeaders: true`, so the signature covers it
   * (`X-Amz-SignedHeaders`) and the upload URL refuses another type.
   */
  sign(
    url: string,
    init: {
      method: "PUT" | "GET";
      headers?: Readonly<Record<string, string>>;
      aws: { signQuery: true; service: "s3"; allHeaders?: true };
    },
  ): Promise<{ url: string }>;
}

export interface R2MediaStorageOptions {
  readonly bucket: R2Bucket;
  readonly signer: S3Signer;
  /** This bucket's S3 endpoint, e.g. `https://<bucket>.<account>.r2.cloudflarestorage.com`. */
  readonly endpoint: string;
  /** The bucket's public URL, or `null` for a private bucket: its variants then get no `publicUrl`, and reads go through `signRead`. */
  readonly publicBase: string | null;
  /**
   * `true` by default: a type that is not a raster image, PDF, audio or video is stored with `Content-Disposition:
   * attachment` and private reads are signed to answer with it, and HTML, SVG, XML and JavaScript uploads are refused.
   * `false` turns both off, for a bucket served from an isolated origin: its own registrable domain, with nothing on it
   * that sets cookies.
   */
  readonly safeDelivery?: boolean;
}

const EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/gif": "gif",
  "image/svg+xml": "svg",
  "application/pdf": "pdf",
  "application/zip": "zip",
  "application/json": "json",
  "text/plain": "txt",
  "text/csv": "csv",
  "audio/mpeg": "mp3",
  "video/mp4": "mp4",
  "video/webm": "webm",
};
const UPLOADS = "uploads/";
const fail = (code: string, message: string, options?: ErrorOptions) => mediaError(code, message, "media/r2", options);
/** The type's extension, else the caller's filename's (never one a static host would serve as a page or script), else `bin`. */
const ext = (mimeType: string, filename: string) => {
  const named = /\.([a-z0-9]{1,10})$/.exec(filename.toLowerCase())?.[1];
  return (
    EXT[mimeType] ??
    (named && !/^([xsp]?html?|xht|mht(ml)?|php\d?|svgz?|[cm]?js|xml|xslt?)$/.test(named) ? named : "bin")
  );
};
const cancel = (o?: { body: ReadableStream } | null) => o?.body.cancel().catch(() => undefined);

/** Returns every optional member of `MediaStorage` (`uploadOrigin`, `signRead`), so a wrapper calls them without checks. */
export function r2MediaStorage({
  bucket,
  signer,
  endpoint,
  publicBase,
  safeDelivery = true,
}: R2MediaStorageOptions): Required<MediaStorage> {
  if (!publicBase && publicBase !== null)
    throw fail(
      "MEDIA_NOT_CONFIGURED",
      "R2 media storage needs publicBase, the bucket's public URL, or null for a private bucket",
    );
  const base = publicBase?.replace(/\/+$/, "");
  const s3 = endpoint.replace(/\/+$/, "");
  const signed = async (storageKey: string, seconds: number, disposition?: string) => {
    const target = new URL(`${s3}/${storageKey}`);
    target.searchParams.set("X-Amz-Expires", String(seconds));
    if (disposition) target.searchParams.set("response-content-disposition", disposition);
    return (await signer.sign(target.href, { method: "GET", aws: { signQuery: true, service: "s3" } })).url;
  };
  return {
    safeDelivery,
    uploadOrigin: new URL(s3).origin,
    async createUpload({ uploadGroupId, purpose, filename, variants, now, expiresAt }) {
      const ttl = Math.max(60, Math.floor((expiresAt - now) / 1000));
      return {
        capabilities: await Promise.all(
          variants.map(async v => {
            // server-made keys, one directory per asset so its variants list together
            const storageKey = `${UPLOADS}${purpose}/${uploadGroupId}/${v.role}.${ext(v.mimeType, filename)}`;
            return {
              mimeType: v.mimeType,
              role: v.role,
              method: "PUT" as const,
              // the type is signed: a PUT with another Content-Type fails the signature
              uploadUrl: (
                await signer.sign(`${s3}/${storageKey}?X-Amz-Expires=${ttl}`, {
                  method: "PUT",
                  headers: { "content-type": v.mimeType },
                  aws: { signQuery: true, service: "s3", allHeaders: true },
                })
              ).url,
              storageKey,
              requiredHeaders: { "Content-Type": v.mimeType },
            };
          }),
        ),
      };
    },

    async commitUpload({ uploadGroupId, filename, variants, alt, caption, now }) {
      // every variant is checked before any is published, so a rejected group publishes nothing
      const heads = await Promise.all(variants.map(spec => bucket.head(spec.storageKey)));
      for (const [i, spec] of variants.entries()) {
        const o = heads[i];
        if (!o) throw fail("MEDIA_OBJECT_NOT_FOUND", `variant ${spec.role} of '${uploadGroupId}' was not uploaded`);
        const mime = o.httpMetadata?.contentType ?? "application/octet-stream";
        if (mime !== spec.mimeType)
          throw fail("MEDIA_MIME_REJECTED", `the stored ${spec.role} is ${mime}, not ${spec.mimeType}`);
        if (o.size > spec.maxBytes)
          throw fail(
            "MEDIA_VARIANT_SIZE_EXCEEDED",
            `the stored ${spec.role} is ${o.size} bytes, more than ${spec.maxBytes}`,
          );
      }
      // Each attempt owns its public copies: a concurrent loser cannot overwrite or clean up a committed winner.
      const attempt = crypto.randomUUID();
      const out: MediaVariant[] = [];
      try {
        for (const [i, spec] of variants.entries()) {
          const key = `committed/${uploadGroupId}/${attempt}/${spec.role}.${ext(spec.mimeType, filename)}`;
          const o = await bucket.get(spec.storageKey);
          // an upload URL may PUT again between the check and the copy: the copy must be what was checked
          if (!o || o.size !== heads[i]!.size || o.httpMetadata?.contentType !== spec.mimeType) {
            await cancel(o);
            throw fail("MEDIA_OBJECT_NOT_FOUND", `variant ${spec.role} of '${uploadGroupId}' changed during commit`);
          }
          // The body streams from get to put, never whole in memory; the binding has no server-side copy.
          // Remember a possibly published key before awaiting put: a failed response may still have stored it.
          out.push({
            mimeType: spec.mimeType,
            ...(base === undefined ? {} : { publicUrl: `${base}/${key}` }),
            storageKey: key,
            byteSize: o.size,
            role: spec.role,
          });
          try {
            await bucket.put(key, o.body, {
              httpMetadata: {
                contentType: spec.mimeType,
                ...(spec.contentDisposition ? { contentDisposition: spec.contentDisposition } : {}),
              },
              customMetadata: {
                ...o.customMetadata,
                committedAt: String(now),
                role: spec.role,
                uploadGroupId,
                filename,
                ...(alt ? { alt } : {}),
                ...(caption ? { caption } : {}),
              },
            });
          } catch (error) {
            await cancel(o);
            throw error;
          }
        }
        // The use case removes upload keys only after its SQL transaction is durable.
      } catch (error) {
        const cleanup = await Promise.allSettled(out.map(v => bucket.delete(v.storageKey)));
        if (cleanup.some(r => r.status === "rejected"))
          throw fail("PARTIAL_FAILURE", "Some copied variants could not be removed. Retry the same upload group.", {
            cause: error,
          });
        throw error instanceof ContractError
          ? error
          : new ContractError(
              "OUTCOME_UNKNOWN",
              "Object copy failed; retry the same upload group after reconciliation.",
              "media/r2",
              { cause: error },
            );
      }
      return {
        id: uploadGroupId,
        variants: out,
        createdAt: now,
        metadata: { filename },
        ...(alt !== undefined ? { alt } : {}),
        ...(caption !== undefined ? { caption } : {}),
      };
    },

    deleteObject: ({ storageKey }) => bucket.delete(storageKey),
    signRead: ({ storageKey, expiresIn, contentDisposition }) => signed(storageKey, expiresIn, contentDisposition),
  };
}
