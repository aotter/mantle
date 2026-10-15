/** Compile the seven media inputs once; the generated module binds the existing site. */
import type { JsonSchema } from "../build/compiler.js";
import { emitValidation } from "./validation.js";
import { mediaDefinitions } from "../domain/generated-tools.js";
export { mediaDefinitions };

/** `definitions` are the versioned media tools, computed once by the MCP emitter. */
export function emitMcpMedia(definitions: readonly (ReturnType<typeof mediaDefinitions>[number] & { version: string })[], refuse: (path:string,message:string)=>void): Record<string,string> {
  const inputs = Object.fromEntries(definitions.map(tool => [tool.name,{input:tool.inputSchema as JsonSchema}]));
  const checks = Object.fromEntries(Object.entries(emitValidation({views:{},procedures:inputs},refuse)).map(([path,code])=>[path.replace("validation/procedures/","validation/media/"),code]));
  const invoke = {policy:'async (db,caller) => ({purposes:(await site(db,caller).read()).media.purposes})',create:'(db,caller,input:Record<string,unknown>) => site(db,caller).media(storage()).createUpload(input)',commit:'(db,caller,input:Record<string,unknown>) => site(db,caller).media(storage()).commitUpload(input.uploadGroupId as string,input)',list:'(db,caller,input:Record<string,unknown>) => site(db,caller).media(storage()).list(input)',get:'(db,caller,input:Record<string,unknown>) => site(db,caller).media(storage()).get(input.id as string)',update:'(db,caller,input:Record<string,unknown>) => site(db,caller).media(storage()).update(input.id as string,input)',delete:'(db,caller,input:Record<string,unknown>) => site(db,caller).media(storage()).delete(input.id as string)'};
  return {...checks,"mcp-media.ts":`import { site } from "./site.js";
import type { MediaStorage } from "@aotter/mantle/site";
import type { Tool } from "@aotter/mantle/mcp";
${definitions.map((tool,i)=>`import { validate as v${i} } from "./validation/media/${tool.name}.js";`).join("\n")}
export function mediaTools<Handlers = never>(storage: () => MediaStorage): Tool<Parameters<typeof site>[0], Handlers>[] { return [
${definitions.map(({action,...tool},i)=>`{...${JSON.stringify({...tool,...(tool.annotations.readOnlyHint ? {readOnly:true} : {})})},surface:"admin",closed:true,validate:v${i},run:${invoke[action]}}`).join(",\n")}
]; }
`};
}
