/** The `upload_media` and `find_media` tools over a media library: argument modes, the fetch-and-commit path, and the upload card's targets. */
import { ContractError } from "./contract-error.js";
import { mediaError } from "./media.js";
import { acceptedBy } from "./media-type.js";
import { withResultMeta } from "./result-meta.js";
import type { MediaLibrary, MediaPurposePolicy } from "./site-types.js";

const fail = (code: string, message: string) => mediaError(code, message);
const bad = (expected: string) => fail("INPUT_VALIDATION_FAILED", `expected ${expected}`);
const obj = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** Where `upload_media` puts the upload targets for an MCP App: the result `_meta`, which the host gives the App and not the model. */
export const UPLOAD_META = "net.aotter.mantle/upload";

/**
 * `upload_media`, one mode per call: `{ uploadId }` commits; `variants` returns the targets (in the result `_meta` when the
 * client renders MCP Apps, else in the data, for an agent that PUTs itself); `sourceUrl` or `file` fetches one public file
 * and commits it; a bare purpose returns the policy. `policies` are the site's expanded purposes.
 */
export async function uploadMedia(
  library: MediaLibrary,
  policies: readonly MediaPurposePolicy[],
  input: Record<string, unknown>,
  call: { readonly apps: boolean; readonly linkedApp?: boolean },
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
    const fetched = await (await import("./media-fetch.js")).fetchSource(
      url,
      Math.max(...accepts.map(mime => policy.maxBytes[mime] ?? 0)),
      accepts.every(mime => mime.startsWith("image/")) ? "image/*" : "*/*",
    );
    if (!acceptedBy(accepts, fetched.mimeType))
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
    ...(call.linkedApp || call.apps
      ? {
          card: "Hosts that render MCP Apps show an upload card: the person picks the file there, and the card reports the committed asset id. If no card appears, use sourceUrl with a public HTTPS file, or file with an attachment reference.",
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
