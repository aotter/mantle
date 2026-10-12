import {test,expect} from "bun:test";
import {Database} from "bun:sqlite";
import {SQL} from "bun";
import {mkdtemp,rm,writeFile,readFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {generateOrThrow,writeGenerated} from "./apps/link.js";
const source=`apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: {name: notes}
spec:
 title: Notes
 lifecycle: operational
 ttl: {field: expiresAt, expireAfterSeconds: 0}
 indexes: [[owner, id]]
 scope: {owner: auth.uid()}
 schema: {type: object, required: [owner, displayTitle, score], properties: {owner: {type: string}, displayTitle: {type: string}, score: {type: integer}, expiresAt: {type: string, format: date-time, nullable: true}}}
---
apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: {name: posts}
spec:
 title: Posts
 lifecycle: publishing
 scope: {owner: auth.uid()}
 indexes: [[owner, id]]
 ttl: {field: expiresAt, expireAfterSeconds: 0}
 schema: {type: object, required: [owner, title], properties: {owner: {type: string}, title: {type: string}, expiresAt: {type: string, format: date-time, nullable: true}}}
---
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: {name: posts_report}
spec:
 surface: staff
 sql: SELECT id,title,status FROM posts ORDER BY id
---
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: {name: report}
spec:
 surface: staff
 requires: {auth: {all: [{ctx.staff: [staff]}]}}
 uiSchema: {list: {columns: [id, displayTitle, score], searchFields: [displayTitle], filterFields: [score, expiresAt]}}
 sql: SELECT id,displayTitle,score,updated_at,expiresAt FROM notes ORDER BY id
---
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: {name: private_report}
spec:
 surface: staff
 requires: {auth: {all: [{ctx.auth.scope: restricted}]}}
 sql: SELECT id FROM notes ORDER BY id
---
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: {name: public_report}
spec:
 surface: public
 sql: SELECT id FROM notes ORDER BY id
---
apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: {name: edit}
spec:
 requires: {auth: {all: [{ctx.staff: [staff]}]}}
 input: {type: object, required: [id,title,version], properties: {id: {type: string}, title: {type: string}, version: {type: integer}}, additionalProperties: false}
 output: {type: object}
 handler: {sql: 'UPDATE notes SET displayTitle=input.title WHERE id=input.id AND version=input.version RETURNING id,displayTitle'}
---
apiVersion: cms.mantle.aotter.net/v2
kind: Trigger
metadata: {name: edit_mcp}
spec:
 source: {kind: mcp, surface: staff}
 target: {procedure: edit}
`;
const staff:any={kind:"user",subject:"a",role:"staff",scopes:[],credential:"session",credentialId:null,clientId:null};
for(const target of ["bun-sqlite","bun-postgres"] as const)(target==="bun-postgres"&&!process.env.MANTLE_NEXT_BUN_PG_URL?test.skip:test)(`${target} Admin staff boundary, native paging/filtering, wire and operation`,async()=>{
 const files=await generateOrThrow(target,[{sourceId:"admin.yaml",text:source}]),dir=await mkdtemp(join(tmpdir(),"mantle-admin-")),sqlite=target==="bun-sqlite",schema="admin_"+crypto.randomUUID().replaceAll("-","");
 const db:any=sqlite?new Database(":memory:"):new SQL(process.env.MANTLE_NEXT_BUN_PG_URL!,{max:1});
 try{
  await writeGenerated(dir,files);if(sqlite)db.exec(files["schema.sql"]!);else{await db.unsafe(`CREATE SCHEMA ${schema}`);await db.unsafe(`SET search_path TO ${schema}`);await db.unsafe(files["schema.sql"]!);}
  const app=await import(join(dir,"generated.ts")),{admin}=await import(join(dir,"admin.ts"));
  for(const [id,title,score,owner] of [["a","Alpha",1,"a"],["b","beta",2,"a"],["c","100% literal",2,"a"],["d","=danger",2,"a"],["other","beta",2,"b"]]){
    if(sqlite)db.query("INSERT INTO notes(id,version,created_at,updated_at,owner,displaytitle,score) VALUES (?,1,0,0,?,?,?)").run(id,owner,title,score);
    else await db.unsafe("INSERT INTO notes(id,version,created_at,updated_at,owner,displaytitle,score) VALUES ($1,1,now(),now(),$2,$3,$4)",[id,owner,title,score]);
  }
  if(sqlite)db.exec("INSERT INTO notes(id,version,created_at,updated_at,owner,displaytitle,score,expiresat) VALUES ('expired',1,0,0,'a','beta',2,0)");
  else await db.unsafe("INSERT INTO notes(id,version,created_at,updated_at,owner,displaytitle,score,expiresat) VALUES ('expired',1,now(),now(),'a','beta',2,'2000-01-01')");
  for(const [id,status,owner] of [["draft","draft","a"],["published","published","a"],["other","published","b"]]){
   if(sqlite)db.query("INSERT INTO posts(id,version,created_at,updated_at,owner,title,status) VALUES (?,1,0,0,?,'post',?)").run(id,owner,status);
   else await db.unsafe("INSERT INTO posts(id,version,created_at,updated_at,owner,title,status) VALUES ($1,1,now(),now(),$2,'post',$3)",[id,owner,status]);
  }
  let caller:any=staff,calls=0,queries=0;
  const handle=sqlite?{query(sql:string){queries++;return db.query(sql);}}:{unsafe(sql:string,values:any[]){queries++;return db.unsafe(sql,values);},begin:db.begin.bind(db)};
  const fetch=admin({db:()=>handle,caller:async()=>{calls++;return caller;},getUser:async()=>({name:"Ada",email:"a@test",image:"avatar"}),assets:async(path:string)=>path==="index.html"||path==="preview.html"?new Response("<html/>",{headers:{"content-type":"text/html"}}):path==="assets/app.hash.js"?new Response("js",{headers:{"content-type":"text/javascript"}}):null});
  const req=(path:string,method="GET",body?:string,headers?:Record<string,string>)=>fetch(new Request("https://app.test"+path,{method,body,headers}),{});
  expect(await req("/elsewhere")).toBeUndefined();expect(calls).toBe(0);
  const shell=await req("/admin/members/a.b@test");expect(shell.status).toBe(200);expect(shell.headers.get("x-frame-options")).toBe("DENY");expect(shell.headers.get("cache-control")).toBe("no-store");expect(calls).toBe(0);
  expect((await req("/admin/assets/app.hash.js")).headers.get("cache-control")).toContain("immutable");expect((await req("/admin/assets/missing.js")).status).toBe(404);expect((await req("/admin/preview.html")).headers.get("x-frame-options")).toBeNull();expect((await req("/admin/%2fsecret")).status).toBe(404);
  caller={kind:"anonymous"};expect((await req("/admin/api/me")).status).toBe(401);
  for(const denied of [{kind:"system",reason:"cron"},{...staff,role:null},{...staff,role:"owner"},{...staff,credential:"oauth"}]){caller=denied;const response=await req("/admin/api/me");expect(response.status).toBe(403);expect((await response.json()).minimumRole).toBe("staff");}caller=staff;
  const before=queries,bootstrap=await(await req("/admin/api/bootstrap")).json();expect(queries).toBe(before);expect(bootstrap.me).toEqual({userId:"a",role:"staff",login:"Ada",image:"avatar"});expect(bootstrap.views.map((v:any)=>v.name)).toEqual(["posts_report","report"]);expect(bootstrap.operations.map((p:any)=>p.name)).toEqual(["edit"]);expect(bootstrap.site.capabilities).toEqual({siteSettings:false,media:false,invitationEmail:false,statistics:false});
  expect((await(await req("/admin/api/views/posts_report")).json()).rows.map((r:any)=>[r.id,r.status])).toEqual([["draft","draft"],["published","published"]]);
  const viewBefore=queries;
  const first=await(await req("/admin/api/views/report?limit=1&filter.score=2")).json();expect(first.rows).toEqual([{id:"b",displayTitle:"beta",score:2,updated_at:expect.any(String),expiresAt:null}]);expect(queries-viewBefore).toBe(1);
  const next=await(await req("/admin/api/views/report?limit=1&filter.score=2&cursor="+encodeURIComponent(first.nextCursor))).json();expect(next.rows[0].id).toBe("c");
  expect((await(await req("/admin/api/views/report?search=BETA")).json()).rows.map((r:any)=>r.id)).toEqual(["b"]);expect((await(await req("/admin/api/views/report?search=%25")).json()).rows.map((r:any)=>r.id)).toEqual(["c"]);
  if(sqlite)db.exec("UPDATE notes SET expiresat=4070908800000000 WHERE id='b'");else await db.unsafe("UPDATE notes SET expiresat='2099-01-01T00:00:00Z' WHERE id='b'");
  expect((await(await req("/admin/api/views/report?filter.expiresAt="+encodeURIComponent("2099-01-01T08:00:00+08:00"))).json()).rows.map((r:any)=>r.id)).toEqual(["b"]);
  expect((await req("/admin/api/views/report?filter.expiresAt=2099-02-30T00%3A00%3A00Z")).status).toBe(400);
  expect((await req("/admin/api/views/report?filter.score=bad")).status).toBe(400);expect((await req("/admin/api/views/report?search=%00")).status).toBe(400);
  for(const name of ["private_report","public_report","missing"])expect((await req("/admin/api/views/"+name)).status).toBe(404);
  const exportResponse=await req("/admin/api/views/report/export?filter.score=2");expect(exportResponse.headers.get("content-type")).toContain("text/csv");expect(await exportResponse.text()).toBe("id,displayTitle,score\r\nb,beta,2\r\nc,100% literal,2\r\nd,'=danger,2\r\n");
  expect((await req("/admin/api/collections/notes/statistics")).status).toBe(501);expect((await req("/admin/api/collections/missing/statistics")).status).toBe(404);
  const input=JSON.stringify({id:"a",title:"edited",version:1});expect((await req("/admin/api/operations/edit","POST",input)).status).toBe(403);expect((await req("/admin/api/operations/edit","POST",input,{origin:"https://evil.test"})).status).toBe(403);
  const result=await req("/admin/api/operations/edit","POST",input,{origin:"https://app.test"});expect(result.status).toBe(200);expect((await result.json()).output.results[0][0].displaytitle).toBe("edited");expect((await req("/admin/api/operations/edit","POST",input,{origin:"https://app.test"})).status).toBe(409);
  if(sqlite)db.exec("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<620) INSERT INTO notes(id,version,created_at,updated_at,owner,displaytitle,score) SELECT 'bulk-'||printf('%04d',i),1,0,0,'a','bulk',3 FROM n");
  else await db.unsafe("INSERT INTO notes(id,version,created_at,updated_at,owner,displaytitle,score) SELECT 'bulk-'||lpad(i::text,4,'0'),1,now(),now(),'a','bulk',3 FROM generate_series(1,620) AS i");
  const pageStart=queries;let cursor="",firstCursor="",count=0;
  do{const page=await(await req("/admin/api/views/report?limit=250&filter.score=3"+(cursor?"&cursor="+encodeURIComponent(cursor):""))).json();count+=page.rows.length;cursor=page.nextCursor??"";if(!firstCursor)firstCursor=cursor;}while(cursor);
  expect(count).toBe(620);expect(queries-pageStart).toBe(3);
  const csvStart=queries,csvBytes=new Uint8Array(await(await req("/admin/api/views/report/export?filter.score=3&cursor="+encodeURIComponent(firstCursor))).arrayBuffer());expect(Array.from(csvBytes.slice(0,3))).toEqual([239,187,191]);expect(new TextDecoder().decode(csvBytes).trim().split("\r\n")).toHaveLength(621);expect(queries-csvStart).toBe(2);
  const wrong=await req("/admin/api/me","POST","{}",{origin:"https://app.test"});expect(wrong.status).toBe(405);expect(wrong.headers.get("allow")).toBe("GET");
  const huge=new Request("https://app.test/admin/api/operations/edit",{method:"POST",body:"{}",headers:{origin:"https://app.test","content-length":"1000001"}});expect((await fetch(huge,{})).status).toBe(400);expect(huge.bodyUsed).toBe(false);
 }finally{if(sqlite)db.close();else{await db.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await db.close();}await rm(dir,{recursive:true,force:true});}
},30000);

test("Admin options and native pager modules typecheck on all four handles",async()=>{
 const ts=(await import("typescript")).default,dir=await mkdtemp(join(import.meta.dir,"apps/.admin-types-"));
 try{
  const entries:string[]=[];
  for(const target of ["bun-sqlite","bun-postgres","cloudflare-d1","cloudflare-postgres"] as const){
   const path=join(dir,target),files=await generateOrThrow(target,[{sourceId:"admin.yaml",text:source}]);await writeGenerated(path,files,false);
   const entry=join(path,"use.ts");await writeFile(entry,`import {admin} from './admin.js';admin({db:()=>({} as any),caller:async()=>({kind:'anonymous'} as const)});`);entries.push(entry);
  }
  const program=ts.createProgram(entries,{noEmit:true,strict:true,skipLibCheck:true,target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.NodeNext,moduleResolution:ts.ModuleResolutionKind.NodeNext,types:["bun-types"]});expect(ts.getPreEmitDiagnostics(program).map(d=>ts.flattenDiagnosticMessageText(d.messageText,"\n"))).toEqual([]);
 }finally{await rm(dir,{recursive:true,force:true});}
},30000);
test("Admin dispatches ref Procedures through its typed Handlers options",async()=>{
 const text=source.replace("handler: {sql: 'UPDATE notes SET displayTitle=input.title WHERE id=input.id AND version=input.version RETURNING id,displayTitle'}","handler: {ref: edit}"),files=await generateOrThrow("bun-sqlite",[{sourceId:"ref-admin.yaml",text}]),dir=await mkdtemp(join(import.meta.dir,"apps/.admin-ref-")),db=new Database(":memory:");
 try{
  await writeGenerated(dir,files);db.exec(files["schema.sql"]!);const {admin}=await import(join(dir,"admin.ts"));
  const fetch=admin({db:()=>db,caller:async()=>staff,handlers:{edit:async(ctx:any,input:any)=>({title:input.title,subject:ctx.caller.subject})}});
  const response=await fetch(new Request("https://app.test/admin/api/operations/edit",{method:"POST",body:JSON.stringify({id:"a",title:"ref",version:1}),headers:{origin:"https://app.test"}}),{});expect(response.status).toBe(200);expect(await response.json()).toEqual({ok:true,output:{title:"ref",subject:"a"}});
  const entry=join(dir,"use.ts");await writeFile(entry,`import {admin} from './admin.js';const options={db:()=>({} as any),caller:async()=>({kind:'anonymous'} as const)};\n// @ts-expect-error Handlers are required\nadmin(options);admin({...options,handlers:{edit:async(ctx,input)=>({title:input.title})}});`);
  const ts=(await import("typescript")).default,program=ts.createProgram([entry],{noEmit:true,strict:true,skipLibCheck:true,target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.NodeNext,moduleResolution:ts.ModuleResolutionKind.NodeNext,types:["bun-types"],allowImportingTsExtensions:true});expect(ts.getPreEmitDiagnostics(program).map(d=>ts.flattenDiagnosticMessageText(d.messageText,"\n"))).toEqual([]);
 }finally{db.close();await rm(dir,{recursive:true,force:true});}
},30000);
test("Worker startup excludes unselected Admin and keeps compiler data out of the selected boundary",async()=>{
 const {bundle,startupGraph}=await import("../src/infrastructure/bundle.js"),dir=await mkdtemp(join(import.meta.dir,"apps/.admin-bundle-"));
 try{
  await writeGenerated(dir,await generateOrThrow("cloudflare-d1",[{sourceId:"admin.yaml",text:source}]),false);
  for(const selected of [false,true]){
   const entry=join(dir,selected?"admin-worker.ts":"bare-worker.ts");await writeFile(entry,selected?`import {admin} from './admin.js';export default {fetch:admin({db:(env:any)=>env.DB,caller:async()=>({kind:'anonymous'} as const)})};`:`export {default} from './views/public_report.js';`);
   const meta=await bundle(entry,join(dir,selected?"admin-bundle":"bare-bundle")),graph=startupGraph(meta,entry),inputs=Object.values(meta.outputs).flatMap(output=>Object.keys(output.inputs));
   expect(inputs.some(input=>/\/(?:mantle)\/(?:dist|src)\//.test(input))).toBe(false);expect(inputs.some(input=>/\/(?:ajv|zod|libpg-query)\//.test(input))).toBe(false);
   expect(inputs.some(input=>/\/kernel\/admin\.js$/.test(input))).toBe(selected);
   console.log(JSON.stringify({entry:selected?"admin-only":"no-admin",startupBytes:graph.reduce((sum,path)=>sum+meta.outputs[path]!.bytes,0)}));
  }
 }finally{await rm(dir,{recursive:true,force:true});}
});
(process.env.MANTLE_NEXT_ADMIN_D1?test:test.skip)("Admin executes scoped match SQL and mutations on actual local D1",async()=>{
 const {unstable_splitSqlQuery}=await import("wrangler"),{spawn}=await import("node:child_process"),{once}=await import("node:events"),{open}=await import("node:fs/promises"),base=resolve(import.meta.dir,".."),dir=await mkdtemp(join(base,"tests/apps/.admin-d1-")),privateDir=await mkdtemp(join(tmpdir(),"mantle-admin-d1-")),port=process.env.MANTLE_NEXT_ADMIN_PORT??"8998";
 let worker:ReturnType<typeof spawn>|undefined,log:Awaited<ReturnType<typeof open>>|undefined;
 try{
  const files=await generateOrThrow("cloudflare-d1",[{sourceId:"admin.yaml",text:source}]);await writeGenerated(dir,files,false);
  const seed="INSERT INTO notes(id,version,created_at,updated_at,owner,displaytitle,score) VALUES ('a',1,0,0,'a','Alpha',1),('b',1,0,0,'a','beta',2),('other',1,0,0,'b','beta',2); INSERT INTO notes(id,version,created_at,updated_at,owner,displaytitle,score,expiresat) VALUES ('expired',1,0,0,'a','beta',2,0)";
  await writeFile(join(dir,"worker.ts"),`import {admin} from './admin.js';
const caller=${JSON.stringify(staff)};const app=admin({db:(env:{DB:any})=>env.DB,caller:async()=>caller});
const check=(ok:unknown,message:string)=>{if(!ok)throw Error(message);};
export default{async fetch(request:Request,env:{DB:any}){if(new URL(request.url).pathname==='/health')return new Response('ready');try{
 for(const sql of ${JSON.stringify(unstable_splitSqlQuery(files["schema.sql"]!+seed))})await env.DB.prepare(sql).run();
 const read=(path:string)=>app(new Request('https://app.test/admin/api'+path),env);
 const response=await read('/views/report?search=BETA&filter.score=2&limit=1');check(response!.status===200,'read status');const page:any=await response!.json();check(page.rows.length===1&&page.rows[0].id==='b'&&page.rows[0].displayTitle==='beta','scope/search/filter wire');
 check((await read('/views/public_report'))!.status===404,'public View hidden');check((await read('/views/private_report'))!.status===404,'requires View hidden');
 const input=JSON.stringify({id:'a',title:'edited',version:1}),write=(origin:string)=>app(new Request('https://app.test/admin/api/operations/edit',{method:'POST',body:input,headers:{origin}}),env);
 check((await write('https://evil.test'))!.status===403,'origin gate');check((await write('https://app.test'))!.status===200,'native write');check((await write('https://app.test'))!.status===409,'OCC');
 check((await env.DB.prepare("SELECT displaytitle FROM notes WHERE id='a'").first()).displaytitle==='edited','committed state');
 return Response.json({ok:true});}catch(error){return Response.json({error:String(error),stack:(error as Error).stack},{status:500});}}};`);
  const config=join(privateDir,"wrangler.json");await writeFile(config,JSON.stringify({name:"mantle-admin-local",main:join(dir,"worker.ts"),compatibility_date:"2026-09-28",compatibility_flags:["nodejs_compat"],d1_databases:[{binding:"DB",database_name:"mantle-admin-local",database_id:"00000000-0000-0000-0000-000000000001"}]}));
  log=await open(join(privateDir,"wrangler.log"),"w");worker=spawn("node",[join(base,"node_modules/wrangler/bin/wrangler.js"),"dev","--local","--config",config,"--ip","127.0.0.1","--port",port,"--inspector-port","0","--persist-to",join(privateDir,"state")],{cwd:base,detached:true,env:{...process.env,WRANGLER_SEND_METRICS:"false",NO_PROXY:"127.0.0.1,localhost",no_proxy:"127.0.0.1,localhost"},stdio:["ignore",log.fd,log.fd]});
  let ready=false;for(let i=0;i<60;i++){if(worker.exitCode!==null)throw Error(await readFile(join(privateDir,"wrangler.log"),"utf8"));try{ready=(await fetch(`http://127.0.0.1:${port}/health`,{signal:AbortSignal.timeout(1000)})).ok;}catch{}if(ready)break;await new Promise(resolve=>setTimeout(resolve,1000));}
  expect(ready).toBe(true);const response=await fetch(`http://127.0.0.1:${port}/verify`,{signal:AbortSignal.timeout(30000)});expect(await response.json()).toEqual({ok:true});expect(response.status).toBe(200);
 }finally{if(worker&&worker.exitCode===null){const ended=once(worker,"exit");try{process.kill(-worker.pid!,"SIGTERM");}catch{}await ended;}await log?.close();await rm(dir,{recursive:true,force:true});await rm(privateDir,{recursive:true,force:true});}
},90000);
test("CSV closes a failed later page without logging its native secret",async()=>{
 const {csv}=await import("../src/kernel/admin.js"),error=console.error,logs:unknown[][]=[];console.error=(...args)=>logs.push(args);
 try{let page=0;const response=await csv("report",async()=>{if(page++)throw Error("fake-secret-token from a native cause");return{rows:[{title:"ok"}],nextCursor:"next"};},["title"]);await expect(response.text()).rejects.toThrow("CSV export failed.");expect(JSON.stringify(logs)).not.toContain("fake-secret-token");}
 finally{console.error=error;}
});
test("Admin literal and mixed row aliases keep Object.prototype names unchanged",async()=>{
 const text=source+`---
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: {name: prototype_alias}
spec:
 surface: staff
 sql: SELECT 1 AS constructor, 2 AS "toString", 3 AS "__proto__"
---
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: {name: prototype_mixed}
spec:
 surface: staff
 uiSchema: {list: {filterFields: [constructor, expiresAt]}}
 sql: SELECT id,displayTitle,displayTitle AS constructor,expiresAt FROM notes ORDER BY id
`;
 const files=await generateOrThrow("bun-sqlite",[{sourceId:"prototype.yaml",text}]),dir=await mkdtemp(join(tmpdir(),"mantle-admin-prototype-")),db=new Database(":memory:");
 try{await writeGenerated(dir,files);db.exec(files["schema.sql"]!);db.exec("INSERT INTO notes(id,version,created_at,updated_at,owner,displaytitle,score) VALUES ('a',1,0,0,'a','Alpha',1)");const {admin}=await import(join(dir,"admin.ts")),app=admin({db:()=>db,caller:async()=>staff});const read=async(path:string)=>(await app(new Request("https://app.test/admin/api/views/"+path),{})).json();
 expect((await read("prototype_alias")).rows).toEqual([{constructor:1,toString:2,["__proto__"]:3}]);
 expect((await read("prototype_mixed?filter.constructor=Alpha")).rows).toEqual([{id:"a",displayTitle:"Alpha",constructor:"Alpha",expiresAt:null}]);
 expect((await read("prototype_mixed?filter.constructor=missing")).rows).toEqual([]);
 }finally{db.close();await rm(dir,{recursive:true,force:true});}
});
