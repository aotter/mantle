import {test, expect} from "bun:test";
import { admin as adminFunction, type Route, type Metadata} from "../../src/server/index.js";
import {entries, type EntrySchema} from "../../src/server/entries.js";
import {extensionOptions} from "../../src/server/extensions.js";
import type {Caller} from "@aotter/mantle/contracts";
import type {NativeCollection,NativeProcedureAdapter} from "../../src/server/native.js";
const mode={projection:"id, version, title",from:"FROM fixture",policy:"",binds:[],fields:{title:{column:"title",insert:"@value",update:"title=@value"}},create:{prefix:"create(",between:")(",suffix:")",columns:[],values:[],binds:[],returning:""},patch:{prefix:"patch ",sets:[],where:"",returning:"",binds:[{k:"input" as const,name:"id"},{k:"version" as const}]},remove:{sql:"remove",binds:[{k:"input" as const,name:"id"},{k:"version" as const}],row:true}};
const compiled:NativeCollection={path:"admin/entries",marker:"@value",id:"id",cursorAliases:[{name:"_cursor0",sql:"_cursor0"},{name:"_cursor1",sql:"_cursor1"}],fields:{id:{expression:"id",value:"@value",wire:"id",kind:"text",nullable:false}},orderFields:["id"],caller:mode,trusted:mode,statistics:{time:"created_at",subtype:"NULL",rowsAlias:{name:"_statistics",sql:"_statistics"}}};
const unused:NativeProcedureAdapter<{}>={sqlite:true,values:{},param:n=>"?"+n,escapeLike:value=>value,read:()=>{throw Error("unexpected read");},procedure:async()=>{throw Error("unexpected write");}};
const admin: Caller={kind:"user",subject:"a",role:"admin", admin: true,scopes:[],credential:"session",credentialId:null,clientId:null};
const metadata: Metadata={collections:[],views:[],operations:[],webmcp:{tools:[],routes:{}}};
function fixture(routes: readonly Route<{}, {}>[]=[]){
  let caller: Caller=admin, resolves=0, providers=0;
  const fetch=adminFunction(metadata,[],[],{db:()=>{providers++;return {};},caller:()=>{resolves++;return caller;},routes});
  const ask=(path:string,method="GET",raw?:string,headers:Record<string,string>={})=>fetch(new Request("https://app.test/admin/api"+path,{method,body:raw,headers:{origin:"https://app.test",...headers}}),{});
  return {fetch,ask,caller:(c:Caller)=>caller=c,resolves:()=>resolves,providers:()=>providers};
}
test("admin session gate and builtin JSON byte limits precede database providers",async()=>{
  let writes=0;
  const f=fixture([{method:"PATCH",path:"/save",run:c=>{writes++;const db=c.db;expect(c.db).toBe(db);return c.input;}}]);
  f.caller({kind:"anonymous"});expect((await f.ask("/save","PATCH","{"))?.status).toBe(401);
  f.caller({...admin,kind:"user",credential:"api-key"});expect((await f.ask("/save","PATCH","{}"))?.status).toBe(403);
  f.caller(admin);expect((await f.ask("/save","PATCH","{}",{origin:"https://foreign.test"}))?.status).toBe(403);
  expect((await f.ask("/save","PATCH","{}",{"content-length":"1000001"}))?.status).toBe(400);
  expect((await f.ask("/save","PATCH",JSON.stringify({data:"x".repeat(1000001)})))?.status).toBe(400);
  expect(f.providers()).toBe(0);expect(writes).toBe(0);
  const before=f.resolves();expect(await (await f.ask("/save","PATCH",'{"ok":1}'))?.json()).toEqual({ok:1});expect(f.resolves()-before).toBe(1);expect(f.providers()).toBe(1);
  const wrong=await f.ask("/save");expect(wrong?.status).toBe(405);expect(wrong?.headers.get("allow")).toBe("PATCH");
  expect((await f.ask("/%73ave/","PATCH","{}"))?.status).toBe(200);expect((await f.ask("/save%2fhidden"))?.status).toBe(400);
  expect((await f.ask("/entries/%E0%A4"))?.status).toBe(400);
  expect(await f.fetch(new Request("https://app.test/admin/assets/app.js"),{})).toBeUndefined();
});
test("empty Schema declarations emit no entry routes and bootstrap does no row queries",async()=>{
  expect(entries([],unused)).toEqual([]);
  const f=fixture();const result=await(await f.ask("/bootstrap"))?.json();expect(result.collections).toEqual([]);expect(result.webmcp).toEqual({tools:[],routes:{}});expect(result).not.toHaveProperty("entries");expect((await f.ask("/entries"))?.status).toBe(404);
});
test("raw extension APIs preserve Request identity, raw bytes and custom response/cache",async()=>{
  let seen:Request|undefined;
  const declaration={apiVersion:1 as const,id:"audit",title:"Audit",contributes:{}};
  const ext={...declaration,bodyLimit:2000000,handlers:{api:async(request:Request,ctx:any)=>{seen=request;return new Response(await request.text(),{status:202,statusText:"Extension",headers:{"cache-control":"private,max-age=10","x-path":ctx.path}});}}};
  const facets=extensionOptions([{id:"audit",declaration:JSON.stringify(declaration),public:declaration,source:false,settings:[],actions:[]}],{},[ext]);
  const f=fixture(facets.routes);
  const request=new Request("https://app.test/admin/api/x/audit/api/deep/more",{method:"PATCH",body:"not json",headers:{origin:"https://app.test"}});
  const response=await f.fetch(request,{});expect(seen).toBe(request);expect(await response?.text()).toBe("not json");expect(response?.headers.get("x-path")).toBe("deep/more");expect(response?.statusText).toBe("Extension");expect(response?.headers.get("cache-control")).toBe("private,max-age=10");expect(f.resolves()).toBe(1);
  const before=f.providers();expect((await f.ask("/x/audit/api/","PATCH","raw",{"content-length":"2000001"}))?.status).toBe(400);expect(f.providers()).toBe(before);
});
test("raw extension APIs keep the database lazy until the handler touches it",async()=>{
  const declaration={apiVersion:1 as const,id:"lazy",title:"Lazy",contributes:{}};
  const ext={...declaration,handlers:{api:async(request:Request,ctx:any)=>new Response(new URL(request.url).searchParams.has("db")?String(ctx.db&&ctx.extension):ctx.extension+":"+ctx.path)}};
  const facets=extensionOptions([{id:"lazy",declaration:JSON.stringify(declaration),public:declaration,source:false,settings:[],actions:[]}],{},[ext]);
  const f=fixture(facets.routes);
  expect(await (await f.ask("/x/lazy/api/a/b"))?.text()).toBe("lazy:a/b");expect(f.providers()).toBe(0);
  expect(await (await f.ask("/x/lazy/api/a?db=1"))?.text()).toBe("lazy");expect(f.providers()).toBe(1);
});
test("generated Procedure callbacks retain native OCC locks, reject system fields and reuse RETURNING row",async()=>{
  const row={id:"a",version:"9007199254740993",created_at:"2026-01-01T00:00:00Z",updated_at:"2026-01-01T00:00:00Z",title:"old"};let reads=0,writes=0,lock:unknown;
  const schema:EntrySchema={binding:compiled,name:"posts",descriptor:{name:"posts"},publishing:false,readOnly:false,fields:{title:"title"},defaults:{},query:()=>({input:{},order:"id:asc"}),validate:d=>d,values:d=>d,row:r=>r};

  const adapter:NativeProcedureAdapter<{}>={...unused,read:()=>{reads++;return [row];},procedure:async(_db,steps)=>{writes++;lock=steps[0]!.binds[1];return [[{...row,title:steps[0]!.binds[2],version:"9007199254740994"}]];}};
  const f=fixture(entries([schema],adapter));
  const response=await f.ask("/entries/a?collection=POSTS","PATCH",JSON.stringify({expectedVersion:row.version,data:{title:"new"}}));expect(response?.status).toBe(200);expect(lock).toBe(row.version);expect([reads,writes]).toEqual([1,1]);expect((await response?.json()).entry.data.title).toBe("new");
  expect((await f.ask("/entries/a?collection=posts","PATCH",JSON.stringify({expectedVersion:1,data:{title:"new"}})))?.status).toBe(409);expect(writes).toBe(1);
  expect((await f.ask("/entries","POST",JSON.stringify({collection:"posts",data:{version:1}})))?.status).toBe(400);
});

test("creation statistics validates primary collection and presets before storage and preserves v0.1 bucket DTO",async()=>{
  const args:any[]=[];
  const schema:EntrySchema={binding:compiled,name:"posts",primary:true,publishing:false,readOnly:false,descriptor:{name:"posts"},fields:{},defaults:{},query:()=>({input:{},order:"id:asc"}),row:r=>r,values:d=>d,validate:d=>d};
  const adapter:NativeProcedureAdapter<{}>={...unused,read:(_db,_sql,values)=>{const [from,to,bucketMs]=values.map(value=>Number(value)/1000);args.push({from,to,bucketMs});return [{bucket:-1,subtype:null,count:9},{bucket:0,subtype:null,count:2}];}};
  const child={...schema,name:"children",primary:false};const f=fixture(entries([schema,child],adapter));
  for(const path of ["/collections/posts/statistics?range=all","/collections/posts/statistics?range=toString","/collections/posts/statistics?range=__proto__"]){expect((await f.ask(path))?.status).toBe(400);}
  for(const path of ["/collections/missing/statistics","/collections/children/statistics"]){expect((await f.ask(path))?.status).toBe(404);}expect(f.providers()).toBe(0);expect(args).toHaveLength(0);
  for(const [range,duration,bucketMs]of[["1h",3600000,300000],["24h",86400000,3600000],["7d",604800000,21600000],["20d",1728000000,86400000]]as const){const response=await f.ask(`/collections/posts/statistics?range=${range}`),data=await response!.json();expect(data.to-data.from).toBe(duration);expect(data.bucketMs).toBe(bucketMs);expect(data.total).toBe(9);expect(data.buckets).toEqual([{bucket:0,subtype:null,count:2}]);expect(response?.headers.get("cache-control")).toBe("private, no-store");}
  expect(f.providers()).toBe(4);expect(args).toHaveLength(4);expect((await(await f.ask("/site"))?.json()).capabilities.statistics).toBe(true);
});


test("extension record action versions remain safe optional numbers before providers",async()=>{
  let dispatches=0;
  const declaration={apiVersion:1 as const,id:"versions",title:"Versions",contributes:{}};
  const facets=extensionOptions([{id:"versions",declaration:JSON.stringify(declaration),public:declaration,source:false,settings:[],actions:[{id:"echo",target:"record/v1",schema:["notes"]}]}],{},[{...declaration,handlers:{actions:{echo:{run:(_caller,input,ctx)=>{dispatches++;void ctx.db;return input.record;}}}}}]);
  const f=fixture(facets.routes);
  for(const version of [Number.MAX_SAFE_INTEGER+1,"9007199254740993","1",1.5]){
    const response=await f.ask("/x/versions/actions/echo","POST",JSON.stringify({record:{schema:"notes",id:"one",version}}));
    expect(response?.status).toBe(400);expect(f.providers()).toBe(0);expect(dispatches).toBe(0);
  }
  for(const version of [undefined,0,-1,1,2,Number.MAX_SAFE_INTEGER]){
    const record={schema:"notes",id:"one",...(version===undefined?{}:{version})};
    const response=await f.ask("/x/versions/actions/echo","POST",JSON.stringify({record}));
    expect(response?.status).toBe(200);expect((await response!.json()).result).toEqual(record);
  }
  expect(f.providers()).toBe(6);expect(dispatches).toBe(6);
});

test("developer View preview preserves caller and permission gates without acquiring DB for unavailable Views",async()=>{
  let providers=0,reads=0;
  const view={name:"public-owned",allows:(c:Caller)=>c.kind==="user"&&c.subject==="a",query:()=>({input:{},limit:20}),page:async(_db:{},c:Caller)=>{expect(c).toBe(admin);reads++;return {rows:[{id:"own"}]};}};
  const fetch=adminFunction({...metadata,developerConsole:{}},[],[],{developerViews:[view],db:()=>{providers++;return {};},caller:()=>admin});
  const ask=(path:string,method="GET")=>fetch(new Request("https://app.test/admin/api"+path,{method,headers:{origin:"https://app.test"}}),{});
  expect(await(await ask("/developer/views/public-owned"))!.json()).toEqual({rows:[{id:"own"}]});expect([providers,reads]).toEqual([1,1]);
  expect(await(await ask("/developer/views/internal"))!.json()).toEqual({unavailable:true});expect(providers).toBe(1);
  const denied=adminFunction({...metadata,developerConsole:{}},[],[],{developerViews:[{...view,allows:()=>false}],db:()=>{throw Error("unauthorized DB acquisition");},caller:()=>admin});
  expect(await(await denied(new Request("https://app.test/admin/api/developer/views/public-owned"),{}))!.json()).toEqual({unavailable:true});
  for(const path of ["/views/public-owned","/views/public-owned/export"])expect((await ask(path))!.status).toBe(404);
  expect(providers).toBe(1);
  expect(await(await ask("/views-manifest"))!.json()).toEqual({views:[]});
  expect((await ask("/developer/views/public-owned","POST"))!.status).toBe(405);
  const withoutConsole=fixture();expect((await withoutConsole.ask("/developer/views/public-owned"))!.status).toBe(404);
});

test("collection CSV preserves system timestamps as UTC ISO strings instead of UI milliseconds",async()=>{
  for(const timestamp of ["2026-10-13T00:00:00.000001Z",null]){
    const schema:EntrySchema={binding:compiled,name:"posts",descriptor:{name:"posts"},publishing:false,readOnly:false,fields:{title:"title"},defaults:{},query:()=>({input:{},order:"id:asc"}),validate:d=>d,values:d=>d,row:r=>r};
    const adapter:NativeProcedureAdapter<{}>={...unused,read:()=>[{id:"a",version:1,title:"Hello",updated_at:timestamp}]};
    const f=fixture(entries([schema],adapter)),text=await(await f.ask("/entries/export?collection=posts"))!.text();
    expect(text).toContain("updated_at");
    if(timestamp!==null)expect(text).toContain(timestamp);
    expect(text).not.toContain("1791849600000");
  }
});
