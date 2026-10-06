import { beforeEach, expect, it } from "vitest";
import { r2MediaStorage } from "../../src/cloudflare/index.js";
import { DiagnosticError } from "../../src/spec/index.js";

type Obj = { size: number; body: ReadableStream; httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> };
const objects = new Map<string, Obj>();
const deleted: string[] = [];
const bucket = {
  head: async (k: string) => objects.get(k) ?? null,
  get: async (k: string) => objects.get(k) ?? null,
  put: async (k: string, body: ReadableStream, o: { httpMetadata: { contentType: string }; customMetadata: Record<string, string> }) => { objects.set(k, { size: objects.get(`uploads/${k}`)?.size ?? -1, body, ...o }); return {}; },
  delete: async (k: string) => { deleted.push(k); objects.delete(k); },
};
const signer = { sign: async (url: string, init: { method: string }) => ({ url: `${url}&X-Amz-Signature=${init.method}` }) };
const media = r2MediaStorage({ bucket, signer, endpoint: "https://b.acc.r2.cloudflarestorage.com/", publicBase: "https://cdn.test/" });
/** What a PUT to an upload URL does: any type, any size. */
const put = (key: string, contentType: string, size: number) => objects.set(key, { size, body: new ReadableStream(), httpMetadata: { contentType } });
const code = (p: Promise<unknown>) => p.then(() => null, (e) => (e instanceof DiagnosticError ? e.diagnostics[0]!.code : String(e)));
beforeEach(() => { objects.clear(); deleted.length = 0; });

it("presigns one PUT per variant under an upload-only key; the type and size are checked at commit, since a presigned PUT binds neither", async () => {
  const { capabilities } = await media.createUpload({ uploadGroupId: "g1", purpose: "cover", filename: "a.jpg", now: 0, expiresAt: 900_000, variants: [{ mimeType: "image/jpeg", byteSize: 9, maxBytes: 10, role: "primary" }, { mimeType: "image/webp", byteSize: 5, maxBytes: 10, role: "alternate" }] });
  expect(capabilities).toEqual([
    { mimeType: "image/jpeg", role: "primary", method: "PUT", storageKey: "uploads/cover/g1/primary.jpg", uploadUrl: "https://b.acc.r2.cloudflarestorage.com/uploads/cover/g1/primary.jpg?X-Amz-Expires=900&X-Amz-Signature=PUT", requiredHeaders: { "Content-Type": "image/jpeg" } },
    { mimeType: "image/webp", role: "alternate", method: "PUT", storageKey: "uploads/cover/g1/alternate.webp", uploadUrl: "https://b.acc.r2.cloudflarestorage.com/uploads/cover/g1/alternate.webp?X-Amz-Expires=900&X-Amz-Signature=PUT", requiredHeaders: { "Content-Type": "image/webp" } },
  ]);
});

const spec = { mimeType: "image/jpeg", role: "primary" as const, storageKey: "uploads/cover/g1/primary.jpg", maxBytes: 9 };
const commit = (variants = [spec]) => media.commitUpload({ uploadGroupId: "g1", filename: "a.jpg", variants, alt: "A", now: 7 });

it("commit checks every object's presence, type and size and publishes nothing when one fails", async () => {
  expect(await code(commit())).toBe("MEDIA_OBJECT_NOT_FOUND");
  put(spec.storageKey, "application/pdf", 9);
  expect(await code(commit())).toBe("MEDIA_MIME_REJECTED");
  put(spec.storageKey, "image/jpeg", 10);
  expect(await code(commit())).toBe("MEDIA_VARIANT_SIZE_EXCEEDED");
  put(spec.storageKey, "image/jpeg", 9);
  // the second variant is missing: the first, which passed, is not published either
  expect(await code(commit([spec, { ...spec, mimeType: "image/webp", role: "alternate", storageKey: "uploads/cover/g1/alternate.webp" }]))).toBe("MEDIA_OBJECT_NOT_FOUND");
  expect([...objects.keys()]).toEqual([spec.storageKey]);
});

it("commit copies to a public key no upload URL names and deletes the upload key; a later PUT through the old URL cannot touch it", async () => {
  put(spec.storageKey, "image/jpeg", 9);
  expect(await commit()).toEqual({ id: "g1", alt: "A", createdAt: 7, metadata: { filename: "a.jpg" }, variants: [{ mimeType: "image/jpeg", role: "primary", storageKey: "cover/g1/primary.jpg", byteSize: 9, publicUrl: "https://cdn.test/cover/g1/primary.jpg" }] });
  expect(objects.get("cover/g1/primary.jpg")?.customMetadata).toEqual({ committedAt: "7", role: "primary", uploadGroupId: "g1", filename: "a.jpg", alt: "A" });
  expect(deleted).toEqual([spec.storageKey]);
  // the presigned URL is still valid until it expires, and it only ever names the upload key
  put(spec.storageKey, "text/html", 10_000);
  expect(objects.get("cover/g1/primary.jpg")?.httpMetadata?.contentType).toBe("image/jpeg");
  await media.deleteObject({ storageKey: "cover/g1/primary.jpg" });
  expect(objects.has("cover/g1/primary.jpg")).toBe(false);
  expect(() => r2MediaStorage({ bucket, signer, endpoint: "x", publicBase: "" })).toThrow(/publicBase/);
});

it("an object PUT again between the check and the copy is refused, and the variants already published are deleted", async () => {
  const alt = { ...spec, mimeType: "image/webp", role: "alternate" as const, storageKey: "uploads/cover/g1/alternate.webp" };
  put(spec.storageKey, "image/jpeg", 9);
  put(alt.storageKey, "image/webp", 5);
  const get = bucket.get;
  bucket.get = async (k) => (k === alt.storageKey ? { ...objects.get(k)!, size: 9_999 } : get(k));
  try {
    expect(await code(commit([spec, alt]))).toBe("MEDIA_OBJECT_NOT_FOUND");
  } finally { bucket.get = get; }
  expect(objects.has("cover/g1/primary.jpg")).toBe(false);
});
