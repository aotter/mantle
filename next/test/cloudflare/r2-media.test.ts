import { expect, it } from "vitest";
import { r2MediaStorage } from "../../src/cloudflare/index.js";
import { DiagnosticError } from "../../src/spec/index.js";

const objects = new Map<string, { size: number; body: ReadableStream; httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }>();
const puts: [string, Record<string, string>][] = [];
const deleted: string[] = [];
const bucket = {
  get: async (k: string) => objects.get(k) ?? null,
  put: async (k: string, _b: ReadableStream, o: { customMetadata: Record<string, string> }) => { puts.push([k, o.customMetadata]); return {}; },
  delete: async (k: string) => { deleted.push(k); },
};
const signer = { sign: async (url: string, init: { method: string }) => ({ url: `${url}&X-Amz-Signature=${init.method}` }) };
const media = r2MediaStorage({ bucket, signer, endpoint: "https://b.acc.r2.cloudflarestorage.com/", publicBase: "https://cdn.test/" });
const put = (key: string, contentType: string, size: number) => objects.set(key, { size, body: new ReadableStream(), httpMetadata: { contentType } });
const code = (p: Promise<unknown>) => p.then(() => null, (e) => (e instanceof DiagnosticError ? e.diagnostics[0]!.code : String(e)));

it("presigns one PUT per variant under purpose/group/role, pinned to the content type", async () => {
  const { capabilities } = await media.createUpload({ uploadGroupId: "g1", purpose: "cover", filename: "a.jpg", now: 0, expiresAt: 900_000, variants: [{ mimeType: "image/jpeg", byteSize: 9, maxBytes: 10, role: "primary" }, { mimeType: "image/webp", byteSize: 5, maxBytes: 10, role: "alternate" }] });
  expect(capabilities).toEqual([
    { mimeType: "image/jpeg", role: "primary", method: "PUT", storageKey: "cover/g1/primary.jpg", uploadUrl: "https://b.acc.r2.cloudflarestorage.com/cover/g1/primary.jpg?X-Amz-Expires=900&X-Amz-Signature=PUT", requiredHeaders: { "Content-Type": "image/jpeg" } },
    { mimeType: "image/webp", role: "alternate", method: "PUT", storageKey: "cover/g1/alternate.webp", uploadUrl: "https://b.acc.r2.cloudflarestorage.com/cover/g1/alternate.webp?X-Amz-Expires=900&X-Amz-Signature=PUT", requiredHeaders: { "Content-Type": "image/webp" } },
  ]);
});

it("commit checks each stored object's presence, type and size, then stamps it; delete removes the object", async () => {
  const spec = { mimeType: "image/jpeg", role: "primary" as const, storageKey: "cover/g1/primary.jpg", maxBytes: 9 };
  const commit = () => media.commitUpload({ uploadGroupId: "g1", filename: "a.jpg", variants: [spec], alt: "A", now: 7 });
  expect(await code(commit())).toBe("MEDIA_OBJECT_NOT_FOUND");
  put(spec.storageKey, "application/pdf", 9);
  expect(await code(commit())).toBe("MEDIA_MIME_REJECTED");
  put(spec.storageKey, "image/jpeg", 10);
  expect(await code(commit())).toBe("MEDIA_VARIANT_SIZE_EXCEEDED");
  put(spec.storageKey, "image/jpeg", 9);
  expect(puts).toEqual([]);
  expect(await commit()).toEqual({ id: "g1", alt: "A", createdAt: 7, metadata: { filename: "a.jpg" }, variants: [{ mimeType: "image/jpeg", role: "primary", storageKey: spec.storageKey, byteSize: 9, publicUrl: "https://cdn.test/cover/g1/primary.jpg" }] });
  expect(puts).toEqual([[spec.storageKey, { committedAt: "7", role: "primary", uploadGroupId: "g1", filename: "a.jpg", alt: "A" }]]);
  await media.deleteObject({ storageKey: spec.storageKey });
  expect(deleted).toEqual([spec.storageKey]);
  expect(() => r2MediaStorage({ bucket, signer, endpoint: "x", publicBase: "" })).toThrow(/publicBase/);
});
