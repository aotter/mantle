/** Selected Admin boundary. SQL and validators are generated; the application owns identity and assets. */
import { ContractError, checkOrigin, surfaceCaller, surfaceFailure, type Caller } from "./contracts.js";
import { convert, invalid, type Conversions } from "./surface.js";
import { siteInfo, type SiteConfig, type MediaStorage } from "./site.js";
import { escapeLike } from "./dialect/common.js";
type Staff = Extract<Caller,{kind:"user"}> & {readonly role:"staff";readonly credential:"session"};
type Descriptor = {readonly name:string;readonly [key:string]:unknown};
type Page = {rows:readonly Record<string,unknown>[];nextCursor?:string};
export interface Context<Env,Database> {request:Request;url:URL;env:Env;db:Database;caller:Staff;params:Record<string,string>}
/** Optional Admin modules add routes inside the same session/origin gate. Paths are relative to /admin/api. */
export interface Route<Env,Database> {readonly method:string;readonly path:string;readonly preserveCacheControl?:boolean;run(context:Context<Env,Database>):Promise<unknown>}
export interface Options<Env,Database> {
  db:(env:Env)=>Database;
  caller:(request:Request,env:Env)=>Caller|Promise<Caller>;
  assets?:(path:string,request:Request,env:Env)=>Response|null|Promise<Response|null>;
  getUser?:(subject:string,request:Request,env:Env)=>Promise<{githubLogin?:string|null;name?:string|null;email?:string|null;image?:string|null}|null>;
  site?:(db:Database,caller:Caller)=>{read():Promise<SiteConfig>};
  media?:MediaStorage;
  identity?:{roles?:{sendStaffInvitation?:unknown}};
  mcpEndpoints?:{public?:string|null;staff?:string|null};
  extensions?:readonly unknown[];
  routes?:readonly Route<Env,Database>[];
}
export interface View<Database> {
  name:string;allows:(caller:Caller)=>boolean;
  query:(params:URLSearchParams)=>{input:Record<string,unknown>;limit?:number;cursor?:string};
  page:(db:Database,caller:Caller,input:never,options:{limit?:number;cursor?:string;match?:Record<string,unknown>})=>Promise<Page>;
  convert?:Conversions;names?:Readonly<Record<string,string>>;
  search?:boolean;filters?:readonly(readonly[name:string,type:string])[];sqlite?:boolean;
  filterValues?:Readonly<Record<string,(raw:string)=>unknown>>;
  columns:readonly string[];
}
export interface Operation<Database,Handlers> {
  name:string;allows:(caller:Caller)=>boolean;
  validate:(raw:unknown)=>Record<string,unknown>;convert?:Conversions;
  run:(db:Database,caller:Caller,input:never,handlers:Handlers)=>Promise<unknown>;
}
const headers={"cache-control":"no-store"};
/** The same fresh session gate applies to API routes and selected extension source assets. */
export async function adminCaller<Env>(request:Request,env:Env,resolve:Options<Env,unknown>["caller"]):Promise<Staff|Response> {
  const caller=await surfaceCaller(request,env,resolve);
  if(caller.kind==="anonymous")throw new ContractError("UNAUTHENTICATED","Sign in to use Admin.","admin");
  if(caller.kind!=="user"||caller.role!=="staff"||caller.credential!=="session")return Response.json({error:{code:"AUTH_DENIED",message:"Admin needs a signed-in staff session.",path:"admin"},minimumRole:"staff"},{status:403,headers});
  checkOrigin(request,caller);return caller as Staff;
}
const fail=(message:string):never=>invalid(message,"admin");
/** Bounded before consuming a declared oversized body. */
export async function body(request:Request):Promise<Record<string,unknown>> {
  if(Number(request.headers.get("content-length"))>1_000_000)fail("Request body exceeds 1000000 bytes.");
  const bytes=await request.arrayBuffer();if(bytes.byteLength>1_000_000)fail("Request body exceeds 1000000 bytes.");
  let value:unknown;try {value=JSON.parse(new TextDecoder().decode(bytes));}catch{fail("Expected a JSON body.");}
  if(!value||typeof value!=="object"||Array.isArray(value))fail("Expected a JSON object.");return value as Record<string,unknown>;
}
function matched(view:View<unknown>,params:URLSearchParams):Record<string,unknown> {
  const result:Record<string,unknown>={},search=params.get("search")?.trim();
  if(search&&view.search){if(search.includes("\0"))fail("Search must not contain NUL.");result.search="%"+escapeLike(search)+"%";}
  for(const [name,type] of view.filters??[]){
    const raw=params.get("filter."+name);if(raw===null||raw==="")continue;
    let value:unknown=raw;
    if(view.filterValues&&Object.hasOwn(view.filterValues,name))try{value=view.filterValues[name]!(raw);}catch{fail("Expected a valid value for filter."+name);}
    else if(type==="boolean"){if(raw!=="true"&&raw!=="false")fail("Expected true or false for filter."+name);value=view.sqlite?Number(raw==="true"):raw==="true";}
    else if(type==="integer"||type==="number"){value=Number(raw);if(!raw.trim()||!Number.isFinite(value)||type==="integer"&&!Number.isSafeInteger(value))fail("Expected a valid number for filter."+name);}
    result["filter."+name]=value;
  }
  return result;
}
function cell(value:unknown):string {
  const text=value==null?"":typeof value==="object"?JSON.stringify(value):String(value);
  const safe=typeof value==="string"&&/^[\s\u0000-\u001f]*[=+@-]|^[\t\r]/u.test(text)?"'"+text:text;
  return /[",\r\n]/.test(safe)?'"'+safe.replaceAll('"','""')+'"':safe;
}
export async function csv(name:string,read:(cursor?:string)=>Promise<Page>,declared:readonly string[]):Promise<Response> {
  let page=await read();const columns=declared.length?declared:[...new Set(page.rows.flatMap(row=>Object.keys(row)))];
  async function* lines(){yield "\uFEFF"+columns.map(cell).join(",")+"\r\n";for(;;){yield page.rows.map(row=>columns.map(key=>cell(row[key])).join(",")+"\r\n").join("");if(!page.nextCursor)return;page=await read(page.nextCursor);}}
  const iterator=lines(),encoder=new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({async pull(controller){try{const next=await iterator.next();if(next.done)controller.close();else controller.enqueue(encoder.encode(next.value));}catch(error){console.error("[mantle admin] export failed");controller.error(new Error("CSV export failed."));}},async cancel(){await iterator.return(undefined);}}),{headers:{...headers,"content-type":"text/csv; charset=utf-8","content-disposition":`attachment; filename="${encodeURIComponent(name)}.csv"`}});
}
function params(pattern:string,path:string):Record<string,string>|undefined {
  const keys=pattern.split("/"),parts=path.split("/"),tail=keys.at(-1)?.endsWith("*}");if(tail?parts.length<keys.length-1:keys.length!==parts.length)return;
  const result:Record<string,string>={};for(let i=0;i<keys.length;i++){const key=keys[i]!,part=parts[i]!;if(tail&&i===keys.length-1){result[key.slice(1,-2)]=parts.slice(i).join("/");return result;}if(key.startsWith("{")&&key.endsWith("}")){if(!part)return;result[key.slice(1,-1)]=part;}else if(key!==part)return;}return result;
}
export function admin<Env,Database,Handlers=never>(metadata:{collections:readonly Descriptor[];collectionNames?:readonly string[];views:readonly Descriptor[];operations:readonly Descriptor[];webmcp:unknown},views:readonly View<Database>[],operations:readonly Operation<Database,Handlers>[],options:Options<Env,Database>&{handlers?:Handlers}):(request:Request,env:Env)=>Promise<Response|undefined> {
  const sees=(items:readonly Descriptor[],routes:readonly{ name:string;allows:(caller:Caller)=>boolean }[],caller:Caller)=>items.filter(item=>routes.some(route=>route.name===item.name&&route.allows(caller)));
  return async(request,env)=>{
    const url=new URL(request.url),raw=url.pathname;if(raw!=="/admin"&&!raw.startsWith("/admin/"))return;
    try {
      const rel=raw.slice(7).replace(/^\//,"");
      if(rel!=="api"&&!rel.startsWith("api/")){
        if(request.method!=="GET"||!options.assets||/(^|\/)\.\.(\/|$)|%2f|%5c|\\/i.test(rel))throw new ContractError("NOT_FOUND","No such route.","admin");
        let decoded="";try{decoded=decodeURIComponent(rel);}catch{fail("Malformed asset path.");}
        if(decoded.split("/").some(part=>part===".."||part==="."))throw new ContractError("NOT_FOUND","No such route.","admin");
        const file=rel.split("/").at(-1)!.includes(".")?await options.assets(rel,request,env):null;
        const res=file??(rel.startsWith("assets/")?null:await options.assets("index.html",request,env));if(!res)throw new ContractError("NOT_FOUND","No such route.","admin");
        const h=new Headers(res.headers);h.set("x-content-type-options","nosniff");
        if(file?.ok&&rel.startsWith("assets/"))h.set("cache-control","public, max-age=31536000, immutable");
        if(!(file&&(decoded==="preview.html"||!/^text\/html\b/i.test(res.headers.get("content-type")??"")))){h.append("content-security-policy","frame-ancestors 'none'");h.set("x-frame-options","DENY");h.set("cache-control","no-store");}
        return new Response(res.body,{status:res.status,headers:h});
      }
      const caller=await adminCaller(request,env,options.caller);if(caller instanceof Response)return caller;
      let path="";try{path=decodeURIComponent(rel.slice(3)).replace(/\/$/,"")||"/";}catch{fail("Malformed Admin path.");}
      if(/%2f|%5c/i.test(rel)||path.includes("\\")||path.split("/").some(x=>x==="."||x===".."))fail("Malformed Admin path.");
      const db=options.db(env),context:Context<Env,Database>={request,url,env,db,caller,params:{}};
      const me=async()=>{const user=await options.getUser?.(caller.subject,request,env);return {userId:caller.subject,role:caller.role,login:user?.githubLogin||user?.name||user?.email||null,image:user?.image??null};};
      const site=async()=>siteInfo(options.site?await options.site(db,caller).read():{brand:"AotterMantle",title:"CMS",description:"",origin:"",locales:[],canonicalLocale:null,icons:[{src:"/admin/favicon.png",mimeType:"image/png",sizes:["64x64"]},{src:"/admin/favicon.svg",mimeType:"image/svg+xml",sizes:["any"]}],media:{purposes:[]}}, {origin:url.origin,siteSettings:!!options.site,media:!!options.media,invitationEmail:!!options.identity?.roles?.sendStaffInvitation,mcpEndpoints:options.mcpEndpoints,extensions:options.extensions});
      const listViews=()=>sees(metadata.views,views,caller),listOperations=()=>sees(metadata.operations,operations,caller);
      const readView=async(view:View<Database>,cursor?:string,limit?:number)=>{
        const {input:raw,...paging}=view.query(url.searchParams),input={...raw};convert(input,view.convert);
        const page=await view.page(db,caller,input as never,{...paging,...(cursor?{cursor}:{}),...(limit?{limit,cursor}:{}),match:matched(view as View<unknown>,url.searchParams)});
        if(view.names)page.rows=page.rows.map(row=>Object.fromEntries(Object.entries(row).map(([key,value])=>[Object.hasOwn(view.names!,key)?view.names![key]!:key,value])));return page;
      };
      const routes:Route<Env,Database>[]=[
        {method:"GET",path:"/me",run:me},{method:"GET",path:"/site",run:site},
        {method:"GET",path:"/collections",run:async()=>({collections:metadata.collections})},
        {method:"GET",path:"/views-manifest",run:async()=>({views:listViews()})},
        {method:"GET",path:"/operations",run:async()=>({operations:listOperations()})},
        {method:"GET",path:"/bootstrap",run:async()=>{const [user,settings,entries]=await Promise.all([me(),site(),url.searchParams.get("collection")?options.routes?.find(r=>r.path==="/entries"&&r.method==="GET")?.run(context):undefined]);return{me:user,site:settings,collections:metadata.collections,views:listViews(),operations:listOperations(),webmcp:metadata.webmcp,...(entries?{entries}:{})};}},
        {method:"GET",path:"/collections/{name}/statistics",run:async({params})=>{if(!(metadata.collectionNames??metadata.collections.map(c=>c.name)).some(name=>name.toLowerCase()===params.name?.toLowerCase()))throw new ContractError("NOT_FOUND","No such collection.","admin");return Response.json({error:{code:"STATISTICS_UNAVAILABLE",message:"Statistics are unavailable for this storage adapter."}},{status:501,headers});}},
        {method:"GET",path:"/views/{name}",run:async({params})=>{const view=views.find(v=>v.name===params.name&&v.allows(caller));if(!view)throw new ContractError("NOT_FOUND","No such staff View.","admin");return readView(view);}},
        {method:"GET",path:"/views/{name}/export",run:async({params})=>{const view=views.find(v=>v.name===params.name&&v.allows(caller));if(!view)throw new ContractError("NOT_FOUND","No such staff View.","admin");return csv(view.name,cursor=>readView(view,cursor,500),view.columns);}},
        {method:"POST",path:"/operations/{name}",run:async({params})=>{const operation=operations.find(p=>p.name===params.name&&p.allows(caller));if(!operation)throw new ContractError("NOT_FOUND","No such operation.","admin");const input=operation.validate(await body(request));convert(input,operation.convert);return{ok:true,output:await operation.run(db,caller,input as never,options.handlers as Handlers)};}},
        ...(options.routes??[]),
      ];
      const allowed:string[]=[];
      for(const route of routes){const found=params(route.path,path);if(!found)continue;allowed.push(route.method);if(route.method!=="*"&&route.method!==request.method)continue;const output=await route.run({...context,params:found});if(output instanceof Response){const h=new Headers(output.headers);if(!route.preserveCacheControl||!h.has("cache-control"))h.set("cache-control","no-store");return new Response(output.body,{status:output.status,statusText:output.statusText,headers:h});}return Response.json(output,{headers});}
      if(allowed.length){const response=surfaceFailure(new ContractError("METHOD_NOT_ALLOWED","Method is not allowed for this route.","admin"));response.headers.set("allow",[...new Set(allowed)].join(", "));return response;}
      throw new ContractError("NOT_FOUND","No such route.","admin");
    }catch(error){return surfaceFailure(error);}
  };
}
