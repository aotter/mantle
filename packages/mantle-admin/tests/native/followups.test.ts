import {expect,test} from "bun:test";
import {Database} from "bun:sqlite";
import {readFile,mkdtemp,rm} from "node:fs/promises";
import {join} from "node:path";
import {admin as createAdmin} from "../../src/server/index.js";
import {entries} from "../../src/server/entries.js";
import {csv} from "../../src/server/csv.js";
import {nativeStatistics,type NativeCollection} from "../../src/server/native.js";
import {generateAdmin,writeAdminFixture} from "./generated-fixture.js";
import {admin} from "./server-native-scenarios.js";

test("CSV streams pages, quotes formulas, propagates failures and stops after cancel",async()=>{
 let reads=0;
 const response=await csv("people",async cursor=>{reads++;return cursor?{rows:[{id:2,name:'Ada, "Lovelace"'}]}:{rows:[{id:1,name:"=formula"}],nextCursor:"next"};});
 expect(response.headers.get("content-type")).toContain("text/csv");
 expect(reads).toBe(1);
 expect(await response.text()).toBe('id,name\r\n1,\'=formula\r\n2,"Ada, ""Lovelace"""\r\n');
 expect(reads).toBe(2);
 const broken=await csv("people",async cursor=>{if(cursor)throw Error("lost DB");return {rows:[],nextCursor:"next"};});
 await expect(broken.text()).rejects.toThrow("lost DB");
 await expect(csv("people",async()=>{throw Error("bad query");})).rejects.toThrow("bad query");
 reads=0;
 const cancelled=await csv("people",async()=>{reads++;return {rows:[{id:1}],nextCursor:"next"};});
 await cancelled.body!.cancel(); expect(reads).toBe(1);
});

test("PostgreSQL statistics split aggregates without another round trip and use native timestamp ranges",async()=>{
 const queries:{sql:string;values:unknown[]}[]=[];
 const mode={from:'FROM "posts"',projection:'*',binds:[{k:"uid" as const}],policy:'"owner" = $1'};
 const spec={caller:mode,statistics:{time:'extract(epoch FROM "posts"."created_at") * 1000000',column:'"posts"."created_at"',subtype:'NULL',rowsAlias:{name:"unused",sql:"unused"}}} as unknown as NativeCollection;
 const result=await nativeStatistics({posts:spec},{sqlite:false,param:n=>"$"+n,values:{},escapeLike:s=>s,read:(_db,sql,values)=>{queries.push({sql,values});return [{bucket:-1,subtype:null,count:12},{bucket:0,subtype:null,count:3}];}},null,admin,"posts",{from:1000,to:2000,bucketMs:1000});
 expect(result).toEqual({total:12,buckets:[{bucket:0,subtype:null,count:3}]});
 expect(queries).toHaveLength(1);
 expect(queries[0]!.sql).toContain('SELECT -1 AS bucket, NULL AS subtype, count(*) AS count FROM "posts" WHERE ("owner" = $1) UNION ALL SELECT');
 expect(queries[0]!.sql).toContain('"posts"."created_at" >= $2 AND "posts"."created_at" < $3');
 expect(queries[0]!.sql).not.toContain("WITH");
 expect(queries[0]!.values).toEqual([admin.subject,"1970-01-01T00:00:01.000Z","1970-01-01T00:00:02.000Z",1000000]);
});

test("native list/editor/bootstrap and exports share a single admin resolution and generated policies",async()=>{
 const manifest=await readFile(join(import.meta.dir,"../../../mantle/tests/apps/translations.yaml"),"utf8");
 const files=await generateAdmin("bun-sqlite",manifest),dir=await mkdtemp(join(import.meta.dir,"../../../mantle/tests/apps/.admin-followups-")),db=new Database(":memory:");
 try{
  await writeAdminFixture(dir,files); db.exec(files["schema.sql"]!);
  expect(files["schema.sql"]).toContain('_mantle_admin_posts_created_at');
  const {adminBindings}=await import(join(dir,"admin-bindings.ts")),bindings=adminBindings();
  let resolves=0, queries=0;
  const adapter={...bindings.adapter,read:(...args: any[])=>{queries++;return bindings.adapter.read(...args);}};
  const fetch=createAdmin(bindings.metadata,bindings.views,bindings.operations,{db:()=>db,caller:()=>{resolves++;return admin;},routes:entries(bindings.schemas,adapter)});
  const ask=async(path:string,method="GET",input?:unknown)=>{const response=(await fetch(new Request("https://app.test/admin/api"+path,{method,headers:{origin:"https://app.test"},body:input===undefined?undefined:JSON.stringify(input)}),{}))!;expect(response.status).toBe(200);return response;};
  const parent=(await(await ask("/entries","POST",{collection:"posts",data:{slug:"same",title:"Parent",cover:"Cover"}})).json()).entry;
  const child=(await(await ask("/entries","POST",{collection:"translations",data:{slug:"same",locale:"fr",title:"French"}})).json()).entry;
  let before=resolves; queries=0;
  const editor=await(await ask(`/entries/${parent.id}?collection=posts`)).json();
  expect(resolves-before).toBe(1); expect(queries).toBe(2); expect(editor.related[0].entries[0].id).toBe(child.id);
  before=resolves; queries=0;
  const translated=await(await ask(`/entries/${child.id}?collection=translations`)).json();
  expect(resolves-before).toBe(1); expect(queries).toBe(3); expect(translated.parentEntryId).toBe(parent.id);
  before=resolves; queries=0;
  const bootstrap=await(await ask("/bootstrap?collection=posts")).json();
  expect(resolves-before).toBe(1);expect(queries).toBe(2);expect(bootstrap.entries.items[0]).toMatchObject({id:parent.id,title:"Parent",translation_locales:["fr"]});
  expect(await(await ask("/entries/export?collection=posts")).text()).toContain("Parent");
  const stats=await(await ask("/collections/posts/statistics")).json();expect(stats.total).toBe(1);
  expect(db.query('EXPLAIN QUERY PLAN SELECT count(*) FROM posts WHERE created_at >= ? AND created_at < ?').all(0,Date.now()*1000).some((row:any)=>String(row.detail).includes('_mantle_admin_posts_created_at'))).toBe(true);
 }finally{db.close();await rm(dir,{recursive:true,force:true});}
},30000);

test("resolved session supplies current menu display fields without a separate Admin profile query",async()=>{
 const {authLoader,resolveCaller}=await import("@aotter/mantle/auth");
 let reads=0,profiles=0,providers=0;
 const auth=authLoader(async()=>({options:{plugins:[{id:"admin"}]},$context:Promise.resolve({internalAdapter:{findUserById:async()=>{profiles++;return {id:"admin",role:"admin",name:"Ada",image:"/avatar.png",githubLogin:"ada"};}}}),api:{getSession:async()=>{reads++;return {headers:null,response:{session:{id:"session"},user:{id:"admin",role:"admin",name:"Ada",image:"/avatar.png",githubLogin:"ada"}}};}}}));
 const request=new Request("https://app.test/admin/api/me",{headers:{cookie:"better-auth.session_token=value"}});
 const caller=await resolveCaller(request,auth);
 const fetch=createAdmin({collections:[],views:[],operations:[],webmcp:{tools:[]}},[],[],{db:()=>{providers++;return null;},caller:()=>caller});
 expect(await(await fetch(request,{}))!.json()).toMatchObject({login:"ada",image:"/avatar.png"});
 expect(reads).toBe(1);expect(profiles).toBe(1);expect(providers).toBe(0);
});

test("generated extension metadata binds declarations and compiled settings checks",async()=>{
 const {generateFromSources}=await import("../../../mantle/src/infrastructure/generate.js");
 const declaration={apiVersion:1 as const,id:"preferences",title:"Preferences",contributes:{settings:[{id:"theme",title:"Theme",role:"admin" as const,schema:{type:"object" as const,properties:{accent:{type:"string" as const,enum:["blue","green"]},"choice/path":{type:"integer" as const,oneOf:[{const:1},{const:2}]}},required:["accent"]}}]}};
 const result=await generateFromSources({target:"bun-sqlite",admin:true,sources:{sources:[]},adminExtensions:[declaration]});
 expect(result.ok).toBe(true);if(!result.ok)throw Error(JSON.stringify(result.diagnostics));
 const dir=await mkdtemp(join(import.meta.dir,"../../../mantle/tests/apps/.admin-extension-followups-"));
 try{
  await writeAdminFixture(dir,result.files);
  const {extensionBindings}=await import(join(dir,"admin-extensions.ts"));
  let saves=0;
  const definition={...declaration,handlers:{settings:{theme:{load:async()=>({accent:"blue"}),save:async(_caller:unknown,value:unknown)=>{saves++;return value;}}}}};
  const facets=extensionBindings([definition]);
  expect(()=>extensionBindings([{...definition,title:"Drift"}])).toThrow("differs from generation");
  const fetch=createAdmin({collections:[],views:[],operations:[],webmcp:{tools:[]}},[],[],{db:()=>null,caller:()=>admin,...facets});
  const ask=(accent:string,choice=1)=>fetch(new Request("https://app.test/admin/api/x/preferences/settings/theme",{method:"PATCH",headers:{origin:"https://app.test"},body:JSON.stringify({value:{accent,"choice/path":choice}})}),{});
  expect((await ask("red"))!.status).toBe(400);expect(saves).toBe(0);
  const invalid=(await ask("green",3))!;expect(invalid.status).toBe(400);expect((await invalid.json()).error.fields["choice/path"]).toContain("enum");
  expect((await ask("green"))!.status).toBe(200);expect(saves).toBe(1);
  const source=await generateFromSources({target:"bun-sqlite",admin:true,sources:{sources:[]},adminExtensions:[{...declaration,source:"export default {}"}]});
  expect(source.ok).toBe(false);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test("WebMCP localizes declarations and View export validates before streaming",async()=>{
 let reads=0;
 const metadata={collections:[],operations:[],views:[{name:"people",list:{columns:["name"]}}],webmcp:{tools:[{name:"people",description:{en:"People","zh-TW":"人員"},title:{en:"Admin","zh-TW":"團隊"}}]}};
 const fetch=createAdmin(metadata,[{name:"people",allows:()=>true,query:()=>({input:{}}),page:async(_db,_caller,_input,paging)=>{reads++;expect(paging.limit).toBe(500);return paging.cursor?{rows:[{name:"Grace",secret:"hidden"}]}:{rows:[{name:"Ada",secret:"hidden"}],nextCursor:"second"};}}],[],{db:()=>null,caller:()=>admin,locale:"zh-TW"});
 const ask=(path:string)=>fetch(new Request("https://app.test/admin/api"+path),{});
 expect((await(await ask("/webmcp"))!.json()).tools[0]).toMatchObject({description:"人員",title:"團隊"});
 const response=(await ask("/views/people/export"))!;
 expect(await response.text()).toBe("name\r\nAda\r\nGrace\r\n");expect(reads).toBe(2);
});

test("handler-less WebMCP dispatch accepts omitted and undefined handlers", async () => {
 const {webmcpRoutes}=await import("../../src/server/webmcp.js");
 const tools: import("@aotter/mantle/mcp").Tool<null>[]=[{name:"plain",surface:"admin",description:"Plain SQL",inputSchema:{},validate:raw=>raw as Record<string,unknown>,run:async()=>({results:[[{reqStatus:"submitted"}]]})}];
 for(const routes of [webmcpRoutes({tools:[{name:"plain"}]},tools),webmcpRoutes({tools:[{name:"plain"}]},tools,undefined)]) {
  const ask=createAdmin({collections:[],views:[],operations:[],webmcp:{tools:[]}},[],[],{db:()=>null,caller:()=>admin,routes});
  const response=await ask(new Request("https://example.test/admin/api/webmcp/plain",{method:"POST",headers:{origin:"https://example.test","content-type":"application/json"},body:"{}"}),{});
  expect(response?.status).toBe(200);
  expect(await response!.json()).toEqual({output:{results:[[{reqStatus:"submitted"}]]}});
 }
});

test("WebMCP ref tools require handlers with inferred and explicit type arguments", async () => {
 const ts = (await import("typescript")).default;
 const {writeFile} = await import("node:fs/promises");
 const dir = await mkdtemp(join(import.meta.dir,".webmcp-types-")), file = join(dir,"consumer.ts");
 try {
  await writeFile(file, `import {webmcpRoutes} from "../../../dist/server/webmcp.js";
import type {Tool} from "@aotter/mantle/mcp";
declare const plain: readonly Tool<null>[];
type Handlers = {save: () => Promise<void>};
declare const refs: readonly Tool<null, Handlers>[];
declare const handlers: Handlers;
const catalogue = {tools: []};
webmcpRoutes(catalogue, plain);
webmcpRoutes(catalogue, plain, undefined);
webmcpRoutes(catalogue, refs, handlers);
webmcpRoutes<unknown, null, Handlers>(catalogue, refs, handlers);
// @ts-expect-error ref handlers cannot be omitted
webmcpRoutes(catalogue, refs);
// @ts-expect-error ref handlers cannot be undefined
webmcpRoutes(catalogue, refs, undefined);
// @ts-expect-error partial type arguments cannot erase ref handler requirements
webmcpRoutes<unknown, null>(catalogue, refs);
`);
  const program = ts.createProgram([file], {strict:true,noEmit:true,target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.NodeNext,moduleResolution:ts.ModuleResolutionKind.NodeNext,skipLibCheck:true,types:[]});
  expect(ts.getPreEmitDiagnostics(program).map(d => ts.flattenDiagnosticMessageText(d.messageText," ")).join("\n")).toBe("");
 } finally {await rm(dir,{recursive:true,force:true});}
});
