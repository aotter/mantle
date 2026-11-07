/** Shared static inputs for generated tools; no generator or runtime initialization. */
import type { JsonSchema } from "../build/compiler.js";

export const publishingTransitions = [["publish", ["draft"], "published"], ["unpublish", ["published", "archived"], "draft"], ["archive", ["draft", "published"], "archived"]] as const;
/** Only archive withdraws an entry from both drafts and the public. */
export const publishingAnnotations = (verb: string) => ({ readOnlyHint: false, destructiveHint: verb === "archive" });
export const publishingInput: JsonSchema = {type:"object",properties:{id:{type:"string",minLength:1},expectedVersion:{type:"integer",minimum:1}},required:["id","expectedVersion"],additionalProperties:false};

/** An expanded media purpose: each `required` slot lists the MIME types it accepts, comma-separated. */
type Purpose = { readonly name: string; readonly required: readonly string[]; readonly maxBytes: Readonly<Record<string, number>> };
/** The purposes as a sentence, so a model reads accepted types and byte caps in `tools/list`. */
const policyText = (policies: readonly Purpose[]) => policies.map(p => `'${p.name}' takes ${p.required.map(slot => slot.split(",").map(mime => `${mime} up to ${p.maxBytes[mime]} bytes`).join(" or ")).join(", plus ")}`).join("; ");
/** The media tools: the four 0.2 tools, then the seven earlier names, deprecated and removed in 0.3. `policies` are the site's expanded purposes, when generation knows them. */
export function mediaDefinitions(policies: readonly Purpose[] = []) {
const define = (name: string, description: string, inputSchema: unknown, action: "policy"|"create"|"commit"|"list"|"get"|"update"|"delete"|"upload"|"find", readOnlyHint = false, meta?: Record<string, unknown>) => ({name,description,inputSchema,action,annotations:{readOnlyHint,destructiveHint:action === "delete",openWorldHint:true},...(meta ? {meta} : {})});
const string = { type: "string" } as const;
const texts = { alt: { type: "string", maxLength: 1000 }, caption: { type: "string", maxLength: 1000 } };
const input = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
const variants = { type: "array", minItems: 1, items: input({ mimeType: string, byteSize: { type: "integer", minimum: 1 }, role: { type: "string", enum: ["primary", "alternate", "fallback"] } }, ["mimeType", "byteSize", "role"]) };
const purpose = policies.length ? { type: "string", enum: policies.map(p => p.name), description: `Accepted variants and byte caps: ${policyText(policies)}.` } : string;
const paging = { limit: { type: "integer", minimum: 1, maximum: 500 }, cursor: string, search: string };
const old = (text: string) => `Deprecated, removed in 0.3: ${text}`;

return [
    define("upload_media", "Upload one image to the media library in two calls; bytes never pass through MCP and file content is never accepted as base64. "
      + "1. Call with purpose, filename and variants (one per slot the purpose takes, exactly one primary; optimize the image locally first). The result has an uploadId and the upload targets, which expire in 15 minutes and serve this one upload. PUT each variant's bytes to its target url with its headers. "
      + "2. Call with { uploadId } to commit, and store the returned asset id in fields that reference media_assets.id, never an upload URL. An unknown or expired uploadId needs a new first call. "
      + "Called with only a purpose, it returns that purpose's accepted types and byte caps; a host that shows MCP Apps opens an upload card where the person picks the file, and the card commits it and reports the asset id. "
      + "With purpose and sourceUrl (a public https image) or file (an attachment), the server fetches the image and commits it in one call; that takes a purpose with a single variant slot.",
      input({ purpose, filename: { type: "string", maxLength: 255 }, variants, ...texts, uploadId: { type: "string", minLength: 1, maxLength: 100 },
        sourceUrl: { type: "string", format: "uri", maxLength: 2048 },
        file: { type: "object", properties: { download_url: { type: "string", maxLength: 4096 }, file_id: { type: "string", maxLength: 255 } }, required: ["download_url", "file_id"] } }), "upload", false, { "openai/fileParams": ["file"] }),
    define("find_media", "Find committed image assets with their permanent variants and alt/caption: by ids (ids not found are listed in missing), or newest first, where search matches id, alt or caption; reuse only a returned cursor.", input({ ids: { type: "array", minItems: 1, maxItems: 100, items: { type: "string", minLength: 1 } }, ...paging }), "find", true),
    define("update_media", "Update a committed asset's alt or caption; omitted fields remain unchanged and empty strings clear text.", input({ id: string, ...texts }, ["id"]), "update"),
    define("delete_media", "Delete an asset's objects and library record. Check application references first. A partial failure can be retried using the same id.", input({ id: string }, ["id"]), "delete"),
    define("get_media_upload_policy", old("call upload_media with only a purpose. Read declared image purpose MIME slots and byte caps before preparing variants or requesting an upload. Optimization runs locally, never in the host."), input({}), "policy", true),
    define("create_media_upload", old("use upload_media. Create short-lived PUT capabilities for image variants. Read site media purpose policy first; optimize images locally. Obtain attachment bytes yourself, then PUT each variant with its requiredHeaders and call commit_media_upload. Never store upload URLs as published images or ask the user to run terminal commands."), input({ filename: { type: "string", maxLength: 255 }, purpose: string, variants, ...texts }, ["filename", "purpose", "variants"]), "create"),
    define("commit_media_upload", old("call upload_media with { uploadId }. Verify all uploaded variants and commit one permanent media asset. Store the returned asset id in fields referencing media_assets.id, never a temporary upload URL. Unknown or expired upload groups require a new create_media_upload."), input({ uploadGroupId: string, ...texts }, ["uploadGroupId"]), "commit"),
    define("list_media_assets", old("use find_media. List committed image assets, newest first, with their permanent variants and alt/caption. Search matches id, alt or caption; reuse only a returned cursor."), input(paging), "list", true),
    define("get_media_asset", old("use find_media with ids. Read one committed media asset and its permanent variant URLs."), input({ id: string }, ["id"]), "get", true),
    define("update_media_asset", old("use update_media. Update committed asset alt or caption; omitted fields remain unchanged and empty strings clear text."), input({ id: string, ...texts }, ["id"]), "update"),
    define("delete_media_asset", old("use delete_media. Delete an asset's objects and library record. Check application references first. A partial failure can be retried using the same id."), input({ id: string }, ["id"]), "delete"),
] as const;
}
