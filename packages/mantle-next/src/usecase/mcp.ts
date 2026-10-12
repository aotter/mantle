/** Emit the selected MCP boundary; the official transport loads on its first request. */
import { STAFF_ROLES } from "../domain/visibility.js";
import { mcpToolNameSegment, resolveLocalizedText, type RuntimePlan, type PlanLowered } from "@aotter/mantle/spec";
import type { Target } from "../domain/model.js";
import { emitValidation } from "./validation.js";
import {databaseImport} from "../domain/entry.js";
import { conversions } from "../domain/input.js";
const q = JSON.stringify;
export function emitMcp(plan: RuntimePlan, lowered: PlanLowered, target: Target, refuse: (path: string, message: string) => void): Record<string, string> {
  if (!Object.values(plan.views).some(view=>view.surface!=="internal") && !Object.values(plan.triggers).some(trigger=>trigger.source.kind==="mcp")) return {};
  const imports: string[] = [], tools: string[] = [];
  const files:Record<string,string> = {};
  let hasRef=false;
  const names = new Set<string>();
  const refs = Object.values(plan.procedures).some(p => "ref" in p.handler);
  const add = (name: string, kind: "views" | "procedures", surface: string, operation:Pick<RuntimePlan["views"][string],"input"|"description"|"requires">=kind === "views" ? plan.views[name]! : plan.procedures[name]!, tool=mcpToolNameSegment(name)) => {
    const ref=kind === "procedures" && !!plan.procedures[name] && "ref" in plan.procedures[name]!.handler;
    hasRef ||= ref;
    const statements=kind === "views" ? [lowered.views[name]?.public ?? lowered.views[name]?.caller] : lowered.procedures[name]?.caller ?? [];
    const binds=statements.flatMap(statement=>statement?.binds??[]);
    const index = tools.length, file = encodeURIComponent(name);
    imports.push(`import { validate as validate${index} } from "./validation/${kind}/${file}.js";`);
    if (kind === "views" || !ref) imports.push(`import run${index} from "./${kind === "views" ? "paged/views" : kind}/${file}.js";`);
    const schema = kind === "views" ? { ...(operation.input ?? {type:"object",additionalProperties:false}), properties: {...operation.input?.properties,limit:{type:"integer",minimum:1,maximum:500},cursor:{type:"string"}} } : operation.input;
    if (kind === "views" && ("limit" in (operation.input?.properties ?? {}) || "cursor" in (operation.input?.properties ?? {}))) refuse(`views/${name}`, "MCP View input reserves limit and cursor for paging.");
    if(names.has(surface+":"+tool)) refuse(`${kind}/${name}`,`MCP tool name ${tool} collides on ${surface}.`);
    names.add(surface+":"+tool);
    const convert=conversions(operation.input?.properties,binds,target), scopes=(operation.requires?.auth?.all??[]).flatMap(p=>typeof p === "object" && "ctx.auth.scope" in p ? [p["ctx.auth.scope"]] : []);
    const fields=[`name: ${q(tool)}`,`surface: ${q(surface)}`,`description: ${q(resolveLocalizedText(operation.description,"en","en") ?? name)}`,`inputSchema: ${q(schema)}`,...((operation.requires?.auth?.all.length ?? 0)>0?["closed: true"]:[]),...(scopes.length?[`scopes: ${q(scopes)}`]:[]),`validate: validate${index}`,...(convert?[`convert: ${convert}`]:[]),
      ...(kind === "views" ? [`path: ${q(`views/${name}`)}`,`page: run${index}`] : [`run: ${ref ? `(db, caller, input, handlers) => store(db, caller, { handlers }).procedures[${q(name)}](input)` : `run${index}`}`])];
    tools.push(`{ ${fields.join(", ")} }`);
  };
  for (const [name, view] of Object.entries(plan.views)) if (view.surface !== "internal") add(name,"views",view.surface);
  const exposed = new Set<string>();
  for (const trigger of Object.values(plan.triggers)) if (trigger.source.kind === "mcp") {
    const key = trigger.source.surface + ":" + trigger.procedure;
    if (!exposed.has(key)) { exposed.add(key); add(trigger.procedure,"procedures",trigger.source.surface); }
  }
  const transitionInput = {type:"object", properties:{id:{type:"string",minLength:1},expectedVersion:{type:"integer",minimum:1}},required:["id","expectedVersion"],additionalProperties:false} as const;
  for(const schema of Object.values(plan.schemas)) if(schema.publishing) for(const verb of ["publish","unpublish","archive"]) {
    const name=`${schema.name}.${verb}`,input={...transitionInput,required:[...transitionInput.required]};
    Object.assign(files,emitValidation({views:{},procedures:{[name]:{input}}},refuse));
    add(name,"procedures","staff",{input,requires:{auth:{all:[{"ctx.staff":[...STAFF_ROLES]}]}}},mcpToolNameSegment(`${verb}_${schema.name}`));
  }
  return {...files,"mcp.ts": `import { mcp as serve, type Options as McpOptions } from "@aotter/mantle-next/mcp";
${databaseImport(target)}
${refs ? 'import type { Handlers } from "./generated.js";' : ""}
${hasRef ? 'import { store } from "./generated.js";' : ""}
${imports.join("\n")}
export type Options<Env = unknown> = McpOptions<Env, Database>${refs ? " & { handlers: Handlers }" : ""};
export function mcp<Env = unknown>(options: Options<Env>): (request: Request, env: Env) => Promise<Response | undefined> {
  return serve<Env, Database${refs ? ", Handlers" : ""}>([
${tools.map(tool=>"    "+tool+",").join("\n")}
  ], ${q(STAFF_ROLES)}, options);
}
`};
}
