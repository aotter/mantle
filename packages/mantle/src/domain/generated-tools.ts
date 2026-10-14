/** Shared static inputs for generated tools; no generator or runtime initialization. */
import type { JsonSchema } from "../build/compiler.js";

export const publishingTransitions = [["publish", ["draft"], "published"], ["unpublish", ["published", "archived"], "draft"], ["archive", ["draft", "published"], "archived"]] as const;
export const publishingInput: JsonSchema = {type:"object",properties:{id:{type:"string",minLength:1},expectedVersion:{type:"integer",minimum:1}},required:["id","expectedVersion"],additionalProperties:false};

export function mediaDefinitions() {
const define = (name: string, description: string, inputSchema: unknown, action: "policy"|"create"|"commit"|"list"|"get"|"update"|"delete", readOnlyHint = false) => ({name,description,inputSchema,action,annotations:{readOnlyHint,destructiveHint:action === "delete",openWorldHint:true}});
const string = { type: "string" } as const;
const texts = { alt: { type: "string", maxLength: 1000 }, caption: { type: "string", maxLength: 1000 } };
const input = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });

return [
    define("get_media_upload_policy", "Read declared image purpose MIME slots and byte caps before preparing variants or requesting an upload. Optimization runs locally, never in the host.", input({}), "policy", true),
    define("create_media_upload", "Create short-lived PUT capabilities for image variants. Read site media purpose policy first; optimize images locally. Obtain attachment bytes yourself, then PUT each variant with its requiredHeaders and call commit_media_upload. Never store upload URLs as published images or ask the user to run terminal commands.", input({ filename: { type: "string", maxLength: 255 }, purpose: string, variants: { type: "array", minItems: 1, items: input({ mimeType: string, byteSize: { type: "integer", minimum: 1 }, role: { type: "string", enum: ["primary", "alternate", "fallback"] } }, ["mimeType", "byteSize", "role"]) }, ...texts }, ["filename", "purpose", "variants"]), "create"),
    define("commit_media_upload", "Verify all uploaded variants and commit one permanent media asset. Store the returned asset id in fields referencing media_assets.id, never a temporary upload URL. Unknown or expired upload groups require a new create_media_upload.", input({ uploadGroupId: string, ...texts }, ["uploadGroupId"]), "commit"),
    define("list_media_assets", "List committed image assets, newest first, with their permanent variants and alt/caption. Search matches id, alt or caption; reuse only a returned cursor.", input({ limit: { type: "integer", minimum: 1, maximum: 500 }, cursor: string, search: string }), "list", true),
    define("get_media_asset", "Read one committed media asset and its permanent variant URLs.", input({ id: string }, ["id"]), "get", true),
    define("update_media_asset", "Update committed asset alt or caption; omitted fields remain unchanged and empty strings clear text.", input({ id: string, ...texts }, ["id"]), "update"),
    define("delete_media_asset", "Delete an asset's objects and library record. Check application references first. A partial failure can be retried using the same id.", input({ id: string }, ["id"]), "delete"),
] as const;
}

