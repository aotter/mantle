/** Optional web output calls public generated Views; SQL owns visibility. */
import type { RuntimePlan, PlanLowered } from "@aotter/mantle/spec";
import type { Target } from "../domain/model.js";
import { emitBoundaryInput } from "../domain/input.js";
export function emitWeb(plan: RuntimePlan, lowered: PlanLowered, target: Target): Record<string,string> {
  const views=Object.entries(plan.views).filter(([,v])=>v.surface==="public"), q=JSON.stringify;
  return {"web.ts": [
    ...views.flatMap(([n],i)=>[`import page${i} from "./paged/views/${encodeURIComponent(n)}.js";`,`import { query as input${i} } from "./validation/views/${encodeURIComponent(n)}.js";`,`import type { Row as Row${i} } from "./views/${encodeURIComponent(n)}.js";`]),
    `import { wire, ContractError, type Caller${target.endsWith("postgres")?", type Postgres as Database":""} } from "@aotter/mantle-next/contracts";`,
    ...(target.endsWith("postgres")?[]:[`import type { Handle as Database } from "@aotter/mantle-next/driver/${target==="bun-sqlite"?"bun-sqlite":"d1"}";`]),
    `type PublicView = ${views.map(([n])=>q(n)).join(" | ")||"never"};`,
    `type Rows = {${views.map(([n],i)=>`${q(n)}:Row${i}`).join(";")}};`,
    `type Inputs = {${views.map(([n,v])=>`${q(n)}:${Object.keys(v.input?.properties??{}).map(k=>q(k)).join(" | ")||"never"}`).join(";")}};`,
    `type ListView = ${views.filter(([,v])=>!v.input?.required?.length).map(([n])=>q(n)).join(" | ")||"never"};`,
    `const booleanKeys: Record<PublicView,readonly string[]> = ${q(Object.fromEntries(views.map(([name,v])=>[name,Object.keys(v.input?.properties??{}).filter(field=>(lowered.views[name]?.public?.binds??[]).some(b=>b.k==="input"&&String(b.name).toLowerCase()===field.toLowerCase()&&String(b.type)==="bool"))])))};`,
    `const queries = {${views.map(([n],i)=>`${q(n)}:(db:Database,caller:Caller,params:URLSearchParams,cursor?:string)=>{ const input={...input${i}(params).input}; ${emitBoundaryInput(plan.views[n]!.input?.properties,lowered.views[n]?.public?.binds??[],target)} return page${i}(db,caller,input as Parameters<typeof page${i}>[2],{limit:500,cursor}); }`).join(",")}};`,
    'type Params<S extends string> = S extends `${string}{${infer P}}${infer Rest}` ? P | Params<Rest> : never;',
    runtime].join("\n")+"\n"};
}
const runtime=String.raw`
type Page = { [V in PublicView]: {view:V;list?:ListView;markdown?:{[K in keyof Rows[V]]:Rows[V][K] extends string|null ? K:never}[keyof Rows[V]] & string} }[PublicView];
type ListKeys<T extends Page> = T extends {list:infer L extends ListView} ? keyof Rows[L] : string;
type Pages<P extends Record<string,Page>> = {[K in keyof P]:K extends string ? [Params<K>] extends [Inputs[P[K]["view"]]] ? [Inputs[P[K]["view"]]] extends [Params<K>] ? [Params<K>] extends [ListKeys<P[K]>] ? [Params<K>] extends [keyof Rows[P[K]["view"]]] ? P[K] : never : never : never : never : never};
type Options<P extends Record<string,Page>,E> = {db:Database;caller:Caller|((request:Request,env:E)=>Caller|Promise<Caller>);origin:string;title:string;description:string;locales?:readonly string[];pages:P & Pages<P>;cacheControl?:string};
type Query = (db:Database,caller:Caller,params:URLSearchParams,cursor?:string)=>Promise<{rows:Record<string,unknown>[];nextCursor?:string}>;
const escape=(v:unknown)=>String(v).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]!));
const label=(v:unknown)=>String(v).replace(/[\r\n]/g," ").replace(/[\\[\]]/g,"\\$&");
export function web<const P extends Record<string,Page>,E=unknown>(options:Options<P,E>) {
  const origin=new URL(options.origin);
  if(!/^https?:$/.test(origin.protocol)||origin.username||origin.password||origin.pathname!=="/"||origin.search||origin.hash) throw new TypeError("origin must be an HTTP(S) origin.");
  const pages=Object.entries(options.pages).map(([path,value])=>{
    const page=value as {view:PublicView;list?:ListView;markdown?:string};
    if(!path.startsWith("/")||/[?#]/.test(path)) throw new TypeError("Page templates must be absolute paths without queries or fragments.");
    const keys:string[]=[];
    const pattern=path.split(/(\{[^{}]+\})/).map(part=>part.startsWith("{")?(keys.push(part.slice(1,-1)),"([^/]+)"):part.replace(/[.*+?^$()|[\]\\]/g,"\\$&")).join("");
    return {path,page,keys,pattern:new RegExp("^"+pattern+"$")};
  }).sort((a,b)=>a.keys.length-b.keys.length);
  const context=async(request:Request,env:E)=>({db:options.db,caller:typeof options.caller==="function"?await options.caller(request,env):options.caller});
  const urlFor=(path:string,row:Record<string,unknown>,view:PublicView)=>origin.origin+path.replace(/\{([^{}]+)\}/g,(_,key:string)=>{
    let value=row[key];if(booleanKeys[view].includes(key)&&(value===0||value===1))value=Boolean(value);if(value===null||value===undefined) throw new TypeError("List View must return every page parameter: "+key);
    const segment=String(value);if(segment==="."||segment==="..")return "";
    return encodeURIComponent(segment).replace(/[()]/g,c=>"%"+c.charCodeAt(0).toString(16).toUpperCase());
  });
  const validUrl=(path:string,row:Record<string,unknown>,view:PublicView)=>{if([...path.matchAll(/\{([^{}]+)\}/g)].some(([,key])=>row[key!] === "."||row[key!] === ".."))return;return urlFor(path,row,view);};
  const match=(path:string)=>{
    for(const entry of pages){const hit=entry.pattern.exec(path);if(!hit)continue;const params=new URLSearchParams();try {entry.keys.forEach((key,i)=>params.set(key,decodeURIComponent(hit[i+1]!)));}catch{throw new ContractError("INPUT_VALIDATION_FAILED","Malformed URL parameter.","web/path");}return {...entry,params};}
  };
  const read=async(entry:NonNullable<ReturnType<typeof match>>,ctx:Awaited<ReturnType<typeof context>>)=>(await (queries[entry.page.view] as Query)(ctx.db,ctx.caller,entry.params)).rows[0];
  const response=async(request:Request,body:string,type:string,caller:Caller)=>{
    const hash=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(body));
    const etag='"'+Array.from(new Uint8Array(hash),b=>b.toString(16).padStart(2,"0")).join("")+'"';
    const headers={"content-type":type+"; charset=utf-8","cache-control":caller.kind==="anonymous"?(options.cacheControl??"public, max-age=60"):"private, no-store",etag};
    const cached=request.headers.get("if-none-match")?.split(",").some(tag=>tag.trim()==="*"||tag.trim().replace(/^W\//,"")===etag);
    return new Response(cached||request.method==="HEAD"?null:body,{status:cached?304:200,headers});
  };
  return {
    async fetch(request:Request,env?:E):Promise<Response|undefined>{
      if(request.method!=="GET"&&request.method!=="HEAD")return;
      const path=new URL(request.url).pathname;
      try {
        if(path!=="/llms.txt"&&path!=="/sitemap.xml"&&(!path.endsWith(".md")||!match(path.slice(0,-3))?.page.markdown))return;
        const ctx=await context(request,env as E);
        if(path!=="/llms.txt"&&path!=="/sitemap.xml"){const exact=match(path);if(exact)try{if(await read(exact,ctx))return;}catch(error){if(wire(error).status!==400)throw error;}}
        if(path==="/llms.txt"||path==="/sitemap.xml"){
          const sitemap=path==="/sitemap.xml",cap=sitemap?50000:5000;
          const start=sitemap?'<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">':"# "+label(options.title)+"\n\n> "+label(options.description)+"\n\n## Pages\n\n",end=sitemap?"</urlset>":"\n";
          const links:string[]=[];let visited=0,requests=0,bytes=new TextEncoder().encode(start+end).length;if(bytes>(sitemap?50*1024*1024:1024*1024))throw new TypeError("Web index header exceeds its byte limit.");
          pagesLoop: for(const entry of pages){
            if(!entry.page.list)continue;
            let cursor:string|undefined;
            do {
              if(requests>=(sitemap?100:10))break pagesLoop;requests++;
              const page=await (queries[entry.page.list] as Query)(ctx.db,ctx.caller,new URLSearchParams(),cursor);
              for(const row of page.rows){if(visited++>=cap)break pagesLoop;const url=validUrl(entry.path,row,entry.page.view);if(!url)continue;const line=sitemap?"<url><loc>"+escape(url)+"</loc></url>":"- ["+label(row.title??url)+"]("+url+"): "+label(row.description??"")+"\n";const length=new TextEncoder().encode(line).length;if(bytes+length>(sitemap?50*1024*1024:1024*1024))break pagesLoop;bytes+=length;links.push(line);}
              if(visited>=cap)break pagesLoop;
              cursor=page.nextCursor;
            }while(cursor);
          }
          return response(request,start+links.join("")+end,sitemap?"application/xml":"text/plain",ctx.caller);
        }
        if(!path.endsWith(".md"))return;
        const entry=match(path.slice(0,-3));if(!entry||!entry.page.markdown)return;
        const row=await read(entry,ctx);if(!row)return new Response(null,{status:404,headers:{"cache-control":"no-store"}});
        const body=row[entry.page.markdown];if(body==null)return new Response(null,{status:404,headers:{"cache-control":"no-store"}});if(typeof body!=="string")throw new TypeError("Markdown field must return text.");
        return response(request,body,"text/markdown",ctx.caller);
      }catch(error){const {status,error:body}=wire(error);return Response.json({error:body},{status,headers:{"cache-control":"no-store"}});}
    },
    async head(request:Request,env?:E):Promise<string>{
      try {
      const path=new URL(request.url).pathname,entry=match(path);if(!entry)return "";
      const ctx=await context(request,env as E),row=await read(entry,ctx);if(!row)return "";
      const canonical=validUrl(entry.path,row,entry.page.view);if(!canonical)return "";
      let tags='<link rel="canonical" href="'+escape(canonical)+'">';
      if(entry.page.markdown)tags+='<link rel="alternate" type="text/markdown" href="'+escape(canonical+".md")+'">';
      if(options.locales?.[0])tags+='<link rel="alternate" hreflang="'+escape(options.locales[0])+'" href="'+escape(canonical)+'">';
      for(const key of Object.keys(row))if(key.endsWith("_lat")&&typeof row[key]==="number"&&typeof row[key.slice(0,-4)+"_lng"]==="number"){tags+='<meta name="geo.position" content="'+escape(row[key])+";"+escape(row[key.slice(0,-4)+"_lng"])+'">';break;}
      return tags;
      }catch{return "";}
    }
  };
}
`;
