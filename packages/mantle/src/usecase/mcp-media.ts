/** Compile the media tool inputs once; the generated module binds the existing site. */
import type { JsonSchema } from "../build/compiler.js";
import { emitValidation } from "./validation.js";
import { mediaDefinitions } from "../domain/generated-tools.js";
export { mediaDefinitions };

const library = "site(db,caller).media(storage())";
const invoke = {
  upload: `(db,caller,input:Record<string,unknown>,_handlers:unknown,call:ToolCall) => uploadMedia(${library},policies,input,call)`,
  find: `(db,caller,input:Record<string,unknown>) => findMedia(${library},input)`,
  policy: 'async (db,caller) => ({purposes:(await site(db,caller).read()).media.purposes})',
  create: `(db,caller,input:Record<string,unknown>) => ${library}.createUpload(input)`,
  commit: `(db,caller,input:Record<string,unknown>) => ${library}.commitUpload(input.uploadGroupId as string,input)`,
  list: `(db,caller,input:Record<string,unknown>) => ${library}.list(input)`,
  get: `(db,caller,input:Record<string,unknown>) => ${library}.get(input.id as string)`,
  update: `(db,caller,input:Record<string,unknown>) => ${library}.update(input.id as string,input)`,
  delete: `(db,caller,input:Record<string,unknown>) => ${library}.delete(input.id as string)`,
};
/** `definitions` are the versioned media tools, computed once by the MCP emitter. */
export function emitMcpMedia(definitions: readonly (ReturnType<typeof mediaDefinitions>[number] & { title: string; version: string })[], refuse: (path:string,message:string)=>void): Record<string,string> {
  const inputs = Object.fromEntries(definitions.map(tool => [tool.name,{input:tool.inputSchema as JsonSchema}]));
  const checks = Object.fromEntries(Object.entries(emitValidation({views:{},procedures:inputs},refuse)).map(([path,code])=>[path.replace("validation/procedures/","validation/media/"),code]));
  return {...checks,"mcp-media.ts":`import { policies, site } from "./site.js";
import type { MediaStorage } from "@aotter/mantle/site";
import { findMedia, uploadMedia } from "@aotter/mantle/media";
import type { Tool, ToolCall } from "@aotter/mantle/mcp";
${definitions.map((tool,i)=>`import { validate as v${i} } from "./validation/media/${tool.name}.js";`).join("\n")}
export function mediaTools<Handlers = never>(storage: () => MediaStorage): Tool<Parameters<typeof site>[0], Handlers>[] { return [
${definitions.map(({action,...tool},i)=>`{...${JSON.stringify({...tool,...(tool.annotations.readOnlyHint ? {readOnly:true} : {})})},surface:"admin",closed:true,validate:v${i},run:${invoke[action]}}`).join(",\n")}
]; }
`};
}
