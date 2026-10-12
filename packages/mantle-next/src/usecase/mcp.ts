/** Emit the selected MCP boundary; the official transport loads on its first request. */
import { STAFF_ROLES, mcpToolNameSegment, resolveLocalizedText, type RuntimePlan, type PlanLowered } from "@aotter/mantle/spec";
import type { Target } from "../domain/model.js";
import { emitValidation } from "./validation.js";
import { emitBoundaryInput } from "../domain/input.js";
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
    tools.push(`{ name:${q(tool)}, surface:${q(surface)}, description:${q(resolveLocalizedText(operation.description,"en","en") ?? name)}, inputSchema:${q(schema)}, write:${kind === "procedures"}, closed:${(operation.requires?.auth?.all.length ?? 0)>0}, scopes:${q((operation.requires?.auth?.all??[]).flatMap(p=>typeof p === "object" && "ctx.auth.scope" in p ? [p["ctx.auth.scope"]] : []))}, async run(raw:Record<string,unknown>,db:Database,caller:Caller${refs ? ",handlers:Handlers" : ""}) { ${kind === "views" ? `const {limit,cursor,...input}=raw; if(limit!==undefined&&(!Number.isSafeInteger(limit)||Number(limit)<1||Number(limit)>500)||cursor!==undefined&&typeof cursor!=="string") throw new ContractError("INPUT_VALIDATION_FAILED","Invalid paging options.",${q(`views/${name}`)}); validate${index}(input); ${emitBoundaryInput(operation.input?.properties,binds,target)} return run${index}(db,caller,input as never,{limit:limit as number|undefined,cursor:cursor as string|undefined});` : `const input=validate${index}(raw); ${emitBoundaryInput(operation.input?.properties,binds,target)} return ${ref ? `store(db,caller,{handlers}).procedures[${q(name)}](input as never)` : `run${index}(db,caller,input as never)`};`} } }`);
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
  const database = target.endsWith("postgres") ? 'import type { Postgres as Database } from "@aotter/mantle-next/contracts";' : `import type { Handle as Database } from "@aotter/mantle-next/driver/${target === "bun-sqlite" ? "bun-sqlite" : "d1"}";`;
  return {...files,"mcp.ts": `import { ContractError, checkOrigin, surfaceCaller, surfaceError, surfaceFailure, wire, type Caller } from "@aotter/mantle-next/contracts";
${database}
${refs ? 'import type { Handlers } from "./generated.js";' : ""}
${hasRef ? 'import { store } from "./generated.js";' : ""}
${imports.join("\n")}
interface Tool {name:string;surface:string;description:string;inputSchema:unknown;write:boolean;closed:boolean;scopes:readonly string[];run(raw:Record<string,unknown>,db:Database,caller:Caller${refs ? ",handlers:Handlers" : ""}):Promise<unknown>;}
const tools:Tool[] = [${tools.join(",\n")}];
export interface Options<Env=unknown> { db:(env:Env)=>Database; caller:(request:Request,env:Env)=>Caller|Promise<Caller>; ${refs ? "handlers:Handlers;" : ""} }
export function mcp<Env=unknown>(options:Options<Env>) {
  return async (request:Request,env:Env):Promise<Response|undefined> => {
    const url=new URL(request.url),path=url.pathname.replace(/\\/+$/, ""),surface=path==="/mcp"?"public":path==="/mcp/staff"?"staff":undefined;
    if(!surface) return;
    const selected=tools.filter(tool=>tool.surface===surface);
    const challenge=(error:unknown,scope?:string,bare=false) => { const result=wire(error); if(result.status===401) scope??="mcp"; return surfaceFailure(error,bare?undefined:'Bearer '+(scope?(result.status===403?'error="insufficient_scope", ':'')+'scope="'+scope+'", ':'')+'resource_metadata="'+url.origin+'/.well-known/oauth-protected-resource/mcp"'); };
    let caller:Caller;
    try { caller=await surfaceCaller(request,env,options.caller);
      if(caller.kind==="anonymous"&&(surface==="staff"||selected.length>0&&selected.every(tool=>tool.closed))) throw new ContractError("UNAUTHENTICATED","Authentication is required.","mcp");
      if(caller.kind==="system") return challenge(new ContractError("AUTH_DENIED","System callers cannot use MCP.","mcp"),undefined,true);
      
      if(surface==="staff"&&caller.kind==="user"&&!(${q(STAFF_ROLES)} as readonly string[]).includes(caller.role??"")) return challenge(new ContractError("AUTH_DENIED","Staff role is required.","mcp/staff"),undefined,true);
      if(caller.kind==="user"&&caller.credential!=="session"&&!caller.scopes.includes("mcp")) return challenge(new ContractError("AUTH_DENIED","The credential needs the mcp scope.","mcp"),[...new Set([...caller.scopes,"mcp"])].join(" "));
    } catch(error) { return challenge(error); }
    const {McpServer,createMcpHandler,fromJsonSchema,readRequestBody}=await import("@modelcontextprotocol/server");
    let parsedBody:unknown;
    if(request.method==="POST") {
      try { const body=await readRequestBody(request.clone(),1024*1024); if(body.tooLarge) return Response.json({jsonrpc:"2.0",id:null,error:{code:-32000,message:"Request body exceeds 1048576 bytes."}},{status:413}); parsedBody=JSON.parse(body.text); } catch {}
      for(const message of Array.isArray(parsedBody)?parsedBody:[parsedBody]) {
        if(!message||message.method!=="tools/call") continue;
        const tool=selected.find(tool=>tool.name===message.params?.name);
        if(!tool) continue;
        if(caller.kind==="anonymous"&&tool.closed) return challenge(new ContractError("UNAUTHENTICATED","Authentication is required.","mcp"),["mcp",...tool.scopes].join(" "));
        if(caller.kind==="user"&&caller.credential==="oauth"&&tool.scopes.some(scope=>!caller.scopes.includes(scope))) return challenge(new ContractError("AUTH_DENIED","The credential needs additional scopes.","mcp"),[...new Set([...caller.scopes,...tool.scopes])].join(" "));
      }
    }
    const handler=createMcpHandler(()=>{
      const server=new McpServer({name:"aotter.mantle",version:"0.2.0"},{capabilities:{tools:{listChanged:false}}});
      for(const tool of selected) server.registerTool(tool.name,{description:tool.description,inputSchema:fromJsonSchema(tool.inputSchema as Parameters<typeof fromJsonSchema>[0],{getValidator<T>():import("@modelcontextprotocol/server").JsonSchemaValidator<T> { return (input:unknown)=>({valid:true,data:input as T,errorMessage:undefined}); }})},async(raw:unknown)=>{
        try {
          if(tool.write) checkOrigin(request,caller);
          const data=await tool.run(raw as Record<string,unknown>,options.db(env),caller${refs ? ",options.handlers" : ""});
          return {content:[{type:"text" as const,text:JSON.stringify(data)}],...(data&&typeof data==="object"&&!Array.isArray(data)?{structuredContent:data as Record<string,unknown>}: {})};
        } catch(error) { return {isError:true,content:[{type:"text" as const,text:JSON.stringify({diagnostics:[surfaceError(error).error]})}]}; }
      });
      return server;
    },{legacy:"stateless",maxRequestBodySize:1024*1024});
    return handler.fetch(request,{parsedBody});
  };
}
`};
}
