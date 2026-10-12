import {test,expect} from "bun:test";
import {Database} from "bun:sqlite";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {generateOrThrow,writeGenerated} from "./apps/link.js";
export const source=`apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: {name: notes}
spec:
 title: Notes
 lifecycle: operational
 schema: {type: object, required: [title], properties: {title: {type: string}}}
---
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: {name: notes}
spec:
 surface: public
 sql: SELECT id,title FROM notes ORDER BY id
---
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: {name: secret}
spec:
 surface: internal
 sql: SELECT id FROM notes ORDER BY id
---
apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: {name: edit}
spec:
 requires: {auth: {all: [{ctx.staff: [editor]}]}}
 input: {type: object, required: [id,title,version], properties: {id: {type: string}, title: {type: string}, version: {type: integer}}, additionalProperties: false}
 output: {type: object}
 handler: {sql: 'UPDATE notes SET title=input.title WHERE id=input.id AND version=input.version RETURNING id,title'}
---
apiVersion: cms.mantle.aotter.net/v2
kind: Trigger
metadata: {name: edit-http}
spec:
 source: {kind: http, method: PUT, path: '/api/notes/{id}'}
 target: {procedure: edit}
`;
const user=(role:string|null="editor",credential="api-key")=>({kind:"user",subject:"s",role,scopes:[],credential,credentialId:null,clientId:null});
test("REST selected routes: paging, validation, auth, OCC, method, composition and session origin",async()=>{
 const files=await generateOrThrow("bun-sqlite",[{sourceId:"rest.yaml",text:source}]);
 expect(files["rest.ts"]).not.toContain("secret.js");
 const dir=await mkdtemp(join(tmpdir(),"mantle-rest-")),db=new Database(":memory:");
 try {
  await writeGenerated(dir,files);db.exec(files["schema.sql"]!);
  for(const id of ["a","b","c"]) db.query("INSERT INTO notes(id,version,created_at,updated_at,title) VALUES (?,1,0,0,?)").run(id,id);
  let caller:any={kind:"anonymous"},calls=0;
  const {rest}=await import(join(dir,"rest.ts"));
  const fetch=rest({db:()=>db,caller:async()=>{calls++;return caller;}});
  const request=(path:string,method="GET",body?:string,headers?:Record<string,string>)=>fetch(new Request("https://app.test"+path,{method,body,headers}),{});
  const first=await request("/api/views/notes?limit=1");expect(first.status).toBe(200);expect(first.headers.get("cache-control")).toBe("private, no-store");
  const page=await first.json();expect(page.rows).toEqual([{id:"a",title:"a"}]);
  expect((await (await request("/api/views/notes?limit=1&cursor="+encodeURIComponent(page.nextCursor))).json()).rows).toEqual([{id:"b",title:"b"}]);
  expect((await request("/api/%76iews/notes")).status).toBe(200);
  expect((await request("/api/views/notes?limit=bad")).status).toBe(400);
  expect((await request("/api/notes/a","PUT",'{"title":"x","version":1}')).status).toBe(401);
  caller=user(null);expect((await request("/api/notes/a","PUT",'{"title":"x","version":1}')).status).toBe(403);
  caller=user();expect((await request("/api/notes/a","PUT",'{"title":"x","version":1}')).status).toBe(200);
  expect((await request("/api/notes/a","PUT",'{"title":"x","version":1}')).status).toBe(409);
  for(const body of ['{','[]','{"title":3,"version":2}','{"title":"x","version":2.5}']) expect((await request("/api/notes/a","PUT",body)).status).toBe(400);
  expect((await request("/api/views/secret")).status).toBe(404);
  const method=await request("/api/views/notes","POST");expect(method.status).toBe(405);expect(method.headers.get("allow")).toBe("GET");
  expect((await request("/api/notes/a")).status).toBe(405);
  expect((await request("/api/unknown")).status).toBe(404);
  const before=calls;expect(await request("/custom")).toBeUndefined();expect(await request("/custom/%ZZ")).toBeUndefined();expect(calls).toBe(before);
  const oversized=new Request("https://app.test/api/notes/a",{method:"PUT",body:"{}",headers:{"content-length":"1000001"}});expect((await fetch(oversized,{})).status).toBe(400);expect(oversized.bodyUsed).toBe(false);
  expect((await request("/api/notes/a","PUT",JSON.stringify({title:"😀".repeat(300000),version:2}))).status).toBe(400);
  caller=user("editor","session");
  for(const headers of [{} as Record<string,string>,{origin:"https://evil.test"},{"sec-fetch-site":"cross-site",origin:"https://app.test"}]) expect((await request("/api/notes/a","PUT",'{"title":"y","version":2}',headers)).status).toBe(403);
  expect((await (await request("/api/notes/a","PUT",'{"title":"y","version":2}',{origin:"https://evil.test"})).json()).error.path).toBe("request:origin");
  expect((await request("/api/notes/a","PUT",'{"title":"y","version":2}',{origin:"https://app.test"})).status).toBe(200);
 }finally {db.close();await rm(dir,{recursive:true,force:true});}
});
test("REST clones query values before driver conversion and prioritizes static Trigger paths",async()=>{
 const text=source.replace('sql: SELECT id,title FROM notes ORDER BY id','input: {type: object, required: [title], properties: {title: {type: string}}, additionalProperties: false}\n sql: SELECT id,title FROM notes WHERE title=input.title ORDER BY id')+`---
apiVersion: cms.mantle.aotter.net/v2
kind: Trigger
metadata: {name: search-http}
spec:
 source: {kind: http, method: PUT, path: /api/notes/search}
 target: {procedure: edit}
`;
 const files=await generateOrThrow("bun-sqlite",[{sourceId:"rest.yaml",text}]),dir=await mkdtemp(join(tmpdir(),"mantle-rest-input-")),db=new Database(":memory:");
 try {
  await writeGenerated(dir,files);db.exec(files["schema.sql"]!);db.exec("INSERT INTO notes(id,version,created_at,updated_at,title) VALUES ('a',1,0,0,'a')");
  const {rest}=await import(join(dir,"rest.ts")),fetch=rest({db:()=>db,caller:async()=>user()});
  const view=await fetch(new Request("https://app.test/api/views/notes?title=a"),{});expect(view.status).toBe(200);expect((await view.json()).rows).toEqual([{id:"a",title:"a"}]);
  const result=await fetch(new Request("https://app.test/api/notes/search",{method:"PUT",body:JSON.stringify({id:"a",title:"static",version:1})}),{});expect(result.status).toBe(200);expect(db.query("SELECT title FROM notes").get()).toEqual({title:"static"});
 }finally {db.close();await rm(dir,{recursive:true,force:true});}
});
test("REST-only startup references exposed operations within the existing Worker budget",async()=>{
 const {writeFile}=await import("node:fs/promises"),{bundle,startupGraph}=await import("../src/infrastructure/bundle.js");
 const files=await generateOrThrow("cloudflare-d1",[{sourceId:"rest.yaml",text:source}]);
 const dir=await mkdtemp(join(import.meta.dir,"apps/.rest-size-"));
 try {
  await writeGenerated(dir,files,false);const entry=join(dir,"worker.ts");
  await writeFile(entry,'import {rest} from "./rest.js"; export default {fetch:rest({db:(env:any)=>env.DB,caller:async()=>({kind:"anonymous"} as const)})};');
  const meta=await bundle(entry,join(dir,"dist")),graph=startupGraph(meta,entry),bytes=graph.reduce((sum,path)=>sum+meta.outputs[path]!.bytes,0);
  const budgets=JSON.parse(await (await import("node:fs/promises")).readFile(join(import.meta.dir,"../size-budgets.json"),"utf8"));
  expect(bytes).toBeLessThanOrEqual(budgets["cloudflare-d1"]);
  const output=await (await import("node:fs/promises")).readFile(join(process.cwd(),graph[0]!),"utf8");
  expect(output).not.toContain('SELECT id FROM notes');
  console.log(JSON.stringify({entry:"rest-only",startupBytes:bytes,budgetBytes:budgets["cloudflare-d1"]}));
 }finally {await rm(dir,{recursive:true,force:true});}
});
