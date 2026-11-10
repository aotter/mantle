/** 0.2 media lifecycle over native target drivers. No bytes pass through this module. */
import { ContractError, type Row } from "./contracts.js";
import type { Bound } from "./binds.js";
import type { Dialect } from "./dialect/common.js";
import type {
  MediaAsset,
  MediaLibrary,
  MediaStorage,
  MediaStorageOption,
  MediaVariantRole,
  MediaPurposePolicy,
} from "./site-types.js";
import { withResultMeta } from "./result-meta.js";
import { likeTooLong } from "./where.js";
export interface MediaDatabase {
  read(sql: string, binds: unknown[]): Row[] | PromiseLike<Row[]>;
  write(
    steps: readonly Bound[],
  ): Promise<Row[][]> /** Positive native evidence that the write rolled back; absence is uncertain. */;
  definitive?(error: unknown): boolean;
}
const P = "media";
/** HTTP status of each media code: a custom MediaStorage may throw them without one. */
const STATUS = new Map(
  Object.entries({
    MEDIA_PURPOSE_REJECTED: 400,
    MEDIA_SVG_REJECTED: 400,
    MEDIA_MIME_REJECTED: 400,
    MEDIA_VARIANTS_INCOMPLETE: 400,
    MEDIA_VARIANT_SIZE_EXCEEDED: 400,
    MEDIA_VARIANTS_SUSPICIOUS_SIZE: 400,
    MEDIA_SOURCE_REJECTED: 400,
    MEDIA_ASSET_NOT_FOUND: 404,
    MEDIA_NOT_OWNED: 404,
    MEDIA_OBJECT_NOT_FOUND: 409,
    MEDIA_UPLOAD_MISMATCH: 409,
    MEDIA_UPLOAD_EXPIRED: 410,
    SITE_NOT_CONFIGURED: 501,
    MEDIA_NOT_CONFIGURED: 501,
    MEDIA_SOURCE_FAILED: 502,
    MEDIA_STORAGE_FAILED: 502,
    PARTIAL_FAILURE: 503,
  }),
);
const extra = (code: string) => ({
  status: STATUS.get(code),
  ...(code === "PARTIAL_FAILURE"
    ? { fields: { failure: { outcome: "partial", retry: "safe", resource: "media" } } }
    : {}),
});
/**
 * A media, site or partial-failure error with the HTTP status (and `failure` payload) its code has on the wire. Code
 * outside this module raising these codes uses it: core `statusOf` maps only the core codes.
 */
export const mediaError = (code: string, message: string, path = P, options?: ErrorOptions): ContractError =>
  new ContractError(code, message, path, { ...options, ...extra(code) });
const fail = (code: string, message: string, options?: ErrorOptions) => mediaError(code, message, P, options);
/** A storage error keeps the wire status its code has always had. */
const own = (error: unknown) => {
  if (error instanceof ContractError && !error.status && STATUS.has(error.code))
    Object.assign(error, extra(error.code));
  return error;
};
const rejected = (results: PromiseSettledResult<unknown>[]) =>
  results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
const bad = (expected: string) => fail("INPUT_VALIDATION_FAILED", `expected ${expected}`);

/** SVG is refused: object storage does not sanitize it, and an SVG can carry script. */
const ALLOWED = new Set(["image/png", "image/jpeg", "image/webp", "image/avif", "image/gif"]);
/** Modern formats a skipped optimization makes larger than the fallback. */
const MODERN = new Set(["image/avif", "image/webp"]);
const ROLES = new Set<unknown>(["primary", "alternate", "fallback"]);
const TTL_MS = 15 * 60 * 1000;
/** The SigV4 limit on a presigned URL. */
const MAX_READ_SECONDS = 7 * 24 * 3600;
/**
 * New ids are `<tag>_<uuid>`, the tag drawn once per database and kept in `site_config`, so a miss on an id another
 * server minted is told apart from an unknown or expired one without asking that server. Untagged (legacy) ids still resolve.
 * ponytail: a lost or copied tag row misreports misses (own ids as foreign, or a clone's as ours); a configured site id would fix that.
 */
const TAG_KEY = "media_id_tag";
const TAGGED = /^([0-9a-f]{12})_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface Pending {
  readonly purpose: string;
  /** Absent on a group created before visibility existed: public. */
  readonly private?: true;
  readonly filename: string;
  readonly variants: readonly {
    mimeType: string;
    role: MediaVariantRole;
    storageKey: string;
    expectedSize: number;
    maxBytes: number;
  }[];
  readonly alt?: string;
  readonly caption?: string;
  readonly expiresAt: number;
  readonly createdAt: number;
}

const obj = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const MAX_TEXT = 1000;
const MAX_FILENAME = 255;
/** `alt` and `caption`: absent, or a string of at most 1000 characters. */
function texts(body: unknown) {
  const b = obj(body);
  for (const k of ["alt", "caption"])
    if (b[k] !== undefined && (typeof b[k] !== "string" || b[k].length > MAX_TEXT))
      throw bad(`{ alt?: string, caption?: string }, each at most ${MAX_TEXT} characters`);
  return {
    ...(typeof b["alt"] === "string" ? { alt: b["alt"] } : {}),
    ...(typeof b["caption"] === "string" ? { caption: b["caption"] } : {}),
  } as { alt?: string; caption?: string };
}

/** Exactly one variant per required slot, nothing outside them, and exactly one primary. */
function checkVariants(
  policy: MediaPurposePolicy,
  variants: readonly { mimeType: string; byteSize: number; role: MediaVariantRole }[],
) {
  const slots = policy.required.map(slot => slot.split(","));
  const slotOf = new Map(slots.flatMap((mimes, i) => mimes.map(m => [m, i] as const)));
  const filled = variants.map(v => slotOf.get(v.mimeType));
  if (
    filled.includes(undefined) ||
    new Set(filled).size !== variants.length ||
    filled.length !== slots.length ||
    variants.filter(v => v.role === "primary").length !== 1
  )
    throw fail(
      "MEDIA_VARIANTS_INCOMPLETE",
      `purpose '${policy.name}' takes one variant for each of ${JSON.stringify(policy.required)}, exactly one of them primary`,
    );
  for (const v of variants) {
    if (v.mimeType === "image/svg+xml")
      throw fail("MEDIA_SVG_REJECTED", "SVG uploads are refused: object storage does not sanitize them");
    if (!ALLOWED.has(v.mimeType)) throw fail("MEDIA_MIME_REJECTED", `${v.mimeType} is not an accepted image type`);
  }
  for (const v of variants) {
    const cap = policy.maxBytes[v.mimeType] ?? 0;
    if (v.byteSize > cap)
      throw fail(
        "MEDIA_VARIANT_SIZE_EXCEEDED",
        `${v.mimeType} is ${v.byteSize} bytes; purpose '${policy.name}' allows ${cap}`,
      );
  }
  const fallback = ["image/jpeg", "image/png", "image/gif"]
    .map(m => variants.find(v => v.mimeType === m))
    .find(Boolean);
  const heavy = fallback && variants.find(v => MODERN.has(v.mimeType) && v.byteSize > fallback.byteSize);
  if (heavy)
    throw fail(
      "MEDIA_VARIANTS_SUSPICIOUS_SIZE",
      `${heavy.mimeType} (${heavy.byteSize}B) is larger than ${fallback!.mimeType} (${fallback!.byteSize}B): optimize it before uploading`,
    );
}

const COLUMNS = "id, created_at, alt, caption, variants, metadata";
/** A private asset is stored without public URLs, so their absence is its visibility. */
const hidden = (variants: MediaAsset["variants"]) =>
  variants.length > 0 && variants.every(v => v.publicUrl === undefined);
function assetOf(r: Record<string, unknown>): MediaAsset {
  const variants: MediaAsset["variants"] = JSON.parse(String(r.variants));
  return {
    id: String(r.id),
    variants,
    createdAt: Number(r.created_at),
    ...(hidden(variants) ? { visibility: "private" as const } : {}),
    ...(r.alt === null ? {} : { alt: String(r.alt) }),
    ...(r.caption === null ? {} : { caption: String(r.caption) }),
    ...(r.metadata === null ? {} : { metadata: JSON.parse(String(r.metadata)) }),
  };
}
const save = (a: MediaAsset, p: Dialect["param"]) => ({
  sql: `INSERT INTO media_assets (id, created_at, owner_id, alt, caption, variants, metadata) VALUES (${p(1)}, ${p(2)}, NULL, ${p(3)}, ${p(4)}, ${p(5)}, ${p(6)}) ON CONFLICT(id) DO NOTHING`,
  binds: [
    a.id,
    a.createdAt,
    a.alt ?? null,
    a.caption ?? null,
    JSON.stringify(a.variants),
    a.metadata ? JSON.stringify(a.metadata) : null,
  ],
});

export function mediaLibrary(
  driver: MediaDatabase,
  d: Pick<Dialect, "param" | "escapeLike" | "likeEscape" | "like">,
  option: MediaStorageOption,
  policies: readonly MediaPurposePolicy[],
  now = Date.now,
): MediaLibrary {
  const split = "public" in option;
  const pub = split ? option.public : option,
    priv = split ? (option.private as MediaStorage | undefined) : undefined;
  const closed = policies.filter(policy => policy.visibility === "private").map(policy => `'${policy.name}'`);
  // never a silent fallback to the public storage
  if (closed.length && !priv)
    throw fail(
      "MEDIA_NOT_CONFIGURED",
      `media purpose(s) ${closed.join(", ")} are private, but the media option has no private storage; pass { public, private }`,
    );
  const storeOf = (isPrivate: unknown) => {
    if (isPrivate && !priv)
      throw fail(
        "MEDIA_NOT_CONFIGURED",
        "This asset is private, but the media option has no private storage; pass { public, private }",
      );
    return isPrivate ? priv! : pub;
  };
  const p = d.param;
  const one = async (sql: string, binds: unknown[]) => (await driver.read(sql, binds))[0];
  const byId = (id: string) => one(`SELECT ${COLUMNS} FROM media_assets WHERE id = ${p(1)}`, [id]);
  const unpend = (id: string) => ({ sql: `DELETE FROM pending_media_uploads WHERE id = ${p(1)}`, binds: [id] });
  const removeAll = (variants: readonly { storageKey: string }[], storage: MediaStorage) =>
    Promise.allSettled(variants.map(v => storage.deleteObject({ storageKey: v.storageKey })));
  const ownTag = async () =>
    (await one(`SELECT value FROM site_config WHERE key = ${p(1)}`, [TAG_KEY]))?.value as string | undefined;
  const tag = async () => {
    const found = await ownTag();
    if (found) return found;
    await driver.write([
      {
        sql: `INSERT INTO site_config (key, value) VALUES (${p(1)}, ${p(2)}) ON CONFLICT(key) DO NOTHING`,
        binds: [TAG_KEY, crypto.randomUUID().slice(0, 13).replace("-", "")],
      },
    ]);
    return (await ownTag())!;
  };
  /** A miss: an id tagged by another server is refused as not ours, saying nothing about that server. */
  const missing = async (id: string, what: string, code: string, message: string) => {
    const foreign = TAGGED.exec(id)?.[1];
    return foreign && foreign !== (await ownTag())
      ? fail("MEDIA_NOT_OWNED", `not ${what} of this server; use the server that created it`)
      : fail(code, message);
  };
  const notFound = (id: string) => missing(id, "a media asset", "MEDIA_ASSET_NOT_FOUND", `no media asset '${id}'`);
  const get = async (id: string) => {
    const r = await byId(id);
    if (!r) throw await notFound(id);
    return assetOf(r);
  };

  return {
    async createUpload(request) {
      const b = obj(request);
      const variants = Array.isArray(b["variants"]) ? b["variants"].map(obj) : null;
      if (
        typeof b["filename"] !== "string" ||
        b["filename"].length > MAX_FILENAME ||
        typeof b["purpose"] !== "string" ||
        !variants?.length ||
        variants.some(
          v =>
            typeof v["mimeType"] !== "string" ||
            !Number.isSafeInteger(v["byteSize"]) ||
            (v["byteSize"] as number) <= 0 ||
            !ROLES.has(v["role"]),
        )
      )
        throw bad(
          "{ filename: string of at most 255 characters, purpose: string, variants: [{ mimeType: string, byteSize: positive integer, role: 'primary'|'alternate'|'fallback' }] }",
        );
      const { filename, purpose } = b as { filename: string; purpose: string };
      const described = texts(b);
      const declared = policies;
      const policy = declared.find(p => p.name === purpose);
      if (!policy) throw fail("MEDIA_PURPOSE_REJECTED", `purpose '${purpose}' is not declared`);
      const asked = variants as unknown as { mimeType: string; byteSize: number; role: MediaVariantRole }[];
      checkVariants(policy, asked);
      const at = now();
      const expiresAt = at + TTL_MS;
      // bearer-equivalent until commit: storage keys under it must not be guessable
      const uploadGroupId = `${await tag()}_${crypto.randomUUID()}`;
      const isPrivate = policy.visibility === "private",
        storage = storeOf(isPrivate);
      const specs = asked.map(({ mimeType, byteSize, role }) => ({
        mimeType,
        byteSize,
        role,
        maxBytes: policy.maxBytes[mimeType]!,
      }));
      let capabilities;
      try {
        ({ capabilities } = await storage.createUpload({
          uploadGroupId,
          purpose,
          filename,
          variants: specs,
          now: at,
          expiresAt,
        }));
      } catch (error) {
        throw own(error);
      }
      const record: Pending = {
        purpose,
        ...(isPrivate ? { private: true as const } : {}),
        filename,
        ...described,
        expiresAt,
        createdAt: at,
        variants: capabilities.map((c, i) => ({
          mimeType: c.mimeType,
          role: c.role,
          storageKey: c.storageKey,
          expectedSize: specs[i]!.byteSize,
          maxBytes: specs[i]!.maxBytes,
        })),
      };
      await driver.write([
        { sql: `DELETE FROM pending_media_uploads WHERE expires_at <= ${p(1)}`, binds: [at] },
        {
          sql: `INSERT INTO pending_media_uploads (id, record, expires_at) VALUES (${p(1)}, ${p(2)}, ${p(3)})`,
          binds: [uploadGroupId, JSON.stringify(record), expiresAt],
        },
      ]);
      return {
        uploadGroupId,
        capabilities: capabilities.map(({ mimeType, role, method, uploadUrl, requiredHeaders }) => ({
          mimeType,
          role,
          method,
          uploadUrl,
          ...(requiredHeaders ? { requiredHeaders } : {}),
        })),
        expiresAt,
      };
    },

    async commitUpload(uploadGroupId, request) {
      const patch = texts(request);
      const committed = await byId(uploadGroupId);
      if (committed) return assetOf(committed);
      const row = await one(`SELECT record FROM pending_media_uploads WHERE id = ${p(1)}`, [uploadGroupId]);
      const record = row ? (JSON.parse(String(row.record)) as Pending) : null;
      const storage = storeOf(record?.private);
      // a rejected group's objects are deleted: an upload URL takes any type and size, so what was PUT is not trusted
      const discard = () => removeAll(record?.variants ?? [], storage);
      if (!record || record.expiresAt <= now()) {
        if (record) {
          await discard();
          await driver.write([unpend(uploadGroupId)]);
        }
        throw await missing(
          uploadGroupId,
          "an upload",
          "MEDIA_UPLOAD_EXPIRED",
          `upload group '${uploadGroupId}' is unknown or expired; create a new upload`,
        );
      }
      const named = obj(request).purpose;
      if (named !== undefined && named !== record.purpose)
        throw fail(
          "MEDIA_UPLOAD_MISMATCH",
          `upload '${uploadGroupId}' was created for purpose '${record.purpose}', not '${String(named)}'`,
        );
      let asset: MediaAsset;
      try {
        asset = await storage.commitUpload({
          uploadGroupId,
          filename: record.filename,
          now: record.createdAt,
          // the declared size is the cap: a larger object than announced is refused
          variants: record.variants.map(v => ({
            mimeType: v.mimeType,
            role: v.role,
            storageKey: v.storageKey,
            maxBytes: Math.min(v.maxBytes, v.expectedSize),
          })),
          ...((patch.alt ?? record.alt) !== undefined ? { alt: patch.alt ?? record.alt } : {}),
          ...((patch.caption ?? record.caption) !== undefined ? { caption: patch.caption ?? record.caption } : {}),
        });
      } catch (error) {
        if (error instanceof ContractError && error.code === "MEDIA_OBJECT_NOT_FOUND") {
          const winner = await byId(uploadGroupId);
          if (winner) return assetOf(winner);
        }
        if (error instanceof ContractError && error.code.startsWith("MEDIA_")) await discard();
        throw own(error);
      }
      if (asset.id !== uploadGroupId)
        throw new ContractError(
          "OUTCOME_UNKNOWN",
          "Storage returned a different asset id; reconcile this upload group.",
          P,
        );
      // a private storage that hands out public URLs serves its objects publicly; a public one must give every variant one
      if (asset.variants.some(v => (record.private ? v.publicUrl !== undefined : typeof v.publicUrl !== "string"))) {
        const failed = rejected(await removeAll(asset.variants, storage));
        await discard();
        if (failed.length)
          throw fail("PARTIAL_FAILURE", "Some copied variants could not be removed. Retry the same upload group.", {
            cause: new AggregateError(failed.map(r => r.reason)),
          });
        throw fail(
          "MEDIA_NOT_CONFIGURED",
          record.private
            ? "The private media storage returned a publicUrl: its objects would be public."
            : "The public media storage returned a variant without a publicUrl.",
        );
      }
      await driver.write([save(asset, p), unpend(uploadGroupId)]).catch(async error => {
        // Cleanup requires positive native rollback evidence; an unclassified failure may have committed.
        if (driver.definitive?.(error) === true) {
          const failed = rejected(await removeAll(asset.variants, storage));
          if (failed.length)
            throw fail(
              "PARTIAL_FAILURE",
              "The write rolled back, but some attempt copies could not be removed. Reconcile storage before retrying.",
              { cause: new AggregateError([error, ...failed.map(r => r.reason)]) },
            );
          throw error;
        }
        throw error instanceof ContractError && error.code === "OUTCOME_UNKNOWN"
          ? error
          : new ContractError(
              "OUTCOME_UNKNOWN",
              "The write outcome is unknown; reconcile this upload group before retrying.",
              P,
              { cause: error },
            );
      });
      const durable = await get(uploadGroupId);
      // ON CONFLICT may select another concurrent attempt. Only discard this attempt's unselected copies.
      const selected = new Set(durable.variants.map(v => v.storageKey));
      if (
        rejected(
          await removeAll(
            asset.variants.filter(v => !selected.has(v.storageKey)),
            storage,
          ),
        ).length
      )
        throw new ContractError(
          "OUTCOME_UNKNOWN",
          "The asset is committed, but unselected upload copies need storage reconciliation.",
          P,
        );
      await discard();
      return durable;
    },

    async list({ limit, cursor, search }) {
      if (search !== undefined && typeof search !== "string") throw bad("search: string");
      const n = limit ?? 50;
      const offset = cursor === undefined ? 0 : Number(cursor);
      if (
        !Number.isInteger(n) ||
        n < 1 ||
        n > 500 ||
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        (cursor !== undefined && String(offset) !== cursor)
      )
        throw bad("limit 1..500 and a cursor this list returned");
      // The id matches exactly; alt and caption match a substring. D1 caps a LIKE pattern at 50 bytes ("pattern too
      // complex"), so a longer search, such as a whole id, matches the id alone, on every dialect.
      const pattern = search ? `%${d.escapeLike(search)}%` : "",
        like = pattern && !likeTooLong(pattern) ? pattern : undefined;
      const where = !search
        ? ""
        : like
          ? `WHERE id = ${p(4)} OR alt ${d.like(true)} ${p(3)}${d.likeEscape} OR caption ${d.like(true)} ${p(3)}${d.likeEscape}`
          : `WHERE id = ${p(3)}`;
      const page = await driver.read(
        `SELECT ${COLUMNS} FROM media_assets ${where} ORDER BY created_at DESC, id DESC LIMIT ${p(1)} OFFSET ${p(2)}`,
        [n + 1, offset, ...(like ? [like, search] : search ? [search] : [])],
      );
      const rows = page.slice(0, n).map(assetOf);
      return { rows, ...(page.length > n ? { nextCursor: String(offset + n) } : {}) };
    },

    get,

    async update(id, request) {
      const patch = Object.entries(texts(request));
      if (!patch.length) return get(id);
      // only the patched columns, and only a row that still exists: a concurrent delete or edit of the other field stands
      const [r] = (
        await driver.write([
          {
            sql: `UPDATE media_assets SET ${patch.map(([k], i) => `${k} = ${p(i + 2)}`).join(", ")} WHERE id = ${p(1)} RETURNING ${COLUMNS}`,
            binds: [id, ...patch.map(([, v]) => v)],
          },
        ])
      )[0]!;
      if (!r) throw await notFound(id);
      return assetOf(r);
    },

    async signRead(id, expiresIn = 300) {
      if (!Number.isSafeInteger(expiresIn) || expiresIn < 1 || expiresIn > MAX_READ_SECONDS)
        throw bad(`expiresIn: whole seconds, 1..${MAX_READ_SECONDS}`);
      const asset = await get(id);
      if (!asset.visibility)
        return {
          id,
          variants: asset.variants.map(({ mimeType, role, publicUrl }) => ({ mimeType, role, url: publicUrl! })),
        };
      const storage = storeOf(true);
      if (!storage.signRead)
        throw fail("MEDIA_NOT_CONFIGURED", "The private media storage cannot sign reads: it has no signRead.");
      const expiresAt = now() + expiresIn * 1000;
      let variants;
      try {
        variants = await Promise.all(
          asset.variants.map(async ({ mimeType, role, storageKey }) => ({
            mimeType,
            role,
            url: await storage.signRead!({ storageKey, expiresIn }),
          })),
        );
      } catch (error) {
        throw own(error);
      }
      return { id, variants, expiresAt };
    },

    async delete(id) {
      const asset = await get(id);
      const failed = rejected(await removeAll(asset.variants, storeOf(asset.visibility)));
      if (failed.length)
        throw fail("PARTIAL_FAILURE", "Some objects could not be removed. Retry deleting the same asset.", {
          cause: new AggregateError(failed.map(r => r.reason)),
        });
      await driver.write([{ sql: `DELETE FROM media_assets WHERE id = ${p(1)}`, binds: [id] }]);
      return { deleted: true, variantsRemoved: asset.variants.length };
    },
  };
}

/** The 0.2 Admin library item's convenience fields, without changing the storage DTO. */
export function mediaItem(asset: MediaAsset) {
  const primary = asset.variants.find(v => v.role === "primary") ?? asset.variants[0];
  return {
    id: asset.id,
    variants: asset.variants,
    primaryUrl: primary?.publicUrl ?? null,
    mime: primary?.mimeType ?? null,
    byteSize: primary?.byteSize ?? null,
    alt: asset.alt ?? null,
    caption: asset.caption ?? null,
    createdAt: asset.createdAt,
    ...(asset.visibility ? { visibility: asset.visibility } : {}),
  };
}

/** Where `upload_media` puts the upload targets for an MCP App: the result `_meta`, which the host gives the App and not the model. */
export const UPLOAD_META = "net.aotter.mantle/upload";

/**
 * `upload_media`, one mode per call: `{ uploadId }` commits; `variants` returns the targets (in the result `_meta` when the
 * client renders MCP Apps, else in the data, for an agent that PUTs itself); `sourceUrl` or `file` fetches one public image
 * and commits it; a bare purpose returns the policy. `policies` are the site's expanded purposes.
 */
export async function uploadMedia(
  library: MediaLibrary,
  policies: readonly MediaPurposePolicy[],
  input: Record<string, unknown>,
  call: { readonly apps: boolean },
): Promise<unknown> {
  const { uploadId, sourceUrl, file, variants, purpose, filename, ...described } = input;
  const present = (keys: string[]) => keys.filter(key => input[key] !== undefined);
  if (uploadId !== undefined) {
    if (present(["variants", "filename", "sourceUrl", "file"]).length)
      throw bad(
        "{ uploadId, purpose?, alt?, caption? }: filename, variants, sourceUrl and file belong to the first call",
      );
    return library.commitUpload(String(uploadId), { ...described, ...(purpose !== undefined ? { purpose } : {}) });
  }
  if (sourceUrl !== undefined || file !== undefined) {
    if (present(["sourceUrl", "file", "variants"]).length > 1) throw bad("one of variants, sourceUrl or file");
    const policy = policies.find(p => p.name === purpose);
    if (!policy) throw fail("MEDIA_PURPOSE_REJECTED", `purpose '${String(purpose)}' is not declared`);
    if (policy.required.length !== 1)
      throw fail(
        "MEDIA_VARIANTS_INCOMPLETE",
        `purpose '${policy.name}' takes ${policy.required.length} variants, and a fetched file is one: prepare the variants locally and send them as variants`,
      );
    const accepts = policy.required[0]!.split(",");
    const url = sourceUrl ?? obj(file).download_url;
    if (typeof url !== "string") throw bad("sourceUrl: string, or file: { download_url, file_id }");
    const fetched = await (await import("./media-fetch.js")).fetchImage(
      url,
      Math.max(...accepts.map(mime => policy.maxBytes[mime] ?? 0)),
    );
    if (!accepts.includes(fetched.mimeType))
      throw fail(
        "MEDIA_MIME_REJECTED",
        `the source is ${fetched.mimeType}; purpose '${policy.name}' takes ${accepts.join(" or ")}`,
      );
    const created = await library.createUpload({
      ...described,
      purpose,
      filename: filename ?? fetched.filename,
      variants: [{ mimeType: fetched.mimeType, byteSize: fetched.bytes.byteLength, role: "primary" }],
    });
    for (const target of created.capabilities) {
      let status = 0;
      try {
        const response = await fetch(target.uploadUrl, {
          method: target.method,
          headers: target.requiredHeaders ?? {},
          body: fetched.bytes,
        });
        status = response.status;
        await response.body?.cancel();
      } catch {}
      if (status < 200 || status > 299)
        throw fail(
          "MEDIA_STORAGE_FAILED",
          `storage did not accept the upload${status ? ` (${status})` : ""}; call upload_media again`,
        );
    }
    return library.commitUpload(created.uploadGroupId);
  }
  if (variants !== undefined) {
    const created = await library.createUpload(input);
    const targets = created.capabilities.map(({ role, mimeType, method, uploadUrl, requiredHeaders }) => ({
      role,
      mimeType,
      method,
      url: uploadUrl,
      headers: requiredHeaders ?? {},
    }));
    const data = { uploadId: created.uploadGroupId, expiresAt: created.expiresAt };
    return call.apps ? withResultMeta(data, { [UPLOAD_META]: { targets } }) : { ...data, targets };
  }
  if (present(["filename", "alt", "caption"]).length)
    throw bad("variants, sourceUrl or file with filename, alt and caption");
  const listed = policies.filter(p => purpose === undefined || p.name === purpose);
  if (purpose !== undefined && !listed.length)
    throw fail("MEDIA_PURPOSE_REJECTED", `purpose '${String(purpose)}' is not declared`);
  return {
    purposes: listed,
    ...(call.apps
      ? {
          card: "The upload card is open: the person picks the file there, and the card reports the committed asset id.",
        }
      : {}),
  };
}

/** `find_media`: `ids` reads those assets (ids not found are listed in `missing`), else the newest-first list. */
export async function findMedia(library: MediaLibrary, input: Record<string, unknown>): Promise<unknown> {
  const { ids, ...query } = input;
  if (ids === undefined) return library.list(query);
  if (
    Object.values(query).some(value => value !== undefined) ||
    !Array.isArray(ids) ||
    ids.some(id => typeof id !== "string")
  )
    throw bad("ids: string[] alone, or limit, cursor and search");
  // ponytail: one read per id (at most 100); a library `getMany` if hosts send many ids
  const found = await Promise.all(
    [...new Set(ids as string[])].map(id =>
      library.get(id).catch(error => {
        if (
          error instanceof ContractError &&
          (error.code === "MEDIA_ASSET_NOT_FOUND" || error.code === "MEDIA_NOT_OWNED")
        )
          return id;
        throw error;
      }),
    ),
  );
  return { rows: found.filter(row => typeof row !== "string"), missing: found.filter(row => typeof row === "string") };
}
