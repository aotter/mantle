/** Selected extension routes/assets over generated declarations and form checks, never a runtime plan. */
import { ContractError } from "../contracts.js";
import { adminCaller, body, type Options, type Route } from "../admin.js";
import type { AdminExtension } from "./extension-types.js";
export { ADMIN_EXTENSION_TARGETS } from "./extension-types.js";
export type * from "./extension-types.js";
export type ExtensionMetadata = {readonly id:string;readonly declaration:string;readonly public:Readonly<Record<string,unknown>>;readonly module?:string;readonly integrity?:string;readonly source:boolean;readonly settings:readonly string[];readonly actions:readonly{ id:string;target:string;schema?:readonly string[] }[]};
type FormCheck=(value:unknown)=>Readonly<Record<string,string>>;
function invalid(message:string,path="admin-extensions"):never{throw new ContractError("UI_EXTENSION_INVALID",message,path,{status:400});}
function notFound():never{throw new ContractError("NOT_FOUND","no such route","admin");}
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==="object"&&!Array.isArray(value);
const sourcePath=(id:string)=>"/admin/extensions/"+id+".js";
function importMap(html:string,integrity:Record<string,string>):string {
  const found=/<script type="importmap">([\s\S]*?)<\/script>/.exec(html);let map:Record<string,unknown>={};
  try{if(found){const parsed:unknown=JSON.parse(found[1]!);if(object(parsed))map=parsed;}}catch{}
  const json=JSON.stringify({...map,integrity:{...(object(map.integrity)?map.integrity:{}),...integrity}}).replace(/</g,"\\u003c"),tag='<script type="importmap">'+json+'</script>';
  return found?html.replace(found[0],()=>tag):html.replace(/<head>/i,head=>head+tag);
}
function record(raw:unknown){if(!object(raw)||typeof raw.schema!=="string"||typeof raw.id!=="string"||!raw.id||raw.version!==undefined&&!Number.isInteger(raw.version))throw new ContractError("INPUT_VALIDATION_FAILED","record is { schema, id, version? }","admin");return{schema:raw.schema,id:raw.id,...raw.version===undefined?{}:{version:raw.version as number}};}
/** Pass returned facets to generated admin; its session/origin gate owns every API call. */
export function extensionOptions<Env,Database>(metadata:readonly ExtensionMetadata[],checks:Readonly<Record<string,FormCheck>>,definitions:readonly AdminExtension<Env,Database>[],options:Pick<Options<Env,Database>,"caller"|"assets">) {
  if(!Array.isArray(definitions)||definitions.length!==metadata.length)invalid("Extensions differ from the generated declarations.");
  const bound=metadata.map(meta=>{
    const matches=definitions.filter(e=>e.id===meta.id);if(matches.length!==1)invalid("Extension '"+meta.id+"' is missing or duplicated.");const ext=matches[0]!;
    const {handlers,source,...declaration}=ext;
    if(JSON.stringify(declaration)!==meta.declaration||(source!==undefined)!==meta.source)invalid("Extension '"+meta.id+"' differs from generation.");
    if(source!==undefined&&typeof source!=="string"&&typeof source!=="function")invalid("Extension source must be code or a loader.");
    if(!object(handlers??{})||Object.keys(handlers??{}).some(key=>!["api","settings","actions"].includes(key)))invalid("Handlers have api, settings and actions only.");
    if(handlers?.settings!==undefined&&!object(handlers.settings)||handlers?.actions!==undefined&&!object(handlers.actions))invalid("Handler settings and actions are objects.");
    for(const key of Object.keys(handlers?.settings??{}))if(!meta.settings.includes(key))invalid("Unknown settings handler '"+key+"'.");
    for(const key of Object.keys(handlers?.actions??{}))if(!meta.actions.some(action=>action.id===key))invalid("Unknown action handler '"+key+"'.");
    for(const id of meta.settings)if(!Object.hasOwn(handlers?.settings??{},id)||typeof handlers?.settings?.[id]?.load!=="function"||typeof handlers.settings[id]!.save!=="function")invalid("Settings '"+meta.id+"/"+id+"' needs load and save.");
    for(const action of meta.actions)if(!Object.hasOwn(handlers?.actions??{},action.id)||typeof handlers?.actions?.[action.id]?.run!=="function")invalid("Action '"+meta.id+"/"+action.id+"' needs run.");
    if(handlers?.api!==undefined&&typeof handlers.api!=="function")invalid("Extension api must be a function.");
    return{meta,ext};
  });
  const sources=new Map<string,Promise<{code:string;integrity:string}>>();
  const source=(id:string,ext:AdminExtension<Env,Database>)=>{
    let found=sources.get(id);if(!found){found=(async()=>{const code=typeof ext.source==="function"?await ext.source():ext.source;if(typeof code!=="string"||!code)invalid("Source returned no code.","admin-extension:"+id+"/source");const bytes=new Uint8Array(await crypto.subtle.digest("SHA-384",new TextEncoder().encode(code)));return{code,integrity:"sha384-"+btoa(String.fromCharCode(...bytes))};})();sources.set(id,found);found.catch(()=>sources.delete(id));}return found;
  };
  const routes:Route<Env,Database>[]=[];
  for(const {meta,ext} of bound){
    for(const id of meta.settings){const path="/x/"+meta.id+"/settings/"+id;
      routes.push({method:"GET",path,run:async ctx=>({value:(await ext.handlers!.settings![id]!.load(ctx.caller,ctx))??null})},
        {method:"PATCH",path,run:async ctx=>{const value=(await body(ctx.request)).value,errors=checks[meta.id+"/"+id]!(value);if(Object.keys(errors).length)return Response.json({error:{code:"INPUT_VALIDATION_FAILED",message:"The settings do not match their schema.",fields:errors}},{status:400});const saved=await ext.handlers!.settings![id]!.save(ctx.caller,value as Record<string,unknown>,ctx);return{value:saved??value};}});
    }
    for(const action of meta.actions)routes.push({method:"POST",path:"/x/"+meta.id+"/actions/"+action.id,run:async ctx=>{
      const raw=await body(ctx.request);let input:{record?:ReturnType<typeof record>;selection?:{schema:string;ids:string[]};schema?:string};
      if(action.target==="record/v1")input={record:record(raw.record)};
      else if(action.target==="list.selection/v1"){const s=raw.selection;if(!object(s)||typeof s.schema!=="string"||!Array.isArray(s.ids)||!s.ids.length||s.ids.length>1000||s.ids.some(id=>typeof id!=="string"||!id))throw new ContractError("INPUT_VALIDATION_FAILED","selection is { schema, ids } with 1 to 1000 ids","admin");input={selection:{schema:s.schema,ids:s.ids as string[]}};}
      else{if(typeof raw.schema!=="string")throw new ContractError("INPUT_VALIDATION_FAILED","schema names the list","admin");input={schema:raw.schema};}
      const schema=input.record?.schema??input.selection?.schema??input.schema!;if(action.schema&&!action.schema.includes(schema))notFound();return{ok:true,result:(await ext.handlers!.actions![action.id]!.run(ctx.caller,input,ctx))??null};
    }});
    if(ext.handlers?.api)routes.push({method:"*",path:"/x/"+meta.id+"/api/{path*}",preserveCacheControl:true,run:async ctx=>(await ext.handlers!.api!(ctx.request,{...ctx,extension:meta.id,path:ctx.url.pathname.split("/").slice(6).join("/")}))??notFound()});
  }
  return {extensions:metadata.map(meta=>meta.public),routes,assets:async(path:string,request:Request,env:Env):Promise<Response|null>=>{
    if(/^extensions\/([a-z][a-z0-9-]{0,62})\.js$/.test(path)){const caller=await adminCaller(request,env,options.caller);if(caller instanceof Response)return caller;const found=bound.find(e=>sourcePath(e.meta.id).slice(7)===path&&e.meta.source);if(!found)notFound();return new Response((await source(found.meta.id,found.ext)).code,{headers:{"content-type":"text/javascript; charset=utf-8","cache-control":"private, no-cache","x-content-type-options":"nosniff"}});}
    const response=await options.assets?.(path,request,env)??null;
    if(!response||path==="preview.html"||!/^text\/html\b/i.test(response.headers.get("content-type")??"")||!bound.some(e=>e.meta.source||e.meta.integrity))return response;
    const integrity=Object.fromEntries(await Promise.all(bound.flatMap(({meta,ext})=>meta.module&&meta.integrity?[Promise.resolve([meta.module,meta.integrity])]:meta.source?[source(meta.id,ext).then(s=>[sourcePath(meta.id),s.integrity])]:[])));
    const headers=new Headers(response.headers);headers.delete("content-length");return new Response(importMap(await response.text(),integrity),{status:response.status,headers});
  }};
}
