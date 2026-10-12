/** Routes reference selected generated boundaries, never a runtime manifest. */
import type { RuntimePlan, PlanLowered } from "@aotter/mantle/spec";
import type { Target } from "../domain/model.js";
import { emitBoundaryInput } from "../domain/input.js";
const q = JSON.stringify;
export function emitRest(plan: RuntimePlan, lowered: PlanLowered, target: Target): Record<string,string> {
  const driver = target === "bun-sqlite" ? "bun-sqlite" : target === "cloudflare-d1" ? "d1" : "postgres";
  const refs = Object.values(plan.procedures).some(p=>"ref" in p.handler);
  const imports = ['import { ContractError, checkOrigin, surfaceCaller, surfaceFailure, type Caller } from "@aotter/mantle-next/contracts";', driver === "postgres" ? 'import type { Postgres as Database } from "@aotter/mantle-next/contracts";' : `import type { Handle as Database } from "@aotter/mantle-next/driver/${driver}";`, ...(refs ? ['import { store, type Handlers } from "./generated.js";'] : [])];
  const routes:string[]=[];
  const pattern = (path:string) => {
    const keys:string[]=[];
    const regex=path.split("/").map(segment=>{
      if (segment.startsWith("{")&&segment.endsWith("}")) {keys.push(segment.slice(1,-1));return "([^/]+)";}
      return encodeURIComponent(segment).replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
    }).join("/");
    return `pattern: new RegExp(${q("^"+regex+"/?$")}), keys: ${q(keys)}`;
  };
  for (const [name,view] of Object.entries(plan.views)) {
    if(view.surface!=="public") continue;
    const id=routes.length,encoded=encodeURIComponent(name);
    imports.push(`import page${id} from "./paged/views/${encoded}.js";`,`import { query as query${id} } from "./validation/views/${encoded}.js";`);
    routes.push(`{method:"GET",${pattern(`/api/views/${name}`)},async run(request:Request,db:Database,caller:Caller,params:Record<string,string>) {const {input:raw,...paging}=query${id}(new URL(request.url).searchParams);const input={...raw};${emitBoundaryInput(view.input?.properties,(lowered.views[name]?.public ?? lowered.views[name]?.caller)?.binds ?? [],target)} return page${id}(db,caller,input as Parameters<typeof page${id}>[2],paging);}}`);
  }
  const triggers=Object.values(plan.triggers).filter(t=>t.source.kind==="http").sort((a,b)=>a.source.kind==="http"&&b.source.kind==="http"?(a.source.path.match(/\{/g)?.length??0)-(b.source.path.match(/\{/g)?.length??0):0);
  for(const trigger of triggers) {
    if(trigger.source.kind!=="http") continue;
    const {method,path}=trigger.source,name=trigger.procedure,procedure=plan.procedures[name]!,id=routes.length,ref="ref" in procedure.handler;
    if(!ref) imports.push(`import procedure${id} from "./procedures/${encodeURIComponent(name)}.js";`);
    imports.push(`import { validate as validate${id} } from "./validation/procedures/${encodeURIComponent(name)}.js";`);
    const params=[...path.matchAll(/\{([^}]+)\}/g)].map(([,key])=>{
      const type=[procedure.input?.properties?.[key!]?.type].flat().find(t=>t&&t!=="null"),raw=`params[${q(key)}]`;
      return `[${q(key)}]:${type==="integer"||type==="number"?`number(${raw})`:type==="boolean"?`boolean(${raw})`:raw}`;
    });
    routes.push(`{method:${q(method)},${pattern(path)},async run(request:Request,db:Database,caller:Caller,params:Record<string,string>) {const input=validate${id}({...await body(request),${params.join(",")}});${emitBoundaryInput(procedure.input?.properties,lowered.procedures[name]?.caller?.flatMap(s=>s.binds) ?? [],target)}return ${ref?`store(db,caller,{handlers:options.handlers}).procedures[${q(name)}](input as Parameters<Handlers[${q(name)}]>[1])`:`procedure${id}(db,caller,input as Parameters<typeof procedure${id}>[2])`};}}`);
  }
  return {"rest.ts":`${imports.join("\n")}
const headers={"cache-control":"private, no-store"};
function fail(code:string,message:string):never {throw new ContractError(code,message,"rest");}
function number(raw:string):number {if(!raw.trim()||!Number.isFinite(Number(raw))) fail("INPUT_VALIDATION_FAILED","Expected a number.");return Number(raw);}
function boolean(raw:string):boolean {if(raw!=="true"&&raw!=="false") fail("INPUT_VALIDATION_FAILED","Expected true or false.");return raw==="true";}
async function body(request:Request):Promise<Record<string,unknown>> {
 if(Number(request.headers.get("content-length"))>1_000_000) fail("INPUT_VALIDATION_FAILED","Request body exceeds 1000000 bytes.");
 const bytes=await request.arrayBuffer();
 if(bytes.byteLength>1_000_000) fail("INPUT_VALIDATION_FAILED","Request body exceeds 1000000 bytes.");
 const text=new TextDecoder().decode(bytes);
 let value:unknown;
 try {value=text.trim()?JSON.parse(text):{};} catch {fail("INPUT_VALIDATION_FAILED","Expected a JSON body.");}
 if(!value||typeof value!=="object"||Array.isArray(value)) fail("INPUT_VALIDATION_FAILED","Expected a JSON object.");
 return value as Record<string,unknown>;
}
export function rest<Env>(options:{db:(env:Env)=>Database;caller:(request:Request,env:Env)=>Promise<Caller>${refs?";handlers:Handlers":""}}):(request:Request,env:Env)=>Promise<Response|undefined> {
 const routes: {method:string;pattern:RegExp;keys:readonly string[];run(request:Request,db:Database,caller:Caller,params:Record<string,string>):Promise<unknown>}[]=[${routes.join(",\n")}];
 return async(request,env)=>{
  try {
   const original=new URL(request.url).pathname;
   let path:string;
   try {path=original.split("/").map(segment=>encodeURIComponent(decodeURIComponent(segment))).join("/");} catch {if(original!=="/api"&&!original.startsWith("/api/")) return undefined;fail("INPUT_VALIDATION_FAILED","Malformed request path.");}
   const allowed=new Set<string>();
   for(const route of routes) {
    const match=route.pattern.exec(path);if(!match) continue;allowed.add(route.method);
    if(route.method!==request.method) continue;
    let params:Record<string,string>;
    try {params=Object.fromEntries(route.keys.map((key,index)=>[key,decodeURIComponent(match[index+1]!)]));} catch {fail("INPUT_VALIDATION_FAILED","Malformed path parameter.");}
    const caller=await surfaceCaller(request,env,options.caller);
    checkOrigin(request,caller);
    return Response.json(await route.run(request,options.db(env),caller,params!),{headers});
   }
   if(allowed.size) {const response=surfaceFailure(new ContractError("METHOD_NOT_ALLOWED","Method is not allowed for this route.","rest"));response.headers.set("allow",[...allowed].join(", "));return response;}
   if(path==="/api"||path.startsWith("/api/")) fail("NOT_FOUND","No such route.");
   return undefined;
  } catch(error) {return surfaceFailure(error); }
 };
}
`};
}
