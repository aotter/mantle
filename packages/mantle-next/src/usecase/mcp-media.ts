/** Compile the seven media inputs once; the generated module binds the existing site. */
import type { JsonSchema } from "@aotter/mantle/spec";
import { emitValidation } from "./validation.js";
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

export function emitMcpMedia(refuse: (path:string,message:string)=>void): Record<string,string> {
  const definitions = mediaDefinitions();
  const inputs = Object.fromEntries(definitions.map(tool => [tool.name,{input:tool.inputSchema as JsonSchema}]));
  const checks = Object.fromEntries(Object.entries(emitValidation({views:{},procedures:inputs},refuse)).map(([path,code])=>[path.replace("validation/procedures/","validation/media/"),code]));
  const invoke = {policy:'async (db,caller) => ({purposes:(await site(db,caller).read()).media.purposes})',create:'(db,caller,input:Record<string,unknown>) => site(db,caller).media(storage()).createUpload(input)',commit:'(db,caller,input:Record<string,unknown>) => site(db,caller).media(storage()).commitUpload(input.uploadGroupId as string,input)',list:'(db,caller,input:Record<string,unknown>) => site(db,caller).media(storage()).list(input)',get:'(db,caller,input:Record<string,unknown>) => site(db,caller).media(storage()).get(input.id as string)',update:'(db,caller,input:Record<string,unknown>) => site(db,caller).media(storage()).update(input.id as string,input)',delete:'(db,caller,input:Record<string,unknown>) => site(db,caller).media(storage()).delete(input.id as string)'};
  return {...checks,"mcp-media.ts":`import { site } from "./site.js";
import type { MediaStorage } from "@aotter/mantle-next/site";
import type { Tool } from "@aotter/mantle-next/mcp";
${definitions.map((tool,i)=>`import { validate as v${i} } from "./validation/media/${tool.name}.js";`).join("\n")}
export function mediaTools(storage: () => MediaStorage): Tool<Parameters<typeof site>[0]>[] { return [
${definitions.map(({action,...tool},i)=>`{...${JSON.stringify(tool)},surface:"staff",closed:true,validate:v${i},run:${invoke[action]}}`).join(",\n")}
]; }
`};
}
