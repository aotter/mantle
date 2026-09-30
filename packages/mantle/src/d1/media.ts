/**
 * The media use cases over `media_assets` and `pending_media_uploads`. Optimization runs where the bytes are made (the agent,
 * the SPA); the Worker only enforces the purpose's policy and never transforms bytes. Times are milliseconds, as in 0.1.x rows.
 */
import { DiagnosticError, makeDiagnostic, type Diagnostic, type DiagnosticCode } from "../spec/kernel/index.js";
import { expandPolicyRequired, type MediaPurposePolicy } from "../spec/domain/index.js";
import type { DatabaseDriver } from "../core/driver.js";
import type { MediaAsset, MediaLibrary, MediaStorage, MediaVariantRole } from "../core/site.js";

const P = "media";
const fail = (code: DiagnosticCode, message: string, extra: Partial<Diagnostic> = {}) =>
  new DiagnosticError(makeDiagnostic({ code, phase: "runtime", severity: "error", path: P, message, ...extra }));
const bad = (expected: string) => fail("INPUT_VALIDATION_FAILED", `expected ${expected}`, { expected });

/** SVG is refused: object storage does not sanitize it, and an SVG can carry script. */
const ALLOWED = new Set(["image/png", "image/jpeg", "image/webp", "image/avif", "image/gif"]);
/** Modern formats a skipped optimization makes larger than the fallback. */
const MODERN = new Set(["image/avif", "image/webp"]);
const ROLES = new Set<unknown>(["primary", "alternate", "fallback"]);
const TTL_MS = 15 * 60 * 1000;

interface Pending {
  readonly purpose: string;
  readonly filename: string;
  readonly variants: readonly { mimeType: string; role: MediaVariantRole; storageKey: string; expectedSize: number; maxBytes: number }[];
  readonly alt?: string;
  readonly caption?: string;
  readonly expiresAt: number;
  readonly createdAt: number;
}

const obj = (v: unknown): Record<string, unknown> => (v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {});
const MAX_TEXT = 1000;
const MAX_FILENAME = 255;
/** `alt` and `caption`: absent, or a string of at most 1000 characters. */
function texts(body: unknown) {
  const b = obj(body);
  for (const k of ["alt", "caption"]) if (b[k] !== undefined && (typeof b[k] !== "string" || b[k].length > MAX_TEXT)) throw bad(`{ alt?: string, caption?: string }, each at most ${MAX_TEXT} characters`);
  return { ...(typeof b["alt"] === "string" ? { alt: b["alt"] } : {}), ...(typeof b["caption"] === "string" ? { caption: b["caption"] } : {}) } as { alt?: string; caption?: string };
}

/** Exactly one variant per required slot, nothing outside them, and exactly one primary. */
function checkVariants(policy: MediaPurposePolicy, variants: readonly { mimeType: string; byteSize: number; role: MediaVariantRole }[]) {
  const slots = expandPolicyRequired(policy.required);
  const slotOf = new Map(slots.flatMap((mimes, i) => mimes.map((m) => [m, i] as const)));
  const filled = variants.map((v) => slotOf.get(v.mimeType));
  if (filled.includes(undefined) || new Set(filled).size !== variants.length || filled.length !== slots.length || variants.filter((v) => v.role === "primary").length !== 1)
    throw fail("MEDIA_VARIANTS_INCOMPLETE", `purpose '${policy.name}' takes one variant for each of ${JSON.stringify(policy.required)}, exactly one of them primary`, { value: variants.map((v) => v.mimeType) });
  for (const v of variants) {
    if (v.mimeType === "image/svg+xml") throw fail("MEDIA_SVG_REJECTED", "SVG uploads are refused: object storage does not sanitize them");
    if (!ALLOWED.has(v.mimeType)) throw fail("MEDIA_MIME_REJECTED", `${v.mimeType} is not an accepted image type`, { expected: [...ALLOWED].join(", ") });
  }
  for (const v of variants) {
    const cap = policy.maxBytes[v.mimeType] ?? 0;
    if (v.byteSize > cap) throw fail("MEDIA_VARIANT_SIZE_EXCEEDED", `${v.mimeType} is ${v.byteSize} bytes; purpose '${policy.name}' allows ${cap}`, { expected: `${v.mimeType} byteSize <= ${cap}` });
  }
  const fallback = ["image/jpeg", "image/png", "image/gif"].map((m) => variants.find((v) => v.mimeType === m)).find(Boolean);
  const heavy = fallback && variants.find((v) => MODERN.has(v.mimeType) && v.byteSize > fallback.byteSize);
  if (heavy) throw fail("MEDIA_VARIANTS_SUSPICIOUS_SIZE", `${heavy.mimeType} (${heavy.byteSize}B) is larger than ${fallback!.mimeType} (${fallback!.byteSize}B): optimize it before uploading`);
}

const COLUMNS = "id, created_at, alt, caption, variants, metadata";
function assetOf(r: Record<string, unknown>): MediaAsset {
  return {
    id: String(r.id), variants: JSON.parse(String(r.variants)), createdAt: Number(r.created_at),
    ...(r.alt === null ? {} : { alt: String(r.alt) }), ...(r.caption === null ? {} : { caption: String(r.caption) }),
    ...(r.metadata === null ? {} : { metadata: JSON.parse(String(r.metadata)) }),
  };
}
const save = (a: MediaAsset) => ({
  sql: "INSERT INTO media_assets (id, created_at, owner_id, alt, caption, variants, metadata) VALUES (?1, ?2, NULL, ?3, ?4, ?5, ?6)",
  binds: [a.id, a.createdAt, a.alt ?? null, a.caption ?? null, JSON.stringify(a.variants), a.metadata ? JSON.stringify(a.metadata) : null],
});

export function mediaLibrary(driver: DatabaseDriver, storage: MediaStorage, purposes: () => Promise<readonly MediaPurposePolicy[]>, now = Date.now): MediaLibrary {
  const one = async (sql: string, binds: unknown[]) => (await driver.batch([{ sql, binds }]))[0]!.rows[0];
  const get = async (id: string) => {
    const r = await one(`SELECT ${COLUMNS} FROM media_assets WHERE id = ?1`, [id]);
    if (!r) throw fail("MEDIA_ASSET_NOT_FOUND", `no media asset '${id}'`);
    return assetOf(r);
  };

  return {
    async createUpload(request) {
      const b = obj(request);
      const variants = Array.isArray(b["variants"]) ? b["variants"].map(obj) : null;
      if (typeof b["filename"] !== "string" || b["filename"].length > MAX_FILENAME || typeof b["purpose"] !== "string" || !variants?.length
        || variants.some((v) => typeof v["mimeType"] !== "string" || !Number.isSafeInteger(v["byteSize"]) || (v["byteSize"] as number) <= 0 || !ROLES.has(v["role"])))
        throw bad("{ filename: string of at most 255 characters, purpose: string, variants: [{ mimeType: string, byteSize: positive integer, role: 'primary'|'alternate'|'fallback' }] }");
      const { filename, purpose } = b as { filename: string; purpose: string };
      const described = texts(b);
      const declared = await purposes();
      const policy = declared.find((p) => p.name === purpose);
      if (!policy) throw fail("MEDIA_PURPOSE_REJECTED", `purpose '${purpose}' is not declared`, { candidates: declared.map((p) => p.name) });
      const asked = variants as unknown as { mimeType: string; byteSize: number; role: MediaVariantRole }[];
      checkVariants(policy, asked);
      const at = now();
      const expiresAt = at + TTL_MS;
      // bearer-equivalent until commit: storage keys under it must not be guessable
      const uploadGroupId = crypto.randomUUID();
      const specs = asked.map(({ mimeType, byteSize, role }) => ({ mimeType, byteSize, role, maxBytes: policy.maxBytes[mimeType]! }));
      const { capabilities } = await storage.createUpload({ uploadGroupId, purpose, filename, variants: specs, now: at, expiresAt });
      const record: Pending = {
        purpose, filename, ...described, expiresAt, createdAt: at,
        variants: capabilities.map((c, i) => ({ mimeType: c.mimeType, role: c.role, storageKey: c.storageKey, expectedSize: specs[i]!.byteSize, maxBytes: specs[i]!.maxBytes })),
      };
      await driver.batch([
        { sql: "DELETE FROM pending_media_uploads WHERE expires_at <= ?1", binds: [at] },
        { sql: "INSERT INTO pending_media_uploads (id, record, expires_at) VALUES (?1, ?2, ?3)", binds: [uploadGroupId, JSON.stringify(record), expiresAt] },
      ]);
      return { uploadGroupId, capabilities: capabilities.map(({ mimeType, role, method, uploadUrl, requiredHeaders }) => ({ mimeType, role, method, uploadUrl, ...(requiredHeaders ? { requiredHeaders } : {}) })), expiresAt };
    },

    async commitUpload(uploadGroupId, request) {
      const patch = texts(request);
      const row = await one("SELECT record FROM pending_media_uploads WHERE id = ?1", [uploadGroupId]);
      const record = row ? JSON.parse(String(row.record)) as Pending : null;
      // a rejected group's objects are deleted: an upload URL takes any type and size, so what was PUT is not trusted
      const discard = () => Promise.allSettled((record?.variants ?? []).map((v) => storage.deleteObject({ storageKey: v.storageKey })));
      if (!record || record.expiresAt <= now()) {
        if (record) { await discard(); await driver.batch([{ sql: "DELETE FROM pending_media_uploads WHERE id = ?1", binds: [uploadGroupId] }]); }
        throw fail("MEDIA_UPLOAD_EXPIRED", `upload group '${uploadGroupId}' is unknown or expired; create a new upload`);
      }
      const asset = await storage.commitUpload({
        uploadGroupId, filename: record.filename, now: now(),
        // the declared size is the cap: a larger object than announced is refused
        variants: record.variants.map((v) => ({ mimeType: v.mimeType, role: v.role, storageKey: v.storageKey, maxBytes: Math.min(v.maxBytes, v.expectedSize) })),
        ...((patch.alt ?? record.alt) !== undefined ? { alt: patch.alt ?? record.alt } : {}),
        ...((patch.caption ?? record.caption) !== undefined ? { caption: patch.caption ?? record.caption } : {}),
      }).catch(async (e) => { await discard(); throw e; });
      await driver.batch([save(asset), { sql: "DELETE FROM pending_media_uploads WHERE id = ?1", binds: [uploadGroupId] }]);
      return asset;
    },

    async list({ limit, cursor, search }) {
      const n = limit ?? 50;
      const offset = cursor === undefined ? 0 : Number(cursor);
      if (!Number.isInteger(n) || n < 1 || n > 500 || !Number.isSafeInteger(offset) || offset < 0 || (cursor !== undefined && String(offset) !== cursor)) throw bad("limit 1..500 and a cursor this list returned");
      const term = search?.replace(/[\\%_]/g, (c) => `\\${c}`);
      const where = term ? "WHERE id LIKE ?3 ESCAPE '\\' OR alt LIKE ?3 ESCAPE '\\' OR caption LIKE ?3 ESCAPE '\\'" : "";
      const [page] = await driver.batch([{ sql: `SELECT ${COLUMNS} FROM media_assets ${where} ORDER BY created_at DESC, id DESC LIMIT ?1 OFFSET ?2`, binds: [n + 1, offset, ...(term ? [`%${term}%`] : [])] }]);
      const rows = page!.rows.slice(0, n).map(assetOf);
      return { rows, ...(page!.rows.length > n ? { nextCursor: String(offset + n) } : {}) };
    },

    get,

    async update(id, request) {
      const patch = Object.entries(texts(request));
      if (!patch.length) return get(id);
      // only the patched columns, and only a row that still exists: a concurrent delete or edit of the other field stands
      const [r] = (await driver.batch([{ sql: `UPDATE media_assets SET ${patch.map(([k], i) => `${k} = ?${i + 2}`).join(", ")} WHERE id = ?1 RETURNING ${COLUMNS}`, binds: [id, ...patch.map(([, v]) => v)] }]))[0]!.rows;
      if (!r) throw fail("MEDIA_ASSET_NOT_FOUND", `no media asset '${id}'`);
      return assetOf(r);
    },

    async delete(id) {
      const asset = await get(id);
      const results = await Promise.allSettled(asset.variants.map((v) => storage.deleteObject({ storageKey: v.storageKey })));
      const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      if (failed.length)
        throw new DiagnosticError(makeDiagnostic({ code: "PARTIAL_FAILURE", phase: "runtime", severity: "error", path: P, message: "Some objects could not be removed. Retry deleting the same asset.", failure: { outcome: "partial", retry: "safe", resource: "media" } }), { cause: new AggregateError(failed.map((r) => r.reason)) });
      await driver.batch([{ sql: "DELETE FROM media_assets WHERE id = ?1", binds: [id] }]);
      return { deleted: true, variantsRemoved: asset.variants.length };
    },
  };
}
