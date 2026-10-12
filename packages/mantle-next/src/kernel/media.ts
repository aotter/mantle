/** 0.2 media lifecycle over native target drivers. No bytes pass through this module. */
import { ContractError, type Row } from "./contracts.js";
import type { Bound } from "./binds.js";
import type { Dialect } from "./dialect/common.js";
import type { MediaAsset, MediaLibrary, MediaStorage, MediaVariantRole, MediaPurposePolicy } from "./site-types.js";
export interface MediaDatabase { read(sql: string, binds: unknown[]): Row[] | PromiseLike<Row[]>; write(steps: readonly Bound[]): Promise<Row[][]>; /** Positive native evidence that the write rolled back; absence is uncertain. */ definitive?(error: unknown): boolean }
const P = "media";
const fail = (code: string, message: string) => new ContractError(code, message, P);
const bad = (expected: string) => fail("INPUT_VALIDATION_FAILED", `expected ${expected}`);

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
  const slots = policy.required.map(slot => slot.split(","));
  const slotOf = new Map(slots.flatMap((mimes, i) => mimes.map((m) => [m, i] as const)));
  const filled = variants.map((v) => slotOf.get(v.mimeType));
  if (filled.includes(undefined) || new Set(filled).size !== variants.length || filled.length !== slots.length || variants.filter((v) => v.role === "primary").length !== 1)
    throw fail("MEDIA_VARIANTS_INCOMPLETE", `purpose '${policy.name}' takes one variant for each of ${JSON.stringify(policy.required)}, exactly one of them primary`);
  for (const v of variants) {
    if (v.mimeType === "image/svg+xml") throw fail("MEDIA_SVG_REJECTED", "SVG uploads are refused: object storage does not sanitize them");
    if (!ALLOWED.has(v.mimeType)) throw fail("MEDIA_MIME_REJECTED", `${v.mimeType} is not an accepted image type`);
  }
  for (const v of variants) {
    const cap = policy.maxBytes[v.mimeType] ?? 0;
    if (v.byteSize > cap) throw fail("MEDIA_VARIANT_SIZE_EXCEEDED", `${v.mimeType} is ${v.byteSize} bytes; purpose '${policy.name}' allows ${cap}`);
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
const save = (a: MediaAsset, p: Dialect["param"]) => ({
  sql: `INSERT INTO media_assets (id, created_at, owner_id, alt, caption, variants, metadata) VALUES (${p(1)}, ${p(2)}, NULL, ${p(3)}, ${p(4)}, ${p(5)}, ${p(6)}) ON CONFLICT(id) DO NOTHING`,
  binds: [a.id, a.createdAt, a.alt ?? null, a.caption ?? null, JSON.stringify(a.variants), a.metadata ? JSON.stringify(a.metadata) : null],
});

export function mediaLibrary(driver: MediaDatabase, d: Pick<Dialect, "param" | "escapeLike" | "likeEscape" | "like">, storage: MediaStorage, policies: readonly MediaPurposePolicy[], now = Date.now): MediaLibrary {
  const p = d.param;
  const one = async (sql: string, binds: unknown[]) => (await driver.read(sql, binds))[0];
  const get = async (id: string) => {
    const r = await one(`SELECT ${COLUMNS} FROM media_assets WHERE id = ${p(1)}`, [id]);
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
      const declared = policies;
      const policy = declared.find((p) => p.name === purpose);
      if (!policy) throw fail("MEDIA_PURPOSE_REJECTED", `purpose '${purpose}' is not declared`);
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
      await driver.write([
        { sql: `DELETE FROM pending_media_uploads WHERE expires_at <= ${p(1)}`, binds: [at] },
        { sql: `INSERT INTO pending_media_uploads (id, record, expires_at) VALUES (${p(1)}, ${p(2)}, ${p(3)})`, binds: [uploadGroupId, JSON.stringify(record), expiresAt] },
      ]);
      return { uploadGroupId, capabilities: capabilities.map(({ mimeType, role, method, uploadUrl, requiredHeaders }) => ({ mimeType, role, method, uploadUrl, ...(requiredHeaders ? { requiredHeaders } : {}) })), expiresAt };
    },

    async commitUpload(uploadGroupId, request) {
      const patch = texts(request);
      const committed = await one(`SELECT ${COLUMNS} FROM media_assets WHERE id = ${p(1)}`, [uploadGroupId]);
      if (committed) return assetOf(committed);
      const row = await one(`SELECT record FROM pending_media_uploads WHERE id = ${p(1)}`, [uploadGroupId]);
      const record = row ? JSON.parse(String(row.record)) as Pending : null;
      // a rejected group's objects are deleted: an upload URL takes any type and size, so what was PUT is not trusted
      const discard = () => Promise.allSettled((record?.variants ?? []).map((v) => storage.deleteObject({ storageKey: v.storageKey })));
      if (!record || record.expiresAt <= now()) {
        if (record) { await discard(); await driver.write([{ sql: `DELETE FROM pending_media_uploads WHERE id = ${p(1)}`, binds: [uploadGroupId] }]); }
        throw fail("MEDIA_UPLOAD_EXPIRED", `upload group '${uploadGroupId}' is unknown or expired; create a new upload`);
      }
      let asset: MediaAsset;
      try { asset = await storage.commitUpload({
        uploadGroupId, filename: record.filename, now: record.createdAt,
        // the declared size is the cap: a larger object than announced is refused
        variants: record.variants.map((v) => ({ mimeType: v.mimeType, role: v.role, storageKey: v.storageKey, maxBytes: Math.min(v.maxBytes, v.expectedSize) })),
        ...((patch.alt ?? record.alt) !== undefined ? { alt: patch.alt ?? record.alt } : {}),
        ...((patch.caption ?? record.caption) !== undefined ? { caption: patch.caption ?? record.caption } : {}),
      }); } catch (error) {
        if (error instanceof ContractError && error.code === "MEDIA_OBJECT_NOT_FOUND") {
          const winner = await one(`SELECT ${COLUMNS} FROM media_assets WHERE id = ${p(1)}`, [uploadGroupId]);
          if (winner) return assetOf(winner);
        }
        if (error instanceof ContractError && error.code.startsWith("MEDIA_")) await discard();
        throw error;
      }
      if (asset.id !== uploadGroupId) throw new ContractError("OUTCOME_UNKNOWN", "Storage returned a different asset id; reconcile this upload group.", P);
      await driver.write([save(asset, p), { sql: `DELETE FROM pending_media_uploads WHERE id = ${p(1)}`, binds: [uploadGroupId] }]).catch(async error => {
        // Cleanup requires positive native rollback evidence; an unclassified failure may have committed.
        if (driver.definitive?.(error) === true) {
          const cleanup = await Promise.allSettled(asset.variants.map(v => storage.deleteObject({storageKey:v.storageKey})));
          const failed = cleanup.filter((r): r is PromiseRejectedResult => r.status === "rejected");
          if (failed.length) throw new ContractError("PARTIAL_FAILURE", "The write rolled back, but some attempt copies could not be removed. Reconcile storage before retrying.", P, {cause:new AggregateError([error,...failed.map(r=>r.reason)])});
          throw error;
        }
        throw error instanceof ContractError && error.code === "OUTCOME_UNKNOWN" ? error : new ContractError("OUTCOME_UNKNOWN", "The write outcome is unknown; reconcile this upload group before retrying.", P, {cause:error});
      });
      const durable = await get(uploadGroupId);
      // ON CONFLICT may select another concurrent attempt. Only discard this attempt's unselected copies.
      const selected = new Set(durable.variants.map(v => v.storageKey));
      const cleanup = await Promise.allSettled(asset.variants.filter(v => !selected.has(v.storageKey)).map(v => storage.deleteObject({storageKey:v.storageKey})));
      if (cleanup.some(r => r.status === "rejected")) throw new ContractError("OUTCOME_UNKNOWN", "The asset is committed, but unselected upload copies need storage reconciliation.", P);
      await discard();
      return durable;
    },

    async list({ limit, cursor, search }) {
      if (search !== undefined && typeof search !== "string") throw bad("search: string");
      const n = limit ?? 50;
      const offset = cursor === undefined ? 0 : Number(cursor);
      if (!Number.isInteger(n) || n < 1 || n > 500 || !Number.isSafeInteger(offset) || offset < 0 || (cursor !== undefined && String(offset) !== cursor)) throw bad("limit 1..500 and a cursor this list returned");
      const term = search ? d.escapeLike(search) : undefined;
      const where = term ? `WHERE id ${d.like(true)} ${p(3)}${d.likeEscape} OR alt ${d.like(true)} ${p(3)}${d.likeEscape} OR caption ${d.like(true)} ${p(3)}${d.likeEscape}` : "";
      const page = await driver.read( `SELECT ${COLUMNS} FROM media_assets ${where} ORDER BY created_at DESC, id DESC LIMIT ${p(1)} OFFSET ${p(2)}`, [n + 1, offset, ...(term ? [`%${term}%`] : [])]);
      const rows = page.slice(0, n).map(assetOf);
      return { rows, ...(page.length > n ? { nextCursor: String(offset + n) } : {}) };
    },

    get,

    async update(id, request) {
      const patch = Object.entries(texts(request));
      if (!patch.length) return get(id);
      // only the patched columns, and only a row that still exists: a concurrent delete or edit of the other field stands
      const [r] = (await driver.write([{ sql: `UPDATE media_assets SET ${patch.map(([k], i) => `${k} = ${p(i + 2)}`).join(", ")} WHERE id = ${p(1)} RETURNING ${COLUMNS}`, binds: [id, ...patch.map(([, v]) => v)] }]))[0]!;
      if (!r) throw fail("MEDIA_ASSET_NOT_FOUND", `no media asset '${id}'`);
      return assetOf(r);
    },

    async delete(id) {
      const asset = await get(id);
      const results = await Promise.allSettled(asset.variants.map((v) => storage.deleteObject({ storageKey: v.storageKey })));
      const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      if (failed.length)
        throw new ContractError("PARTIAL_FAILURE", "Some objects could not be removed. Retry deleting the same asset.", P, { cause: new AggregateError(failed.map(r => r.reason)) });
      await driver.write([{ sql: `DELETE FROM media_assets WHERE id = ${p(1)}`, binds: [id] }]);
      return { deleted: true, variantsRemoved: asset.variants.length };
    },
  };
}

/** The 0.2 Admin library item's convenience fields, without changing the storage DTO. */
export function mediaItem(asset: MediaAsset) {
  const primary=asset.variants.find(v=>v.role==="primary") ?? asset.variants[0];
  return {id:asset.id,variants:asset.variants,primaryUrl:primary?.publicUrl??null,mime:primary?.mimeType??null,byteSize:primary?.byteSize??null,alt:asset.alt??null,caption:asset.caption??null,createdAt:asset.createdAt};
}
