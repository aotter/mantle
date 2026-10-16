import { sdkFixtureCaller as fixtureCaller } from "../../../mantle/tests/apps/fixtures.js";
import {test, expect} from "bun:test";
import { admin as adminFunction, type Route, type Metadata} from "../../src/server/index.js";
import {entries, type EntrySchema} from "../../src/server/entries.js";
import {ContractError, type Caller, type Target} from "@aotter/mantle/contracts";
import type {NativeCollection,NativeProcedureAdapter} from "../../src/server/native.js";
const mode={projection:"id, version, title",from:"FROM fixture",policy:"",binds:[],fields:{title:{column:"title",insert:"@value",update:"title=@value"}},create:{prefix:"create(",between:")(",suffix:")",columns:[],values:[],binds:[],returning:""},patch:{prefix:"patch ",sets:[],where:"",returning:"",binds:[{k:"input" as const,name:"id"},{k:"version" as const}]},remove:{sql:"remove",binds:[{k:"input" as const,name:"id"},{k:"version" as const}],row:true}};
const compiled:NativeCollection={path:"admin/entries",marker:"@value",id:"id",cursorAliases:[{name:"_cursor0",sql:"_cursor0"},{name:"_cursor1",sql:"_cursor1"}],fields:{id:{expression:"id",value:"@value",wire:"id",kind:"text",nullable:false}},orderFields:["id"],caller:mode,trusted:mode,statistics:{time:"created_at",subtype:"NULL",rowsAlias:{name:"_statistics",sql:"_statistics"}}};
const unused:NativeProcedureAdapter<{}>={sqlite:true,values:{},param:n=>"?"+n,escapeLike:value=>value,read:()=>{throw Error("unexpected read");},procedure:async()=>{throw Error("unexpected write");}};
const admin: Caller=fixtureCaller({kind:"user",subject:"a",role:"admin", admin: true,scopes:[],credential:"session",credentialId:null,clientId:null});
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
  f.caller(fixtureCaller({...admin,kind:"user",credential:"api-key"}));expect((await f.ask("/save","PATCH","{}"))?.status).toBe(403);
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
test("a refused Admin request leaves no unread body for the next request",async()=>{
  const f=fixture([{method:"PATCH",path:"/save",run:c=>c.input}]);
  const refused=async(status:number,method="PATCH",path="/save",headers:Record<string,string>={})=>{
    const request=new Request("https://app.test/admin/api"+path,{method,body:"x".repeat(2048),headers:{origin:"https://app.test",...headers}});
    expect((await f.fetch(request,{}))?.status).toBe(status);expect(request.bodyUsed).toBe(true);
  };
  f.caller({kind:"anonymous"});await refused(401);
  f.caller(fixtureCaller({...admin,kind:"user",credential:"api-key"}));await refused(403);
  f.caller(admin);await refused(403,"PATCH","/save",{origin:"https://foreign.test"});await refused(405,"POST");await refused(404,"POST","/nowhere");
});
test("empty Schema declarations emit no entry routes and bootstrap does no row queries",async()=>{
  expect(entries([],unused)).toEqual([]);
  const f=fixture();const result=await(await f.ask("/bootstrap"))?.json();expect(result.collections).toEqual([]);expect(result.webmcp).toEqual({tools:[],routes:{}});expect(result).not.toHaveProperty("entries");expect((await f.ask("/entries"))?.status).toBe(404);
});
test("site info carries no extension or navGroups fields",async()=>{
  const f=fixture();
  const site=await(await f.ask("/site"))?.json();
  expect(site).toMatchObject({capabilities:expect.any(Object)});for(const removed of ["extensions","navGroups"])expect(site).not.toHaveProperty(removed);
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

test("Admin target authorization covers Views, Procedures and every generic entry action before storage",async()=>{
  const {spyOn}=await import("bun:test");
  type Authorize=import("@aotter/mantle/contracts").Authorize;
  type Target=import("@aotter/mantle/contracts").Target;
  const cases: readonly [Authorize|undefined,number][]=[[undefined,200],[()=>true,200],[async()=>true,200],[()=>false,403],[async()=>false,403],[()=>Promise.reject(Error("denied")),403],[()=>{throw Error("broken");},500]];
  const row={id:"a",version:1,title:"Old",created_at:0,updated_at:0};
  const schema:EntrySchema={binding:compiled,name:"posts",primary:true,descriptor:{name:"posts"},publishing:false,readOnly:false,fields:{title:"title"},defaults:{},query:()=>({input:{},order:"id:asc"}),validate:d=>d,values:d=>d,row:r=>r};
  const routes: readonly [string,string,object|undefined,Target][]=[
    ["/views/recent","GET",undefined,{kind:"view",name:"recent"}],
    ["/views/recent/export","GET",undefined,{kind:"view",name:"recent"}],
    ["/developer/views/recent","GET",undefined,{kind:"view",name:"recent"}],
    ["/operations/edit","POST",{},{kind:"procedure",name:"edit"}],
    ["/entries?collection=POSTS","GET",undefined,{kind:"schema",name:"posts",action:"read"}],
    ["/entries/a?collection=posts","GET",undefined,{kind:"schema",name:"posts",action:"read"}],
    ["/entries/export?collection=posts","GET",undefined,{kind:"schema",name:"posts",action:"read"}],
    ["/entries","POST",{collection:"POSTS",data:{title:"New"}},{kind:"schema",name:"posts",action:"create"}],
    ["/entries/a?collection=posts","PATCH",{expectedVersion:1,data:{title:"New"}},{kind:"schema",name:"posts",action:"update"}],
    ["/entries/a?collection=posts","DELETE",undefined,{kind:"schema",name:"posts",action:"delete"}],
    ["/collections/posts/statistics","GET",undefined,{kind:"schema",name:"posts",action:"read"}],
  ];
  const log=spyOn(console,"error").mockImplementation(()=>{});
  try {
    for(const [authorize,status] of cases)for(const [path,method,input,target]of routes){
      let providers=0,sql=0,handlers=0,authorizations=0;
      const adapter:NativeProcedureAdapter<{}>={...unused,read:()=>{sql++;return [row];},procedure:async()=>{sql++;return [[row]];}};
      const view={name:"recent",allows:()=>true,query:()=>({input:{}}),page:async()=>{handlers++;return {rows:[row]};}};
      const operation={name:"edit",allows:()=>true,validate:(r:unknown)=>r as Record<string,unknown>,run:async()=>{handlers++;return {ok:true};}};
      const fetch=adminFunction({...metadata,developerConsole:{}},[view],[operation],{db:()=>{providers++;return {};},caller:()=>admin,developerViews:[view],routes:entries([schema],adapter),...(authorize?{authorize:(t:Target,c:Caller)=>{if(++authorizations===1)expect(t).toEqual(target);else expect(t).toEqual({kind:"schema",name:"posts",action:"read"});expect(c).toBe(admin);return authorize(t,c);}}:{})});
      const response=await fetch(new Request("https://app.test/admin/api"+path,{method,body:input?JSON.stringify(input):undefined,headers:{origin:"https://app.test"}}),{});
      expect(response?.status).toBe(status);await response?.text();
      if(status!==200){expect([providers,sql,handlers]).toEqual([0,0,0]);}
      else {expect(providers).toBeGreaterThan(0);expect(sql+handlers).toBeGreaterThan(0);}
      // the route's target first; a returned entry also needs its read
      if(authorize)expect(authorizations).toBeGreaterThanOrEqual(1);else expect(authorizations).toBe(0);
    }
    let authorizations=0;
    const fetch=adminFunction(metadata,[{name:"closed",allows:()=>false,query:()=>{throw Error("query before requires");},page:async()=>{throw Error("SQL before requires");}}],[{name:"closed",allows:()=>false,validate:()=>({}),run:async()=>{throw Error("handler before requires");}}],{db:()=>{throw Error("provider before requires");},caller:()=>admin,authorize:()=>{authorizations++;return true;}});
    for(const [path,method]of[["/views/closed","GET"],["/operations/closed","POST"]])expect((await fetch(new Request("https://app.test/admin/api"+path,{method,headers:{origin:"https://app.test"},body:method==="POST"?"{}":undefined}),{}))?.status).toBe(403);
    expect(authorizations).toBe(0);
  }finally{log.mockRestore();}
});

test("Admin navigation, bootstrap and developer metadata hide unauthorized targets",async()=>{
  type Target=import("@aotter/mantle/contracts").Target;
  const collections=[{name:"visible"},{name:"hidden"}];
  const views=collections.map(d=>({...d,allows:()=>true,query:()=>({input:{}}),page:async()=>{throw Error("metadata SQL");}}));
  const operations=collections.map(d=>({...d,allows:()=>true,validate:()=>({}),run:async()=>{throw Error("metadata handler");}}));
  const tools=collections.map(d=>({name:d.name,target:{kind:"view",name:d.name},description:d.name}));
  const data:Metadata={collections,allCollections:Object.fromEntries(collections.map(d=>[d.name,d])),views:collections,operations:collections,webmcp:{tools,routes:{visible:{path:"visible"},hidden:{path:"hidden"}}},developerConsole:{dataModel:{schemas:collections,views:collections},logic:{procedures:collections,triggers:[]},interfaces:{callable:tools.map(t=>({...t,kind:"view",target:t.name})),http:[]},graph:{atoms:[],relations:[]},operations:{schedules:[],ttlPolicies:[]}}};
  const seen:Target[]=[];
  const fetch=adminFunction(data,views,operations,{db:()=>{throw Error("metadata provider");},caller:()=>admin,authorize:async target=>{seen.push(target);return target.name==="visible";}});
  const ask=async(path:string)=>{const response=await fetch(new Request("https://app.test/admin/api"+path),{});expect(response?.status).toBe(200);return response!.json();};
  const bootstrap=await ask("/bootstrap");
  expect(bootstrap.collections).toEqual([{name:"visible"}]);expect(Object.keys(bootstrap.allCollections)).toEqual(["visible"]);
  expect(bootstrap.views).toEqual([{name:"visible"}]);expect(bootstrap.operations).toEqual([{name:"visible"}]);
  expect(bootstrap.webmcp.tools.map((t:{name:string})=>t.name)).toEqual(["visible"]);expect(Object.keys(bootstrap.webmcp.routes)).toEqual(["visible"]);
  expect((await ask("/collections")).collections).toEqual(bootstrap.collections);expect((await ask("/views-manifest")).views).toEqual(bootstrap.views);expect((await ask("/operations")).operations).toEqual(bootstrap.operations);expect((await ask("/webmcp")).tools).toEqual(bootstrap.webmcp.tools);
  const developer=await ask("/developer-console");expect(developer.dataModel.schemas).toEqual([{name:"visible"}]);expect(developer.dataModel.views).toEqual([{name:"visible"}]);expect(developer.logic.procedures).toEqual([{name:"visible"}]);
  expect(seen.some(t=>t.kind==="schema"&&t.action==="read")).toBe(true);
  const omitted=adminFunction(data,views,operations,{db:()=>{throw Error("metadata provider");},caller:()=>admin});
  expect((await(await omitted(new Request("https://app.test/admin/api/collections"),{}))!.json()).collections).toEqual(collections);
});

test("entry editor and translation badges do not query denied related collections",async()=>{
  let reads=0;
  const row={id:"a",version:1,title:"A",created_at:0,updated_at:0};
  const schema:EntrySchema={binding:compiled,name:"posts",descriptor:{name:"posts",parent:{collection:"hidden",parentField:"id",childField:"id"}},publishing:false,readOnly:false,fields:{title:"title"},defaults:{},query:()=>({input:{},order:"id:asc"}),validate:d=>d,values:d=>d,row:r=>r};
  const hidden={...schema,name:"hidden",descriptor:{name:"hidden",localized:true,translates:{parent:"posts",on:"id"}}};
  const adapter:NativeProcedureAdapter<{}>={...unused,read:()=>{reads++;return [row];}};
  const fetch=adminFunction(metadata,[],[],{db:()=>({}),caller:()=>admin,routes:entries([schema,hidden],adapter),authorize:target=>target.name!=="hidden"});
  const editor=await(await fetch(new Request("https://app.test/admin/api/entries/a?collection=posts"),{}))!.json();
  expect(editor.parentEntryId).toBeNull();expect(editor.related).toEqual([]);expect(reads).toBe(1);
  const list=await(await fetch(new Request("https://app.test/admin/api/entries?collection=posts"),{}))!.json();
  expect(list.items[0].translation_locales).toEqual([]);expect(reads).toBe(2);
});

test("view-batch runs each View as the caller; a refused, missing or authorize-denied View is the same unavailable and cannot fail the batch",async()=>{
  const seen:string[]=[];
  const view=(name:string,allows:(c:Caller)=>boolean,rows:Record<string,unknown>[]=[{count:3}]):any=>({name,allows,query:(p:URLSearchParams)=>({input:{},limit:Number(p.get("limit"))}),page:async(_db:unknown,c:Caller,_i:unknown,paging:{limit?:number})=>{seen.push(`${name}:${"subject" in c?c.subject:""}:${paging.limit}`);return {rows};},row:(r:Record<string,unknown>)=>({...r,count:Number(r.count)})});
  const needsInput:any={...view("needs-input",()=>true),query:()=>{throw new ContractError("INPUT_VALIDATION_FAILED","Needs input.","views/needs-input");}};
  // a refused View whose user binding would throw must still read as unavailable, never as an error
  const refusedBound:any={...view("refused-bound",()=>false),check:()=>{throw new ContractError("HOST_CONTRACT","The target needs user field 'dept'.","",{status:412});}};
  const views=[view("pending-count",()=>true,[{count:"3"}]),view("admins-only",()=>false),refusedBound,view("blocked",()=>true),needsInput];
  const authorize:any=async(target:{name:string})=>target.name!=="blocked";
  const build=(extra={})=>{let providers=0;const f=adminFunction(metadata,views,[],{db:()=>{providers++;return {};},caller:()=>admin,...extra});return {providers:()=>providers,ask:(names:string)=>f(new Request("https://app.test/admin/api/view-batch"+names,{headers:{origin:"https://app.test"}}),{})};};
  const f=build(),res=await f.ask("?names=pending-count,admins-only,nope,needs-input,pending-count");
  expect(res!.status).toBe(200);expect(res!.headers.get("cache-control")).toBe("private, no-store");
  const body=await res!.json();
  expect(body).toEqual({views:{"pending-count":{rows:[{count:3}]},"admins-only":{unavailable:true},nope:{unavailable:true},"needs-input":{error:true}}});
  // one read per named View, one row each, as the caller
  expect(seen).toEqual(["pending-count:a:1"]);
  expect(JSON.stringify(body.views["admins-only"])).toBe(JSON.stringify(body.views.nope));
  expect((await (await build().ask("?names=refused-bound,nope"))!.json()).views).toEqual({"refused-bound":{unavailable:true},nope:{unavailable:true}});
  const denied=await build({authorize}).ask("?names=blocked,pending-count");
  expect(await denied!.json()).toEqual({views:{blocked:{unavailable:true},"pending-count":{rows:[{count:3}]}}});
  const many=build();
  for(const names of ["","?names=","?names="+Array.from({length:21},(_,i)=>"v"+i).join(",")])expect((await many.ask(names))!.status).toBe(400);
  expect(many.providers()).toBe(0);
  expect((await many.ask("?names="+Array.from({length:20},(_,i)=>"v"+i).join(",")))!.status).toBe(200);
});
test("reference titles resolve as the caller with one query per referenced collection; missing, deleted and denied targets look alike",async()=>{
  const customers=[{id:"c1",version:1,name:"Acme",created_at:0,updated_at:0}],orders=[{id:"o1",version:1,customer:"c1",created_at:0,updated_at:0},{id:"o2",version:1,customer:"c1",created_at:0,updated_at:0},{id:"o3",version:1,customer:"gone",created_at:0,updated_at:0}];
  let reads:string[]=[];
  const query=(params:URLSearchParams)=>{const ids=params.get("filter_values");return {input:{},order:"id:asc",...(ids?{match:{filters:{id:{in:JSON.parse(ids)}}}}:{})};};
  const base={binding:compiled,publishing:false,readOnly:false,fields:{},defaults:{},query,validate:(d:any)=>d,values:(d:any)=>d,row:(r:any)=>r};
  const order:EntrySchema={...base,name:"orders",descriptor:{name:"orders",list:{columns:["customer"]},schema:{properties:{customer:{type:"string","x-mantle-ref":"customers"}}}}};
  const customer:EntrySchema={...base,name:"customers",descriptor:{name:"customers",schema:{properties:{name:{type:"string"}},required:["name"]}}};
  const adapter=(found:object[]):NativeProcedureAdapter<{}>=>({...unused,read:(_db,_sql,values)=>{const customersRead=values.some(value=>value==="c1");reads.push(customersRead?"customers":"orders");return customersRead?found:orders;}});
  const ask=async(found:object[],authorize?:(t:Target)=>boolean,path="/entries?collection=orders")=>{reads=[];const fetch=adminFunction(metadata,[],[],{db:()=>({}),caller:()=>admin,routes:entries([order,customer],adapter(found)),...(authorize?{authorize}:{})});return (await fetch(new Request("https://app.test/admin/api"+path),{}))!.json();};
  const resolved=await ask(customers);
  expect(resolved.ref_titles).toEqual({customer:{c1:{collection:"customers",id:"c1",title:"Acme"}}});expect(reads).toEqual(["orders","customers"]);
  const missing=await ask([]),denied=await ask(customers,target=>!(target.kind==="schema"&&target.name==="customers"));
  expect(missing).not.toHaveProperty("ref_titles");expect(denied).toEqual(missing);expect(JSON.stringify(denied)).not.toContain("Acme");
  expect(reads).toEqual(["orders"]);
  const editor=await ask(customers,undefined,"/entries/o1?collection=orders");
  expect(editor.refTitles.customer.c1.title).toBe("Acme");
});
