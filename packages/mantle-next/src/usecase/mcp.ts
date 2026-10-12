/** Emit the selected MCP boundary; the official transport loads on its first request. */
import { STAFF_ROLES } from "../domain/visibility.js";
import { mcpToolNameSegment, type RuntimePlan, type PlanLowered } from "@aotter/mantle/spec";
import type { Target } from "../domain/model.js";
import { emitMcpMedia, mediaDefinitions } from "./mcp-media.js";
import { emitValidation } from "./validation.js";
import { databaseImport, q } from "../domain/entry.js";
import { conversions } from "../domain/input.js";
import { publishingInput } from "./publishing.js";
import { boundaryPage, outputConversions } from "../domain/columns.js";
export function emitMcp(plan: RuntimePlan, lowered: PlanLowered, target: Target, refuse: (path: string, message: string) => void, media = false): Record<string, string> {
  if (!Object.values(plan.views).some(view=>view.surface!=="internal") && !Object.values(plan.triggers).some(trigger=>trigger.source.kind==="mcp")) return {};
  const imports: string[] = [], tools: { fields: string[]; schema: string; surface:string }[] = [];
  const files:Record<string,string> = media ? emitMcpMedia(refuse) : {};
  let hasRef=false,hasWire=false;
  const names = new Set<string>(media ? mediaDefinitions().map(tool=>"staff:"+tool.name) : []);
  const refs = Object.values(plan.procedures).some(p => "ref" in p.handler);
  const add = (name: string, kind: "views" | "procedures", surface: string, operation:Pick<RuntimePlan["views"][string],"input"|"title"|"description"|"requires">=kind === "views" ? plan.views[name]! : plan.procedures[name]!, tool=mcpToolNameSegment(name)) => {
    const ref=kind === "procedures" && !!plan.procedures[name] && "ref" in plan.procedures[name]!.handler;
    hasRef ||= ref;
    const statements=kind === "views" ? [lowered.views[name]?.public ?? lowered.views[name]?.caller] : lowered.procedures[name]?.caller ?? [];
    const binds=statements.flatMap(statement=>statement?.binds??[]);
    const index = tools.length, file = encodeURIComponent(name);
    imports.push(`import { validate as validate${index} } from "./validation/${kind}/${file}.js";`);
    if (kind === "views" || !ref) imports.push(`import run${index} from "./${kind === "views" ? "paged/views" : kind}/${file}.js";`);
    // The kernel adds a View tool's `limit` and `cursor` paging properties.
    const schema = q(kind === "views" ? operation.input ?? {type:"object",additionalProperties:false} : operation.input);
    if (kind === "views" && ("limit" in (operation.input?.properties ?? {}) || "cursor" in (operation.input?.properties ?? {}))) refuse(`views/${name}`, "MCP View input reserves limit and cursor for paging.");
    if(names.has(surface+":"+tool)) refuse(`${kind}/${name}`,`MCP tool name ${tool} collides on ${surface}.`);
    names.add(surface+":"+tool);
    const convert=conversions(operation.input?.properties,binds,target), scopes=(operation.requires?.auth?.all??[]).flatMap(p=>typeof p === "object" && "ctx.auth.scope" in p ? [p["ctx.auth.scope"]] : []);
    const procedure=kind === "procedures" ? plan.procedures[name] : undefined;
    const output=kind === "procedures" ? ref ? (procedure?.output.type === "object" ? procedure.output : undefined) : {type:"object",properties:{results:{type:"array",items:{type:"array",items:{type:"object"}}}},required:["results"]} : undefined;
    const annotations=kind === "views" ? {readOnlyHint:true} : procedure?.mcp;
    const wire = kind === "views" ? outputConversions(plan, name, target) : [];
    hasWire ||= wire.length > 0;
    const fields=[`name: ${q(tool)}`,`surface: ${q(surface)}`,...(operation.title?[`title: ${q(operation.title)}`]:[]),`description: ${q(operation.description ?? operation.title ?? name)}`,"inputSchema",...(output?[`outputSchema: ${q(output)}`]:[]),...(annotations?[`annotations: ${q(annotations)}`]:[]),...((operation.requires?.auth?.all.length ?? 0)>0?["closed: true"]:[]),...(scopes.length?[`scopes: ${q(scopes)}`]:[]),`validate: validate${index}`,...(convert?[`convert: ${convert}`]:[]),
      ...(kind === "views" ? [`path: ${q(`views/${name}`)}`,`page: ${boundaryPage(`run${index}`, wire)}`] : [`run: ${ref ? `(db, caller, input, handlers) => store(db, caller, { handlers }).procedures[${q(name)}](input)` : `run${index}`}`])];
    tools.push({ fields, schema, surface });
  };
  for (const [name, view] of Object.entries(plan.views)) if (view.surface !== "internal") add(name,"views",view.surface);
  const exposed = new Set<string>();
  for (const trigger of Object.values(plan.triggers)) if (trigger.source.kind === "mcp") {
    const key = trigger.source.surface + ":" + trigger.procedure;
    if (!exposed.has(key)) { exposed.add(key); add(trigger.procedure,"procedures",trigger.source.surface); }
  }
  for(const schema of Object.values(plan.schemas)) if(schema.publishing) for(const verb of ["publish","unpublish","archive"]) {
    const name=`${schema.name}.${verb}`,input=publishingInput;
    Object.assign(files,emitValidation({views:{},procedures:{[name]:{input}}},refuse));
    add(name,"procedures","staff",{input,requires:{auth:{all:[{"ctx.staff":[...STAFF_ROLES]}]}}},mcpToolNameSegment(`${verb}_${schema.name}`));
  }
  if (hasWire) imports.push('import { wireRows } from "@aotter/mantle-next/contracts";');
  // An input schema several tools share is one constant.
  const uses = new Map<string, number>(), shared = new Map<string, string>();
  for (const { schema } of tools) uses.set(schema, (uses.get(schema) ?? 0) + 1);
  for (const [schema, count] of uses) if (count > 1 && schema) shared.set(schema, `schema${shared.size}`);
  const sharedTools=Object.values(plan.views).some(view=>view.surface==="staff")||Object.values(plan.triggers).some(trigger=>trigger.source.kind==="mcp"&&trigger.source.surface==="staff");
  const toolImports=[databaseImport(target),...(refs ? ['import type { Handlers } from "./generated.js";'] : []),...(hasRef ? ['import { store } from "./generated.js";'] : []),...imports,...[...shared].map(([schema,name])=>`const ${name} = ${schema};`)];
  const print=(selected:typeof tools)=>selected.map(({fields,schema})=>`    { ${fields.map(field => field === "inputSchema" ? `inputSchema: ${shared.get(schema) ?? schema}` : field).join(", ")} },`).join("\n");
  if(sharedTools)files["mcp-tools.ts"]='import type { Tool } from "@aotter/mantle-next/mcp";\n'+toolImports.join("\n")+"\n"+["public","staff"].map(surface=>`export function ${surface}Tools(): readonly Tool<Database${refs ? ", Handlers" : ""}>[] {
  return [
${print(tools.filter(tool=>tool.surface===surface))}
  ];
}`).join("\n")+"\n";
  files["mcp.ts"]=`import { mcp as serve, type Options as McpOptions } from "@aotter/mantle-next/mcp";
${sharedTools?[databaseImport(target),...(refs?['import type { Handlers } from "./generated.js";']:[]),'import { publicTools, staffTools } from "./mcp-tools.js";'].join("\n"):toolImports.join("\n")}
${media ? 'import type { MediaStorage } from "@aotter/mantle-next/site";' : ""}
export type Options<Env = unknown> = McpOptions<Env, Database>${refs ? " & { handlers: Handlers }" : ""}${media ? " & { media?: (env: Env) => MediaStorage }" : ""};
export function mcp<Env = unknown>(options: Options<Env>): (request: Request, env: Env) => Promise<Response | undefined> {
  return ${media ? "async (request, env) => " : ""}serve<Env, Database${refs ? ", Handlers" : ""}>([...${sharedTools?"[...publicTools(),...staffTools()]":"[\n"+print(tools)+"\n  ]"}${media ? ", ...(options.media && new URL(request.url).pathname.replace(/\\/+$/, \"\") === \"/mcp/staff\" ? (await import(\"./mcp-media.js\")).mediaTools(() => options.media!(env)) : [])" : ""}], ${q(STAFF_ROLES)}, options)${media ? "(request, env)" : ""};
}
`;
  return files;
}
