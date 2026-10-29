import { sdkFixtureCaller } from "./apps/fixtures.js";
import { fixtureCaller } from "./apps/fixtures.js";
import {expect,test,spyOn} from "bun:test";
import {Database} from "bun:sqlite";
import {resolve} from "node:path";
import {mkdtemp,rm} from "node:fs/promises";
import {generateOrThrow,writeGenerated} from "./apps/link.js";
const source=`apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: {name: items}
spec:
  title: Items
  lifecycle: operational
  schema: {type: object, properties: {title: {type: string}}, required: [title]}
---
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: {name: items}
spec: {surface: public, sql: 'SELECT id, title FROM items ORDER BY id'}
---
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: {name: admin-items}
spec: {surface: admin, sql: 'SELECT id, title FROM items ORDER BY id'}
---
apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: {name: add-item}
spec:
  input: {type: object, properties: {title: {type: string, minLength: 1}}, required: [title], additionalProperties: false}
  output: {type: object}
  handler: {sql: 'INSERT INTO items(title) VALUES(input.title) RETURNING id'}
---
apiVersion: cms.mantle.aotter.net/v2
kind: Trigger
metadata: {name: add-item-mcp}
spec: {source: {kind: mcp, surface: public}, target: {procedure: add-item}}
`;
const user=fixtureCaller({kind:"user",subject:"u",role:"admin", admin: true,scopes:["mcp"],credential:"oauth",credentialId:null,clientId:null});
test("official SDK initializes, lists only surface tools, calls shared validation/paging, refuses auth and cookie writes",async()=>{
 const files=await generateOrThrow("bun-sqlite",[{sourceId:"mcp.yaml",text:source}]);
 const dir=await mkdtemp(resolve(import.meta.dir,".mcp-")),db=new Database(":memory:");
 let caller:any={kind:"anonymous"};
 const classifications: boolean[] = [];
 try {
  await writeGenerated(dir,files);db.exec(files["schema.sql"]!);
  const {mcp}=await import(resolve(dir,"mcp.ts"));const handle=mcp({db:()=>db,caller:(_request:Request,_env:unknown,authority:{readOnly:boolean})=>{classifications.push(authority.readOnly);return caller;}});
  const call=async(method:string,params:any={},path="/mcp",headers:Record<string,string>={})=>{
   const response=await handle(new Request("https://app.test"+path,{method:"POST",headers:{cookie:"fixture=1","content-type":"application/json",accept:"application/json, text/event-stream",...headers},body:JSON.stringify({jsonrpc:"2.0",id:1,method,params})}),{});
   const text=await response.text(); const data=JSON.parse(text.startsWith("event:")?text.split("data: ")[1].split("\n")[0]:text);return {response,data,readOnly:classifications.at(-1)};
  };
  const initialized=await call("initialize",{protocolVersion:"2025-03-26",capabilities:{},clientInfo:{name:"test",version:"1"}});expect(initialized.response.status).toBe(200);expect(initialized.readOnly).toBe(true);
  const listed=(await call("tools/list")).data.result.tools; expect(listed.map((t:any)=>t.name)).toEqual(["items","add_item"]);expect(listed[0].inputSchema.additionalProperties).toBe(false);
  const denied=await call("tools/list",{},"/mcp/admin"); expect(denied.response.status).toBe(401); expect(denied.response.headers.get("www-authenticate")).toContain('scope="mcp"');
  const bad=await call("tools/call",{name:"add_item",arguments:{title:""}});expect(bad.data.result.isError).toBe(true);expect(JSON.parse(bad.data.result.content[0].text).diagnostics[0].code).toBe("INPUT_VALIDATION_FAILED");
  const flood=await call("tools/call",{name:"add_item",arguments:{title:"x",rest:Array(10_000).fill(0)}});expect(flood.data.result.isError).toBe(true);expect(flood.data.result.content[0].text).toContain("more than the maximum of 10000 elements");
  const ok=await call("tools/call",{name:"add_item",arguments:{title:"Hello"}});expect(ok.data.result.isError).toBeUndefined();expect(ok.readOnly).toBe(false);
  const page=await call("tools/call",{name:"items",arguments:{limit:1}});expect(page.data.result.structuredContent.rows[0].title).toBe("Hello");expect(page.readOnly).toBe(true);
  caller=user;expect((await call("tools/list",{},"/mcp/admin")).data.result.tools.map((t:any)=>t.name)).toEqual(["admin_items"]);
  caller=fixtureCaller({...user,role:null,admin:false}); const roleDenied=await call("tools/list",{},"/mcp/admin");expect(roleDenied.response.status).toBe(403);expect(roleDenied.response.headers.has("www-authenticate")).toBe(false);
  caller=fixtureCaller({...user,scopes:[]}); const scopeDenied=await call("tools/list");expect(scopeDenied.response.status).toBe(403);expect(scopeDenied.response.headers.get("www-authenticate")).toContain('error="insufficient_scope", scope="mcp"');
  caller=fixtureCaller({...user,credential:"session"});expect((await call("tools/call",{name:"add_item",arguments:{title:"CSRF"}},"/mcp",{origin:"https://evil.test"})).response.status).toBe(403);
  expect((await call("tools/call",{name:"add_item",arguments:{title:"CSRF"}},"/mcp",{"sec-fetch-site":"cross-site"})).data.result.isError).toBe(true);
  expect(db.query("SELECT COUNT(*) n FROM items").get()).toEqual({n:1});
  expect(await handle(new Request("https://app.test/other"),{})).toBeUndefined();
 } finally {db.close();await rm(dir,{recursive:true,force:true});}
});

test("MCP answers a browser Origin only from loopback or allowedOrigins, 403 before authentication; no Origin passes; allowedOrigins parses once",async()=>{
 const files=await generateOrThrow("bun-sqlite",[{sourceId:"origin.yaml",text:source}]);
 const dir=await mkdtemp(resolve(import.meta.dir,".mcp-origin-")),db=new Database(":memory:");
 let caller:any={kind:"anonymous"};const refusals:any[]=[],observations:any[]=[];
 try {
  await writeGenerated(dir,files);db.exec(files["schema.sql"]!);const {mcp}=await import(resolve(dir,"mcp.ts"));
  const open=mcp({db:()=>db,caller:()=>caller,onRefusal:(event:any)=>{refusals.push(event);},onObservation:(event:any)=>{observations.push(event);}});
  const listed=mcp({db:()=>db,caller:()=>caller,allowedOrigins:["https://console.test:8443","partner.test","app.test"]});
  const call=(handle:any,url:string,headers:Record<string,string>={},era?:string)=>handle(new Request(url,{method:"POST",headers:{"content-type":"application/json",accept:"application/json, text/event-stream",...(era?{"mcp-protocol-version":era,"mcp-method":"tools/list"}:{}),...headers},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/list",params:era?{_meta:{"io.modelcontextprotocol/protocolVersion":era,"io.modelcontextprotocol/clientCapabilities":{},"io.modelcontextprotocol/clientInfo":{name:"test",version:"1"}}}:{}})}),{});
  for(const who of [{kind:"anonymous"},user]) for(const path of ["/mcp","/mcp/admin"]) for(const era of [undefined,"2026-07-28"]) {
   caller=who;const refused=await call(open,"https://app.test"+path,{origin:"https://evil.test"},era);
   expect(refused.status).toBe(403);expect((await refused.json()).error.message).toBe("Invalid Origin: evil.test");
   if(who===user) for(const headers of [{},{origin:"http://localhost:5173"}] as Record<string,string>[]) expect((await call(open,"https://app.test"+path,headers,era)).status).toBe(200);
  }
  // Each refusal is reported once to both callbacks.
  expect(refusals).toHaveLength(8);expect(refusals.every(event=>event.reason==="origin"&&event.status===403)).toBe(true);
  expect(observations.filter(event=>event.kind==="request-refused").map(event=>[event.status,event.surface])).toEqual(["public","public","admin","admin","public","public","admin","admin"].map(surface=>[403,surface]));
  caller={kind:"anonymous"};
  // The site's own origin is not implied: DNS rebinding sends Origin == the rebound Host, whatever CF-Connecting-IP claims.
  for(const url of ["https://app.test/mcp","http://evil.example.com:8787/mcp"]) for(const ip of [{},{"cf-connecting-ip":"127.0.0.1"}] as Record<string,string>[]) {
   const refused=await call(open,url,{host:new URL(url).host,origin:new URL(url).origin,...ip});
   expect(refused.status).toBe(403);expect((await refused.json()).error.message).toBe(`Invalid Origin: ${new URL(url).hostname}`);
  }
  // A forged loopback peer does not admit a foreign Origin; the opaque `null` Origin is refused.
  expect((await call(open,"http://127.0.0.1:8787/mcp",{origin:"https://evil.test","cf-connecting-ip":"127.0.0.1"})).status).toBe(403);
  expect((await call(open,"http://127.0.0.1:8787/mcp",{origin:"null"})).status).toBe(403);
  expect(refusals).toHaveLength(14);
  // The refused POST body is read (bounded) before the 403, so the connection stays usable under wrangler dev.
  const unread=new Request("https://app.test/mcp",{method:"POST",headers:{"content-type":"application/json",origin:"https://evil.test"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/list"})});
  expect((await open(unread,{},{})).status).toBe(403);expect(unread.bodyUsed).toBe(true);
  // No Origin is a server-side client: any Host passes, as behind wrangler routes or dev.host (Host rewritten, peer still loopback).
  for(const host of ["app.example.com","evil.example.com"]) expect((await call(open,`http://${host}/mcp`,{host,"cf-connecting-ip":"127.0.0.1"})).status).toBe(200);
  // Loopback Origins pass on any port.
  for(const host of ["localhost:8787","127.0.0.1:3000","[::1]:8787"]) expect((await call(open,"https://app.test/mcp",{origin:`http://${host}`})).status).toBe(200);
  // allowedOrigins lists browser origins by hostname, including the site's own.
  for(const origin of ["https://app.test","https://console.test","http://partner.test:3000","http://localhost:8787"]) expect((await call(listed,"https://app.test/mcp",{origin})).status).toBe(200);
  expect((await call(listed,"https://app.test/mcp",{origin:"https://evil.test"})).status).toBe(403);
  // allowedOrigins is parsed once: full origins and bare hosts pass, anything else fails at configuration.
  expect(()=>mcp({db:()=>db,allowedOrigins:["https://a.test","a.test","localhost:8787","[::1]","http://[::1]:8787"]})).not.toThrow();
  for(const bad of ["https://a.test/mcp","a.test/path","https://","","https://a.test?x=1","https://user@a.test"]) expect(()=>mcp({db:()=>db,allowedOrigins:[bad]})).toThrow(`mcp allowedOrigins: "${bad}"`);
  // Wildcards never match an exact hostname, so they fail at configuration.
  for(const wild of ["*","https://*.example.com","*.example.com"]) expect(()=>mcp({db:()=>db,allowedOrigins:[wild]})).toThrow(`mcp allowedOrigins: "${wild}" is not an origin (https://host[:port]) or a host[:port]; wildcards never match.`);
 } finally {db.close();await rm(dir,{recursive:true,force:true});}
});

test("generated tools carry a title and read/destructive hints; declared hints win",async()=>{
 const text=source+`---
apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: {name: posts}
spec:
  title: Posts
  lifecycle: publishing
  schema: {type: object, properties: {title: {type: string}}, required: [title]}
---
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: {name: posts}
spec: {surface: admin, sql: 'SELECT id, title FROM posts ORDER BY id'}
`+[
  ["rename-item","sql: 'UPDATE items SET title = input.title WHERE id = input.id'",""],
  ["upsert-item","sql: 'INSERT INTO items(id, title) VALUES(input.id, input.title) ON CONFLICT(id) DO UPDATE SET title = excluded.title'",""],
  ["keep-item","sql: 'INSERT INTO items(id, title) VALUES(input.id, input.title) ON CONFLICT(id) DO NOTHING'",""],
  ["purge-items","sql: 'DELETE FROM items WHERE title = input.title'",""],
  ["sendMail","ref: sendMail",""],
  ["lookUp","ref: lookUp","  mcp: {readOnlyHint: true}\n"],
  ["retitle-item","sql: 'UPDATE items SET title = input.title WHERE id = input.id'","  title: Retitle\n  mcp: {destructiveHint: false, openWorldHint: false}\n"],
 ].map(([name,handler,extra])=>`---
apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: {name: ${name}}
spec:
${extra}  input: {type: object, properties: {id: {type: string}, title: {type: string}}, required: [id, title], additionalProperties: false}
  output: {type: object}
  handler: {${handler}}
---
apiVersion: cms.mantle.aotter.net/v2
kind: Trigger
metadata: {name: ${name}-mcp}
spec: {source: {kind: mcp, surface: admin}, target: {procedure: ${name}}}
`).join("");
 const files=await generateOrThrow("bun-sqlite",[{sourceId:"hints.yaml",text}]);
 const dir=await mkdtemp(resolve(import.meta.dir,".mcp-hints-"));
 try {
  await writeGenerated(dir,files);const {tools}=await import(resolve(dir,"mcp.ts"));
  const hints=Object.fromEntries(tools.map((t:any)=>[t.name,[t.title,t.annotations]]));
  expect(hints).toEqual({
   items:["Items",{readOnlyHint:true,destructiveHint:false}],admin_items:["Admin items",{readOnlyHint:true,destructiveHint:false}],
   add_item:["Add item",{readOnlyHint:false,destructiveHint:false}],rename_item:["Rename item",{readOnlyHint:false,destructiveHint:true}],
   upsert_item:["Upsert item",{readOnlyHint:false,destructiveHint:true}],keep_item:["Keep item",{readOnlyHint:false,destructiveHint:false}],
   purge_items:["Purge items",{readOnlyHint:false,destructiveHint:true}],sendmail:["Send mail",{readOnlyHint:false,destructiveHint:true}],
   lookup:["Look up",{readOnlyHint:true,destructiveHint:false}],retitle_item:["Retitle",{readOnlyHint:false,destructiveHint:false,openWorldHint:false}],
   posts:["Posts",{readOnlyHint:true,destructiveHint:false}],publish_posts:["Publish posts",{readOnlyHint:false,destructiveHint:false}],
   unpublish_posts:["Unpublish posts",{readOnlyHint:false,destructiveHint:false}],archive_posts:["Archive posts",{readOnlyHint:false,destructiveHint:true}],
  });
 } finally {await rm(dir,{recursive:true,force:true});}
});

test("MCP SDK stays outside startup, unused surface is tree shaken and static SDK imports are refused",async()=>{
 const {build}=await import("esbuild"); const {guardStartup,startupGraph}=await import("../src/infrastructure/bundle.js");
 const files=await generateOrThrow("cloudflare-d1",[{sourceId:"mcp.yaml",text:source}]);
 const dir=await mkdtemp(resolve(import.meta.dir,".mcp-bundle-"));
 const {writeFile}=await import("node:fs/promises");
 try {
  await writeGenerated(dir,files);const entry=resolve(dir,"worker.ts");await writeFile(entry,'export {mcp} from "./mcp.ts";');
  const result=await build({entryPoints:[entry],outdir:resolve(dir,"out"),bundle:true,splitting:true,format:"esm",platform:"neutral",conditions:["workerd","worker","browser"],external:["node:*"],write:false,metafile:true});
  expect(()=>guardStartup(result.metafile!,entry)).not.toThrow();
  const startup=startupGraph(result.metafile!,entry).flatMap(name=>Object.keys(result.metafile!.outputs[name]!.inputs));
  expect(startup.some(input=>input.endsWith("/kernel/authorization.js"))).toBe(false);
  expect(startup.some(name=>name.includes("@modelcontextprotocol"))).toBe(false);
  expect(startup.some(name=>name.includes("mcp-handler"))).toBe(false);
  expect(startup.some(name=>/host-caller|user-caller/.test(name))).toBe(false);
  expect(Object.keys(result.metafile!.inputs).some(name=>name.includes("@modelcontextprotocol"))).toBe(true);
  await writeFile(entry,'export {McpServer} from "@modelcontextprotocol/server";');
  const eager=await build({entryPoints:[entry],outdir:resolve(dir,"eager"),bundle:true,splitting:true,format:"esm",platform:"neutral",conditions:["workerd","worker","browser"],external:["node:*"],write:false,metafile:true});
  expect(()=>guardStartup(eager.metafile!,entry)).toThrow("request-time");
 }finally {await rm(dir,{recursive:true,force:true});}
});

test("MCP converts validated JSON/boolean input to native SQLite binds",async()=>{
 const text=source.replace('properties: {title: {type: string}}, required: [title]', 'properties: {title: {type: string}, flag: {type: boolean}, payload: {type: object}}, required: [title, flag, payload]').replace('properties: {title: {type: string, minLength: 1}}, required: [title]', 'properties: {title: {type: string, minLength: 1}, flag: {type: boolean}, payload: {type: object}}, required: [title, flag, payload]').replace('INSERT INTO items(title) VALUES(input.title)', 'INSERT INTO items(title, flag, payload) VALUES(input.title, input.flag, input.payload)');
 const files=await generateOrThrow("bun-sqlite",[{sourceId:"json.yaml",text}]);const dir=await mkdtemp(resolve(import.meta.dir,".mcp-bind-")),db=new Database(":memory:");
 try {
  await writeGenerated(dir,files);db.exec(files["schema.sql"]!);const {mcp}=await import(resolve(dir,"mcp.ts"));
  const response=await mcp({db:()=>db,caller:()=>user})(new Request("https://app.test/mcp",{method:"POST",headers:{"content-type":"application/json",accept:"application/json, text/event-stream"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name:"add_item",arguments:{title:"JSON",flag:true,payload:{nested:[1,2]}}}})}),{});
  expect(response.status).toBe(200);const text=await response.text();expect(text).not.toContain('"isError":true');
  expect(db.query("SELECT flag,payload FROM items").get()).toEqual({flag:1,payload:'{"nested":[1,2]}'});
 } finally {db.close();await rm(dir,{recursive:true,force:true});}
});

test("MCP emission is selected by Views/Triggers, not internal queries or publishing alone",async()=>{
 const bare=source.split('---\napiVersion: cms.mantle.aotter.net/v2\nkind: View')[0]!;
 for(const text of [bare,bare.replace('lifecycle: operational','lifecycle: publishing')]) {
  const files=await generateOrThrow("bun-sqlite",[{sourceId:"bare.yaml",text}]);
  expect(files["mcp.ts"]).toBeUndefined();expect(Object.values(files).join('\n')).not.toContain('@modelcontextprotocol');
 }
 const internal=source.split('---\napiVersion: cms.mantle.aotter.net/v2\nkind: Procedure')[0]!.replaceAll('surface: public','surface: internal').replaceAll('surface: admin','surface: internal');
 expect((await generateOrThrow("bun-sqlite",[{sourceId:"internal.yaml",text:internal}]))["mcp.ts"]).toBeUndefined();
});

test("generated publishing transitions are validated admin tools; public Views use SQL visibility",async()=>{
 const text=source.split('---\napiVersion: cms.mantle.aotter.net/v2\nkind: Procedure')[0]!.replace('lifecycle: operational','lifecycle: publishing');
 const files=await generateOrThrow("bun-sqlite",[{sourceId:"publishing-mcp.yaml",text}]);
 const dir=await mkdtemp(resolve(import.meta.dir,".mcp-publishing-")),db=new Database(":memory:");let caller:any={kind:"anonymous"};
 try {
  await writeGenerated(dir,files);db.exec(files["schema.sql"]!);db.exec("INSERT INTO items(id,version,created_at,updated_at,title) VALUES('a',1,0,0,'Draft')");
  const {mcp}=await import(resolve(dir,"mcp.ts"));const handle=mcp({db:()=>db,caller:()=>caller});
  const call=async(method:string,params:any={},path="/mcp/")=>{const response=await handle(new Request("https://app.test"+path,{method:"POST",headers:{"content-type":"application/json",accept:"application/json, text/event-stream"},body:JSON.stringify({jsonrpc:"2.0",id:1,method,params})}),{});const text=await response.text();return JSON.parse(text.startsWith("event:")?text.split("data: ")[1].split("\n")[0]:text);};
  expect((await call("tools/list")).result.tools.map((tool:any)=>tool.name)).toEqual(["items"]);
  expect((await call("tools/call",{name:"items",arguments:{}})).result.structuredContent.rows).toEqual([]);
  caller=user;const admin=await call("tools/list",{},"/mcp/admin/");
  expect(admin.result.tools.map((tool:any)=>tool.name)).toEqual(["admin_items","publish_items","unpublish_items","archive_items"]);
  expect(admin.result.tools.find((tool:any)=>tool.name==='publish_items').inputSchema).toMatchObject({required:['id','expectedVersion'],additionalProperties:false});
  const invalid=await call("tools/call",{name:"publish_items",arguments:{id:"a",expectedVersion:"1"}},"/mcp/admin/");expect(JSON.parse(invalid.result.content[0].text).diagnostics[0].code).toBe("INPUT_VALIDATION_FAILED");
  const publish=await call("tools/call",{name:"publish_items",arguments:{id:"a",expectedVersion:1}},"/mcp/admin/");expect(publish.result.structuredContent.results[0][0].status).toBe('published');
  caller={kind:"anonymous"};expect((await call("tools/call",{name:"items",arguments:{}})).result.structuredContent.rows.map((row:any)=>row.id)).toEqual(['a']);
  caller=user;for(const [name,version,status] of [['unpublish_items',2,'draft'],['archive_items',3,'archived']]) expect((await call('tools/call',{name,arguments:{id:'a',expectedVersion:version}},'/mcp/admin/')).result.structuredContent.results[0][0].status).toBe(status);
 } finally {db.close();await rm(dir,{recursive:true,force:true});}
});

test("ref MCP Procedures require typed caller-owned handlers and enforce requires before dispatch",async()=>{
 const text=source.replace("handler: {sql: 'INSERT INTO items(title) VALUES(input.title) RETURNING id'}",'requires: {auth: {all: [ctx.user, ctx.admin, {ctx.auth.scope: items:write}]}}\n  handler: {ref: app.addItem}');
 const files=await generateOrThrow("bun-sqlite",[{sourceId:"ref-mcp.yaml",text}]);const dir=await mkdtemp(resolve(import.meta.dir,".mcp-ref-")),db=new Database(":memory:");
 let caller:any=sdkFixtureCaller(user),calls=0;
 try {
  await writeGenerated(dir,files,false);db.exec(files["schema.sql"]!);const {mcp}=await import(resolve(dir,"mcp.ts"));
  const handle=mcp({db:()=>db,caller:()=>caller,handlers:{'add-item':async(ctx:any,input:any)=>{calls++;expect(ctx.caller.subject).toBe('u');await ctx.store.collection('items').insert(input);return {title:input.title};}}});
  const call=async()=>{const response=await handle(new Request('https://app.test/mcp',{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'add_item',arguments:{title:'Ref'}}})}),{});const text=await response.text();return {response,data:JSON.parse(text.startsWith('event:')?text.split('data: ')[1].split('\n')[0]:text)};};
  const scopeDenied=await call();expect(scopeDenied.response.status).toBe(403);expect(scopeDenied.response.headers.get('www-authenticate')).toContain('items:write');expect(calls).toBe(0);
  caller=sdkFixtureCaller({...user,scopes:['mcp','items:write'],role:'contributor',admin:false});expect((await call()).data.result.isError).toBe(true);expect(calls).toBe(0);
  caller=sdkFixtureCaller({...user,scopes:['mcp','items:write']});expect((await call()).data.result.structuredContent).toEqual({title:'Ref'});expect(calls).toBe(1);

 } finally {db.close();await rm(dir,{recursive:true,force:true});}
});

test("unknown tool and caller failures log the surface and original error, redact responses and never challenge a resolver exception",async()=>{
 const files=await generateOrThrow("bun-sqlite",[{sourceId:"errors.yaml",text:source}]);const dir=await mkdtemp(resolve(import.meta.dir,".mcp-errors-"));
 const logging=spyOn(console,'error').mockImplementation(()=>{}),token='unlogged-bearer-secret',cause=new Error('hidden database failure', {cause: new Error('database cause')});
 try {
  await writeGenerated(dir,files);const {mcp}=await import(resolve(dir,"mcp.ts"));const request=()=>new Request('https://app.test/mcp',{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream',authorization:'Bearer '+token},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'items',arguments:{}}})});
  const response=await mcp({db:()=>({query(){throw cause;}}),caller:()=>({kind:'anonymous'})})(request(),{});
  const body=await response.text();expect(body).toContain('INTERNAL_ERROR');expect(body).not.toContain(cause.message);expect(logging.mock.calls[0]).toEqual(["[mantle mcp items] unhandled failure",cause]);
  const thrown=new Error('application caller failed', {cause: new Error('caller cause')});const failure=await mcp({db:()=>({}),caller:()=>{throw thrown;}})(request(),{});
  expect(failure.status).toBe(500);expect(failure.headers.has('www-authenticate')).toBe(false);expect(await failure.text()).not.toContain(thrown.message);
  expect(logging.mock.calls).toHaveLength(2);expect(logging.mock.calls[1]![0]).toBe("[mantle mcp /mcp] unhandled failure");expect((logging.mock.calls[1]![1] as Error).cause).toBe(thrown);expect(logging.mock.calls.flat().map(String).join(' ')).not.toContain(token);
 } finally {logging.mockRestore();await rm(dir,{recursive:true,force:true});}
});

test("canonical publishing tool names refuse a colliding declared admin Procedure",async()=>{
 const text=source.split('---\napiVersion: cms.mantle.aotter.net/v2\nkind: Procedure')[0]!.replace('lifecycle: operational','lifecycle: publishing')+`---
apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: {name: publish-items}
spec: {input: {type: object}, output: {type: object}, handler: {ref: app.publishItems}}
---
apiVersion: cms.mantle.aotter.net/v2
kind: Trigger
metadata: {name: publish-items-mcp}
spec: {source: {kind: mcp, surface: admin}, target: {procedure: publish-items}}
`;
 const {generateFromSources}=await import('../src/infrastructure/generate.js');
 const result=await generateFromSources({target:'bun-sqlite',sources:{sources:[{sourceId:'collision.yaml',text}]}});
 expect(result).toMatchObject({ok:false,diagnostics:[{code:'GENERATE_UNSUPPORTED',path:'procedures/items.publish',message:'MCP tool name publish_items collides on admin.'}]});
});

test("MCP parity advertises localized metadata and native SQL output; callbacks cannot change execution",async()=>{
 const text=source.replace("spec: {surface: public, sql:","spec: {title: {en: Items, zh: 項目}, surface: public, sql:").replace("  output: {type: object}","  title: {en: Add item, zh: 新增項目}\n  description: {en: Add a row, zh: 新增資料}\n  mcp: {readOnlyHint: false, destructiveHint: true, openWorldHint: false}\n  output: {type: object}");
 const files=await generateOrThrow('bun-sqlite',[{sourceId:'parity.yaml',text}]);const dir=await mkdtemp(resolve(import.meta.dir,'.mcp-parity-')),db=new Database(':memory:');
 let caller:any=fixtureCaller({...user,scopes:['custom']});const observations:any[]=[],refusals:any[]=[];
 try {
  await writeGenerated(dir,files);db.exec(files['schema.sql']!);const {mcp}=await import(resolve(dir,'mcp.ts'));
  const handle=mcp({db:()=>db,caller:()=>caller,locale:'zh',instructions:'Use these tools.',serverInfo:{name:'example',title:'Example',version:'7'},requiredScopes:['custom'],resourceMetadata:'https://proxy.test/resource',onObservation:(event:any)=>{observations.push(event);if(event.kind==='invocation'){expect(Object.isFrozen(event.caller)).toBe(true);expect(Object.isFrozen(event.caller.scopes)).toBe(true);}return Promise.reject(new Error('ignored listener'));},onRefusal:(event:any)=>{refusals.push(event);throw Error('ignored listener');}});
  const call=async(method:string,params:any={},path='/mcp',headers:any={})=>{const response=await handle(new Request('https://app.test'+path,{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream',...headers},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})}),{});const body=await response.text();return {response,data:JSON.parse(body.startsWith('event:')?body.split('data: ')[1].split('\n')[0]:body)};};
  const init=await call('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'test',version:'1'}});expect(init.data.result.instructions).toBe('Use these tools.');expect(init.data.result.serverInfo).toMatchObject({name:'example',version:'7'});
  const listed=(await call('tools/list')).data.result.tools;
  expect(listed[0]).toMatchObject({title:'項目',description:expect.stringMatching(/^項目 \(tool version [0-9a-f]{8}\)$/),annotations:{readOnlyHint:true}});
  expect(listed[1]).toMatchObject({title:'新增項目',description:expect.stringMatching(/^新增資料 \(tool version [0-9a-f]{8}\)$/),annotations:{destructiveHint:true},outputSchema:{required:['results']}});
  const ok=await call('tools/call',{name:'add_item',arguments:{title:'Works'}});expect(ok.data.result.structuredContent.results[0][0].id).toBeString();
  const bad=await call('tools/call',{name:'add_item',arguments:{title:''}});expect(bad.data.result.isError).toBe(true);expect(bad.data.result.structuredContent).toBeUndefined();
  expect(observations.filter(event=>event.phase==='completion').map(event=>event.outcome)).toEqual(['succeeded','failed']);
  caller=fixtureCaller({...user,scopes:[]});const denied=await call('tools/list');expect(denied.response.status).toBe(403);expect(denied.response.headers.get('www-authenticate')).toContain('scope="custom"');expect(denied.response.headers.get('www-authenticate')).toContain('resource_metadata="https://proxy.test/resource"');
  caller={kind:'anonymous'};expect((await call('initialize',{},'/mcp/admin')).response.headers.get('www-authenticate')).toContain('resource_metadata="https://proxy.test/resource"');
  caller=fixtureCaller({...user,credential:'session'});await call('tools/call',{name:'add_item',arguments:{title:'CSRF'}},'/mcp',{origin:'https://evil.test'});
  expect(refusals.map(event=>event.reason)).toEqual(['credential','credential','origin']);expect(db.query('SELECT COUNT(*) n FROM items').get()).toEqual({n:1});
  for(const locale of [undefined,'constructor','toString','fr']) {
   const response=await mcp({db:()=>db,caller:()=>caller,locale})(new Request('https://app.test/mcp',{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})}),{});
   const body=await response.text(),data=JSON.parse(body.startsWith('event:')?body.split('data: ')[1].split('\n')[0]:body);expect(data.result.tools[0].title).toBe('Items');expect(data.result.tools[1].description).toStartWith('Add a row (tool version ');
  }
 } finally {db.close();await rm(dir,{recursive:true,force:true});}
});

test("MCP preflights all batch calls before any work and reports expired caller challenges",async()=>{
 const {mcp}=await import('../src/kernel/mcp.js');const {ContractError}=await import('../src/kernel/contracts.js');let runs=0;
 const tools=[{name:'open',surface:'public',description:'Open',inputSchema:{type:'object'},validate:(raw:any)=>raw,run:async()=>{runs++;return{};}},{name:'closed',surface:'public',description:'Closed',closed:true,scopes:['write'],inputSchema:{type:'object'},validate:(raw:any)=>raw,run:async()=>{runs++;return{};}}];
 const request=(body:any)=>new Request('https://app.test/mcp',{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify(body)});
 const handle=mcp(tools,{db:()=>({}),caller:()=>({kind:'anonymous'})});
 const response=await handle(request(['open','closed'].map((name,id)=>({jsonrpc:'2.0',id,method:'tools/call',params:{name,arguments:{}}}))),{});expect(response!.status).toBe(401);expect(runs).toBe(0);expect(response!.headers.get('www-authenticate')).toContain('scope="mcp write"');
 const expired=await mcp(tools,{db:()=>({}),caller:()=>{throw new ContractError('UNAUTHENTICATED','Expired.','request:authorization');},resourceMetadata:'https://proxy.test/metadata'})(request({jsonrpc:'2.0',id:1,method:'tools/list'}),{});expect(expired!.status).toBe(401);expect(expired!.headers.get('www-authenticate')).toContain('resource_metadata="https://proxy.test/metadata"');
});

test("MCP tools advertise input rules as description sentences and enforce them",async()=>{
 const text=source+`---
apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: {name: log-item}
spec:
  description: Log an item.
  input: {type: object, properties: {title: {type: string}, weight: {type: number}, unit: {type: string}}, dependentRequired: {weight: [unit]}, anyOf: [{required: [title]}, {required: [weight]}], additionalProperties: false}
  output: {type: object}
  handler: {sql: 'INSERT INTO items(title) VALUES(input.title) RETURNING id'}
---
apiVersion: cms.mantle.aotter.net/v2
kind: Trigger
metadata: {name: log-item-mcp}
spec: {source: {kind: mcp, surface: public}, target: {procedure: log-item}}
`;
 const files=await generateOrThrow('bun-sqlite',[{sourceId:'rules.yaml',text}]);const dir=await mkdtemp(resolve(import.meta.dir,'.mcp-rules-')),db=new Database(':memory:');
 try {
  await writeGenerated(dir,files);db.exec(files['schema.sql']!);const {mcp}=await import(resolve(dir,'mcp.ts'));
  const handle=mcp({db:()=>db,caller:()=>({kind:'anonymous'})});
  const call=async(method:string,params:any={})=>{const response=await handle(new Request('https://app.test/mcp',{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})}),{});const body=await response.text();return JSON.parse(body.startsWith('event:')?body.split('data: ')[1].split('\n')[0]:body);};
  const tool=(await call('tools/list')).result.tools.find((t:any)=>t.name==='log_item');
  expect(tool.description).toMatch(/^Log an item\. 'unit' is required when 'weight' is present\. At least one of 'title', 'weight' is required\. \(tool version [0-9a-f]{8}\)$/);
  expect(Object.keys(tool.inputSchema).sort()).toEqual(['additionalProperties','properties','type']);
  const bad=await call('tools/call',{name:'log_item',arguments:{title:'A',weight:1}});
  expect(JSON.parse(bad.result.content[0].text).diagnostics[0]).toMatchObject({code:'INPUT_VALIDATION_FAILED',path:'procedures/log-item/input/unit',message:"'unit' is required when 'weight' is present."});
  expect((await call('tools/call',{name:'log_item',arguments:{title:'A'}})).result.isError).toBeUndefined();
 } finally {db.close();await rm(dir,{recursive:true,force:true});}
});

test("An anonymous closed surface challenges from initialize; an open tool or a signed-in caller does not",async()=>{
 const {mcp}=await import('../src/kernel/mcp.js');const {user}=await import('./apps/fixtures.js');
 const tool=(name:string,closed?:boolean)=>({name,surface:'public',description:name,...(closed?{closed:true}:{}),inputSchema:{type:'object'},validate:(raw:any)=>raw,run:async()=>({})});
 const post=(handle:any,method:string,params:any={})=>handle(new Request('https://app.test/mcp',{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})}),{});
 const init={protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'t',version:'1'}};
 const allClosed=(caller:any)=>mcp([tool('a',true),tool('b',true)],{db:()=>({}),caller:()=>caller,authorize:()=>true});
 const challenged=await post(allClosed({kind:'anonymous'}),'initialize',init);
 expect(challenged!.status).toBe(401);expect(challenged!.headers.get('www-authenticate')).toMatch(/^Bearer .*scope="mcp"/);
 expect((await post(allClosed(user('person')),'initialize',init))!.status).toBe(200);
 const mixed=mcp([tool('open'),tool('closed',true)],{db:()=>({}),caller:()=>({kind:'anonymous'}),authorize:()=>true});
 expect((await post(mixed,'initialize',init))!.status).toBe(200);
 const listed=await post(mixed,'tools/list');expect(listed!.status).toBe(200);
 expect(((await listed!.text()).match(/"name":"(\w+)"/g)??[]).join()).toBe('"name":"open"');
});

test("Tool.meta lists visibility, App template and file params; withResultMeta keeps its meta out of content",async()=>{
 const {mcp,withResultMeta,callTool}=await import('../src/kernel/mcp.js');
 const secret='https://upload.test/put?signature=SECRET';
 const tool=(name:string,extra:any={})=>({name,surface:'public',description:name,inputSchema:{type:'object'},validate:(raw:any)=>raw,run:async()=>({ok:true}),...extra});
 const tools=[
  tool('model',{meta:{ui:{visibility:['model']},'openai/fileParams':['image']}}),
  tool('both',{meta:{ui:{visibility:['model','app']}}}),
  tool('app',{meta:{ui:{visibility:['app']}}}),
  tool('card',{meta:{ui:{resourceUri:'ui://app/card'},'openai/outputTemplate':'ui://app/card'}}),
  tool('sign',{meta:{ui:{visibility:['app']}},run:async()=>withResultMeta({id:'u1'},{uploadUrl:secret,requiredHeaders:{'content-type':'image/png'},'net.aotter.mantle/tool':'other'})}),
  tool('fail',{run:async()=>{throw new Error('boom');}}),
  tool('plain'),
 ];
 const handle=mcp(tools,{db:()=>({}),caller:()=>({kind:'anonymous'})});
 const ui={'io.modelcontextprotocol/clientCapabilities':{extensions:{'io.modelcontextprotocol/ui':{mimeTypes:['text/html;profile=mcp-app']}}}};
 const call=async(method:string,params:any={},api:any=handle)=>{const response=await api(new Request('https://app.test/mcp',{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})}),{});const body=await response.text();return JSON.parse(body.startsWith('event:')?body.split('data: ')[1].split('\n')[0]:body);};
 const listed=(await call('tools/list',{_meta:ui})).result.tools,meta=Object.fromEntries(listed.map((t:any)=>[t.name,t._meta]));
 expect(meta).toEqual({model:{ui:{visibility:['model']},'openai/fileParams':['image']},both:{ui:{visibility:['model','app']}},app:{ui:{visibility:['app']}},card:{ui:{resourceUri:'ui://app/card'},'openai/outputTemplate':'ui://app/card'},sign:{ui:{visibility:['app']}},fail:undefined,plain:undefined});
 expect((await call('tools/list',{_meta:{'io.modelcontextprotocol/clientCapabilities':{}}})).result.tools.map((t:any)=>t.name)).toEqual(['model','both','card','fail','plain']);
 const signed=(await call('tools/call',{name:'sign',arguments:{},_meta:ui})).result;
 expect(signed.content).toEqual([{type:'text',text:'{"id":"u1"}'}]);expect(signed.structuredContent).toEqual({id:'u1'});
 expect(signed._meta).toEqual({uploadUrl:secret,requiredHeaders:{'content-type':'image/png'},'net.aotter.mantle/tool':'sign'});
 expect(JSON.stringify({...signed,_meta:undefined})).not.toContain('SECRET');
 const failed=(await call('tools/call',{name:'fail',arguments:{}})).result;
 expect(Object.keys(failed).sort()).toEqual(['content','isError','structuredContent']);expect(failed.structuredContent.diagnostics[0].code).toBe('INTERNAL_ERROR');
 expect((await call('tools/call',{name:'plain',arguments:{}})).result).toEqual({content:[{type:'text',text:'{"ok":true}'}],structuredContent:{ok:true}});
 const direct:any=await callTool(tools[4] as any,{},{},{kind:'anonymous'},undefined as never);
 expect(direct.data).toEqual({id:'u1'});expect(direct._meta.uploadUrl).toBe(secret);expect(JSON.stringify(direct.data)).not.toContain('SECRET');
});

test("tools/list pages with toolsPageSize and an opaque cursor bound to the catalogue; the default is one page",async()=>{
 const {mcp}=await import('../src/kernel/mcp.js');
 const table=(names:string[])=>names.map(name=>({name,surface:'public',description:name,inputSchema:{type:'object'},validate:(raw:any)=>raw,run:async()=>({})}));
 const options={db:()=>({}),caller:()=>({kind:'anonymous'}) as const};
 const call=async(api:any,params:any={})=>{const response=await api(new Request('https://app.test/mcp',{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list',params})}),{});const body=await response.text();return JSON.parse(body.startsWith('event:')?body.split('data: ')[1].split('\n')[0]:body);};
 const whole=(await call(mcp(table(['a','b','c','d','e']),options))).result;expect(whole.tools.length).toBe(5);expect(whole.nextCursor).toBeUndefined();
 const paged=mcp(table(['a','b','c','d','e']),{...options,toolsPageSize:2}),names:string[][]=[];
 let cursor:string|undefined;
 do { const page=(await call(paged,cursor?{cursor}:{})).result;names.push(page.tools.map((t:any)=>t.name));cursor=page.nextCursor; } while(cursor);
 expect(names).toEqual([['a','b'],['c','d'],['e']]);
 const first=(await call(paged)).result.nextCursor;
 expect((await call(paged,{cursor:first})).result.tools.map((t:any)=>t.name)).toEqual(['c','d']);
 for(const bad of ['nope',first.replace(/:\d+$/,':3'),first.replace(/:\d+$/,':6')]) expect((await call(paged,{cursor:bad})).error.code).toBe(-32602);
 expect((await call(mcp(table(['a','b','c','x']),{...options,toolsPageSize:2}),{cursor:first})).error.code).toBe(-32602);
});
