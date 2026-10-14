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
  const ok=await call("tools/call",{name:"add_item",arguments:{title:"Hello"}});expect(ok.data.result.isError).toBeUndefined();expect(ok.readOnly).toBe(false);
  const page=await call("tools/call",{name:"items",arguments:{limit:1}});expect(page.data.result.structuredContent.rows[0].title).toBe("Hello");expect(page.readOnly).toBe(true);
  caller=user;expect((await call("tools/list",{},"/mcp/admin")).data.result.tools.map((t:any)=>t.name)).toEqual(["admin_items"]);
  caller=fixtureCaller({...user,role:null,admin:false}); const roleDenied=await call("tools/list",{},"/mcp/admin");expect(roleDenied.response.status).toBe(403);expect(roleDenied.response.headers.has("www-authenticate")).toBe(false);
  caller=fixtureCaller({...user,scopes:[]}); const scopeDenied=await call("tools/list");expect(scopeDenied.response.status).toBe(403);expect(scopeDenied.response.headers.get("www-authenticate")).toContain('error="insufficient_scope", scope="mcp"');
  caller=fixtureCaller({...user,credential:"session"});expect((await call("tools/call",{name:"add_item",arguments:{title:"CSRF"}},"/mcp",{origin:"https://evil.test"})).data.result.isError).toBe(true);
  expect(db.query("SELECT COUNT(*) n FROM items").get()).toEqual({n:1});
  expect(await handle(new Request("https://app.test/other"),{})).toBeUndefined();
 } finally {db.close();await rm(dir,{recursive:true,force:true});}
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
  expect(startup.some(name=>name.includes("@modelcontextprotocol"))).toBe(false);
  expect(startup.some(name=>name.includes("mcp-handler"))).toBe(false);
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
  const {default:ts}=await import('typescript');const {writeFile}=await import('node:fs/promises');const usage=resolve(dir,'usage.ts');
  await writeFile(usage,`import {mcp} from './mcp.js';\nconst options={db:()=>({} as never),caller:()=>({kind:'anonymous' as const})};\n// @ts-expect-error ref handlers are required\nmcp(options);\nmcp({...options,handlers:{'add-item':async(ctx,input)=>{ctx.store.collection('items');return {title:input.title};}}});\n// @ts-expect-error wrong ref key\nmcp({...options,handlers:{wrong:async()=>({})}});\n`);
  const program=ts.createProgram([usage],{strict:true,target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.NodeNext,moduleResolution:ts.ModuleResolutionKind.NodeNext,skipLibCheck:true,types:[],noEmit:true});
  expect(ts.getPreEmitDiagnostics(program).map(d=>ts.flattenDiagnosticMessageText(d.messageText,' '))).toEqual([]);
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
  const init=await call('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'test',version:'1'}});expect(init.data.result.instructions).toBe('Use these tools.');expect(init.data.result.serverInfo.name).toBe('example');
  const listed=(await call('tools/list')).data.result.tools;
  expect(listed[0]).toMatchObject({title:'項目',description:'項目',annotations:{readOnlyHint:true}});
  expect(listed[1]).toMatchObject({title:'新增項目',description:'新增資料',annotations:{destructiveHint:true},outputSchema:{required:['results']}});
  const ok=await call('tools/call',{name:'add_item',arguments:{title:'Works'}});expect(ok.data.result.structuredContent.results[0][0].id).toBeString();
  const bad=await call('tools/call',{name:'add_item',arguments:{title:''}});expect(bad.data.result.isError).toBe(true);expect(bad.data.result.structuredContent).toBeUndefined();
  expect(observations.filter(event=>event.phase==='completion').map(event=>event.outcome)).toEqual(['succeeded','failed']);
  caller=fixtureCaller({...user,scopes:[]});const denied=await call('tools/list');expect(denied.response.status).toBe(403);expect(denied.response.headers.get('www-authenticate')).toContain('scope="custom"');expect(denied.response.headers.get('www-authenticate')).toContain('resource_metadata="https://proxy.test/resource"');
  caller={kind:'anonymous'};expect((await call('initialize',{},'/mcp/admin')).response.headers.get('www-authenticate')).toContain('resource_metadata="https://proxy.test/resource"');
  caller=fixtureCaller({...user,credential:'session'});await call('tools/call',{name:'add_item',arguments:{title:'CSRF'}},'/mcp',{origin:'https://evil.test'});
  expect(refusals.map(event=>event.reason)).toEqual(['credential','credential','origin']);expect(db.query('SELECT COUNT(*) n FROM items').get()).toEqual({n:1});
  for(const locale of [undefined,'constructor','toString','fr']) {
   const response=await mcp({db:()=>db,caller:()=>caller,locale})(new Request('https://app.test/mcp',{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})}),{});
   const body=await response.text(),data=JSON.parse(body.startsWith('event:')?body.split('data: ')[1].split('\n')[0]:body);expect(data.result.tools[0].title).toBe('Items');expect(data.result.tools[1].description).toBe('Add a row');
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
