import {test,expect} from "bun:test";
import {Database} from "bun:sqlite";
import {SQL} from "bun";
import {mkdtemp,rm,writeFile,readFile,open} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {spawn} from "node:child_process";
import {once} from "node:events";
import {generateOrThrow,writeGenerated} from "./apps/link.js";

const atom=(kind:string,name:string,spec:unknown)=>JSON.stringify({apiVersion:"cms.mantle.aotter.net/v2",kind,metadata:{name},spec});
const source=[
  atom("Schema","notes",{title:"Notes",lifecycle:"operational",scope:{owner:"auth.uid()"},indexes:[["owner","id"]],schema:{type:"object",required:["owner","title"],properties:{owner:{type:"string"},title:{type:"string"},active:{type:"boolean",nullable:true},document:{type:"object",nullable:true,additionalProperties:true}}}}),
  atom("Schema","posts",{title:"Posts",lifecycle:"publishing",schema:{type:"object",required:["title"],properties:{title:{type:"string"}}}}),
  ...["staff","public","internal"].map(surface=>atom("View",surface+"-notes",{surface,sql:"SELECT id,title,active,document FROM notes ORDER BY id"})),
  atom("View","restricted-notes",{surface:"staff",requires:{auth:{all:[{"ctx.auth.scope":"restricted"}]}},sql:"SELECT id FROM notes ORDER BY id"}),
  atom("Procedure","edit-note",{requires:{auth:{all:[{"ctx.staff":["staff"]}]}},target:{schema:"notes",id:"id",version:"version"},input:{type:"object",required:["id","title","version"],properties:{id:{type:"string"},title:{type:"string"},version:{type:"integer"}},additionalProperties:false},output:{type:"object"},handler:{sql:"UPDATE notes SET title=input.title WHERE id=input.id AND version=input.version RETURNING id,title"}}),
  atom("Trigger","edit-note-mcp",{source:{kind:"mcp",surface:"staff"},target:{procedure:"edit-note"}}),
  atom("Procedure","read-owned",{requires:{auth:{all:[{"ctx.staff":["staff"]}]}},input:{type:"object",required:["id"],properties:{id:{type:"string"}},additionalProperties:false},output:{type:"object",properties:{title:{type:["string","null"]}},required:["title"]},handler:{ref:"app.readOwned"}}),
  atom("Trigger","read-owned-mcp",{source:{kind:"mcp",surface:"staff"},target:{procedure:"read-owned"}}),
].join("\n---\n");
const staff={kind:"user",subject:"a",role:"staff",scopes:[],credential:"session",credentialId:null,clientId:null};
const seed="INSERT INTO notes(id,version,created_at,updated_at,owner,title,active,document) VALUES ('a',1,0,0,'a','first',1,'{\"nested\":[true,null]}'),('b',1,0,0,'a','second',0,NULL),('other',1,0,0,'b','hidden',1,NULL)";

test("declared oversized Admin writes refuse before providers, retaining auth and origin priority",async()=>{
  const {admin}=await import("../src/kernel/admin.js");let dbCalls=0,siteCalls=0,caller:any=staff;
  const app=admin({collections:[],views:[],operations:[],webmcp:{tools:[],routes:{}}},[],[],{db:()=>{dbCalls++;return{};},caller:()=>caller,site:()=>{siteCalls++;throw Error("oversized request must not construct site");}});
  const request=(origin="https://app.test")=>new Request("https://app.test/admin/api/webmcp/any",{method:"POST",headers:{origin,"content-length":"1000001"},body:"{}"});
  for(const [identity,origin,status] of [[staff,"https://app.test",400],[staff,"https://evil.test",403],[{kind:"anonymous"},"https://app.test",401]] as const){caller=identity;const input=request(origin),response=await app(input,{});expect(response?.status).toBe(status);expect(input.bodyUsed).toBe(false);expect(dbCalls).toBe(0);expect(siteCalls).toBe(0);}
});
async function verify(app:(request:Request)=>Promise<Response>,queries:()=>number){
  const check=(value:unknown,message:string)=>{if(!value)throw Error(message);};
  const req=(path:string,method="GET",value?:unknown,headers:Record<string,string>={})=>app(new Request("https://app.test/admin/api"+path,{method,headers:{...(method==="POST"?{origin:"https://app.test"}:{}),...headers},...(value!==undefined?{body:JSON.stringify(value)}:{})}));
  const catalogue:any=await(await req("/webmcp")).json();
  check(JSON.stringify(catalogue.tools.map((t:any)=>t.name).sort())===JSON.stringify(["edit_note","read_owned","restricted_notes","staff_notes"]),"staff catalogue and 0.2 names");
  check(catalogue.routes.staff_notes.path==="/admin/views/staff-notes"&&catalogue.routes.edit_note.path==="/admin/c/notes"&&catalogue.routes.edit_note.entry===true,"page routes");
  check(JSON.stringify((await(await req("/bootstrap")).json() as any).webmcp)===JSON.stringify(catalogue),"bootstrap catalogue matches");
  let before=queries();const page:any=await(await req("/webmcp/staff_notes","POST",{limit:1})).json();check(queries()===before+1,"one View query");
  check(page.output.rows[0].id==="a"&&page.output.rows[0].active===true&&page.output.rows[0].document.nested[0]===true,"native scoped selected wire");
  const next:any=await(await req("/webmcp/staff_notes","POST",{limit:1,cursor:page.output.nextCursor})).json();check(next.output.rows[0].id==="b"&&!next.output.nextCursor,"bounded paging");
  for(const name of ["public_notes","internal_notes","publish_posts","constructor","toString","__proto__"]){before=queries();check((await req("/webmcp/"+name,"POST",{})).status===404,"unadvertised tool hidden");check(queries()===before,"hidden tool no SQL");}
  for(const value of [{limit:0},{limit:501},{limit:1.5},{cursor:42},{cursor:"invalid"},{unknown:true}]){before=queries();check((await req("/webmcp/staff_notes","POST",value)).status===400,"invalid input refused");check(queries()===before,"invalid input no SQL");}
  before=queries();check((await req("/webmcp/restricted_notes","POST",{})).status===403&&queries()===before,"scope gate");
  const hidden:any=await(await req("/webmcp/read_owned","POST",{id:"other"})).json();check(hidden.output.title===null,"ref gets caller-scoped Store");
  const owned:any=await(await req("/webmcp/read_owned","POST",{id:"a"})).json();check(owned.output.title==="first","typed ref dispatch");
  for(const [kind,status] of ([["anonymous",401],["member",403],["oauth",403]] as const)){before=queries();check((await req("/webmcp","GET",undefined,{"x-test-caller":kind})).status===status&&queries()===before,"cookie-only staff gate");}
  for(const origin of ["https://evil.test",""]){before=queries();const response=await req("/webmcp/edit_note","POST",{id:"a",title:"changed",version:1},{origin});check(response.status===403&&queries()===before,"origin before SQL");}
  const edited:any=await(await req("/webmcp/edit_note","POST",{id:"a",title:"changed",version:1})).json();check(edited.output.results[0][0].title==="changed","SQL result envelope");
  check((await req("/webmcp/edit_note","POST",{id:"a",title:"again",version:1})).status===409,"OCC");
  const method=await req("/webmcp/edit_note");check(method.status===405&&method.headers.get("allow")==="POST","Allow header");
  const huge=new Request("https://app.test/admin/api/webmcp/edit_note",{method:"POST",headers:{origin:"https://app.test","content-length":"1000001"},body:"{}"});before=queries();check((await app(huge)).status===400&&!huge.bodyUsed&&queries()===before,"oversized body refused unread");
  return {ok:true};
}

for(const target of ["bun-sqlite","bun-postgres"] as const)(target==="bun-postgres"&&!process.env.MANTLE_NEXT_BUN_PG_URL?test.skip:test)(target+" WebMCP shares the staff catalogue, validation, native wire and ref Store",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"mantle-webmcp-")),sqlite=target==="bun-sqlite",schema="webmcp_"+crypto.randomUUID().replaceAll("-","");
  const db:any=sqlite?new Database(":memory:"):new SQL(process.env.MANTLE_NEXT_BUN_PG_URL!,{max:1});let queries=0;
  try{
    const files=await generateOrThrow(target,[{sourceId:"webmcp.yaml",text:source}]);await writeGenerated(dir,files);
    if(sqlite)db.exec(files["schema.sql"]!+seed);else{await db.unsafe(`CREATE SCHEMA ${schema}`);await db.unsafe(`SET search_path TO ${schema}`);await db.unsafe(files["schema.sql"]!);await db.unsafe(seed.replaceAll(",0,0,",",now(),now(),").replaceAll("'first',1,","'first',true,").replaceAll("'second',0,","'second',false,").replaceAll("'hidden',1,","'hidden',true,"));}
    const {admin}=await import(join(dir,"admin.ts")),handle=sqlite?{query(sql:string){queries++;return db.query(sql);}}:{unsafe(sql:string,values:any[]){queries++;return db.unsafe(sql,values);},begin:db.begin.bind(db)};
    const serve=admin({db:()=>handle,caller:(request:Request)=>request.headers.get("x-test-caller")==="anonymous"?{kind:"anonymous"}:{...staff,...(request.headers.get("x-test-caller")==="member"?{role:null}:{}),...(request.headers.get("x-test-caller")==="oauth"?{credential:"oauth"}:{})},handlers:{"read-owned":async(ctx:any,input:any)=>({title:(await ctx.store.collection("notes").findById(input.id))?.title??null})}});
    expect(await verify((r)=>serve(r,{}),()=>queries)).toEqual({ok:true});
  }finally{if(sqlite)db.close();else{await db.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await db.close();}await rm(dir,{recursive:true,force:true});}
},30000);

test("Admin WebMCP stays empty without an MCP surface and excludes public tools and the SDK",async()=>{
  const {bundle}=await import("../src/infrastructure/bundle.js"),dir=await mkdtemp(join(resolve(import.meta.dir,"apps"),".webmcp-size-"));
  try{
    const empty=await generateOrThrow("bun-sqlite",[{sourceId:"empty.yaml",text:atom("Schema","notes",{title:"Notes",lifecycle:"operational",schema:{type:"object",properties:{title:{type:"string"}}}})}]);
    const emptyDir=join(dir,"empty");await writeGenerated(emptyDir,empty);const {admin}=await import(join(emptyDir,"admin.ts"));
    expect(await(await admin({db:()=>({query(){throw Error("empty catalogue must not query");}}),caller:()=>staff})(new Request("https://app.test/admin/api/webmcp"),{})).json()).toEqual({tools:[],routes:{}});
    const files=await generateOrThrow("cloudflare-d1",[{sourceId:"selected.yaml",text:source}]);await writeGenerated(dir,files,false);
    for(const selected of [true,false]){
      const entry=join(dir,selected?"admin-worker.ts":"bare-worker.ts");
      await writeFile(entry,selected?`import {admin} from './admin.js';export default{fetch:admin({db:env=>env.DB,caller:()=>(${JSON.stringify(staff)}),handlers:{'read-owned':async()=>({title:null})}})};`:'export {default} from "./views/public-notes.js";');
      const graph=await bundle(entry,join(dir,selected?"admin-bundle":"bare-bundle")),text=(await Promise.all(Object.keys(graph.outputs).filter(p=>p.endsWith(".js")).map(p=>readFile(resolve(import.meta.dir,"..",p),"utf8")))).join("\n");
      expect(text).not.toContain("@modelcontextprotocol/server");expect(text).not.toContain("mcp-handler");
      expect(text.includes("No such staff tool.")).toBe(selected);
      if(selected)expect(text).not.toContain('name: "public_notes"');
    }
  }finally{await rm(dir,{recursive:true,force:true});}
});

(process.env.MANTLE_NEXT_WEBMCP_D1?test:test.skip)("WebMCP executes the same scoped routes and negative cases on actual D1",async()=>{
  const {unstable_splitSqlQuery}=await import("wrangler"),base=resolve(import.meta.dir,".."),dir=await mkdtemp(join(base,"tests/apps/.webmcp-d1-")),privateDir=await mkdtemp(join(tmpdir(),"mantle-webmcp-d1-")),port=process.env.MANTLE_NEXT_WEBMCP_PORT??"8992";
  let worker:ReturnType<typeof spawn>|undefined,log:Awaited<ReturnType<typeof open>>|undefined;
  try{
    const files=await generateOrThrow("cloudflare-d1",[{sourceId:"webmcp.yaml",text:source}]);await writeGenerated(dir,files,false);
    await writeFile(join(dir,"worker.ts"),`import {admin} from './admin.js';
const staff=${JSON.stringify(staff)},verify=${verify.toString()};
export default{async fetch(request,env){if(new URL(request.url).pathname==='/health')return new Response('ready');
for(const sql of ${JSON.stringify(unstable_splitSqlQuery(files["schema.sql"]!+seed))})await env.DB.prepare(sql).run();
let queries=0;const db={prepare(sql){queries++;return env.DB.prepare(sql);},batch:env.DB.batch.bind(env.DB)};
const app=admin({db:()=>db,caller:request=>request.headers.get('x-test-caller')==='anonymous'?{kind:'anonymous'}:{...staff,...(request.headers.get('x-test-caller')==='member'?{role:null}:{}),...(request.headers.get('x-test-caller')==='oauth'?{credential:'oauth'}:{})},handlers:{'read-owned':async(ctx,input)=>({title:(await ctx.store.collection('notes').findById(input.id))?.title??null})}});
try{return Response.json(await verify(request=>app(request,env),()=>queries));}catch(error){return Response.json({error:String(error)},{status:500});}}};`);
    const config=join(privateDir,"wrangler.json");await writeFile(config,JSON.stringify({name:"mantle-webmcp-local",main:join(dir,"worker.ts"),compatibility_date:"2026-09-28",compatibility_flags:["nodejs_compat"],d1_databases:[{binding:"DB",database_name:"mantle-webmcp-local",database_id:"00000000-0000-0000-0000-000000000001"}]}));
    log=await open(join(privateDir,"worker.log"),"w");worker=spawn("node",[join(base,"node_modules/wrangler/bin/wrangler.js"),"dev","--local","--config",config,"--ip","127.0.0.1","--port",port,"--inspector-port","0","--persist-to",join(privateDir,"state")],{cwd:base,detached:true,env:{...process.env,WRANGLER_SEND_METRICS:"false",NO_PROXY:"127.0.0.1,localhost",no_proxy:"127.0.0.1,localhost"},stdio:["ignore",log.fd,log.fd]});
    let ready=false;for(let i=0;i<60;i++){if(worker.exitCode!==null)throw Error(await readFile(join(privateDir,"worker.log"),"utf8"));try{ready=(await fetch(`http://127.0.0.1:${port}/health`,{signal:AbortSignal.timeout(1000)})).ok;}catch{}if(ready)break;await new Promise(resolve=>setTimeout(resolve,1000));}
    expect(ready).toBe(true);const response=await fetch(`http://127.0.0.1:${port}/verify`,{signal:AbortSignal.timeout(30000)});expect(await response.json()).toEqual({ok:true});expect(response.status).toBe(200);
  }finally{if(worker&&worker.exitCode===null){const ended=once(worker,"exit");try{process.kill(-worker.pid!,"SIGTERM");}catch{}await ended;}await log?.close();await rm(dir,{recursive:true,force:true});await rm(privateDir,{recursive:true,force:true});}
},90000);
