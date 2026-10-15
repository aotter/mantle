import {expect,test} from "bun:test";
import {Database} from "bun:sqlite";
import {resolve} from "node:path";
import {mkdtemp,rm} from "node:fs/promises";
import {Client,StreamableHTTPClientTransport} from "@modelcontextprotocol/client";
import {generateOrThrow,writeGenerated} from "./apps/link.js";
import {fixtureCaller} from "./apps/fixtures.js";
import {gatewaySource,mantleProps,pinned} from "./gateway-fixture.js";
import {mcp as serveMcp} from "../src/kernel/mcp.js";
import {generateFromSources} from "../src/infrastructure/generate.js";
import {versionOf} from "../src/usecase/tool-version.js";
const source=`apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: {name: items}
spec:
  title: Items
  lifecycle: operational
  schema: {type: object, properties: {title: {type: string}}, required: [title]}
---
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
metadata: {name: items}
spec: {surface: public, description: List items, sql: 'SELECT id, title FROM items ORDER BY id'}
---
apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: {name: add-item}
spec:
  description: Add an item
  input: {type: object, properties: {title: {type: string, minLength: 1}}, required: [title], additionalProperties: false}
  output: {type: object}
  handler: {sql: 'INSERT INTO items(title) VALUES(input.title) RETURNING id'}
---
apiVersion: cms.mantle.aotter.net/v2
kind: Trigger
metadata: {name: add-item-mcp}
spec: {source: {kind: mcp, surface: public}, target: {procedure: add-item}}
`;
const versions=(mcp:string)=>Object.fromEntries([...mcp.matchAll(/name: "(\w+)".*version: "([0-9a-f]{8})" },$/gm)].map(([,name,version])=>[name,version]));
/** The catalogue version an endpoint reports: a hash of the tools it serves. */
const catalogue=(tools:readonly {surface:string;name:string;version?:string}[],surface="public")=>versionOf(tools.filter(t=>t.surface===surface).map(t=>`${t.surface}:${t.name}:${t.version??""}`).sort());

test("a tool's version and description change only with its own definition; the app version with any",async()=>{
 const first=(await generateOrThrow("bun-sqlite",[{sourceId:"v.yaml",text:source}]))["mcp.ts"]!,again=(await generateOrThrow("bun-sqlite",[{sourceId:"v.yaml",text:source}]))["mcp.ts"]!;
 expect(again).toBe(first);
 const before=versions(first);expect(Object.keys(before)).toEqual(["items","add_item","publish_posts","unpublish_posts","archive_posts"]);
 expect(first).toContain(`description: "List items (tool version ${before.items})"`);
 const edited=(await generateOrThrow("bun-sqlite",[{sourceId:"v.yaml",text:source.replace("description: Add an item","description: Add one item")}]))["mcp.ts"]!,after=versions(edited);
 expect(after.add_item).not.toBe(before.add_item);expect({...after,add_item:before.add_item}).toEqual(before);
 expect(edited.split("\n").filter(line=>line.includes('name: "items"'))).toEqual(first.split("\n").filter(line=>line.includes('name: "items"')));
});

test("official client on both protocol eras sees version markers, versioned results and the input contract on failure",async()=>{
 const files=await generateOrThrow("bun-sqlite",[{sourceId:"v.yaml",text:source}]),listed=versions(files["mcp.ts"]!);
 const dir=await mkdtemp(resolve(import.meta.dir,".mcp-versions-")),db=new Database(":memory:");
 try {
  await writeGenerated(dir,files);db.exec(files["schema.sql"]!);
  const {mcp,tools:generated}=await import(resolve(dir,"mcp.ts"));const handle=mcp({db:()=>db,caller:()=>({kind:"anonymous"})});
  for(const mode of ["legacy",{pin:"2026-07-28"}] as const) {
   const client=new Client({name:"test",version:"1"},{versionNegotiation:{mode}});
   await client.connect(new StreamableHTTPClientTransport(new URL("https://app.test/mcp"),{fetch:async(url,init)=>(await handle(new Request(String(url),init),{}))!}));
   if(mode==="legacy") expect(client.getNegotiatedProtocolVersion()).not.toBe("2026-07-28"); else expect(client.getNegotiatedProtocolVersion()).toBe("2026-07-28");
   expect(client.getServerVersion()).toMatchObject({name:"aotter.mantle",version:catalogue(generated)});
   const {tools}=await client.listTools();
   for(const tool of tools) expect(tool.description).toEndWith(` (tool version ${listed[tool.name]})`);
   const ok=await client.callTool({name:"add_item",arguments:{title:"Hello"}});
   expect(ok.isError).toBeFalsy();expect(ok.structuredContent).toBeDefined();expect(ok.content).toEqual([expect.objectContaining({type:"text"}),{type:"text",text:`tool version ${listed.add_item}`}]);
   const page=await client.callTool({name:"items",arguments:{limit:1}});expect((page.content as {text:string}[])[1]!.text).toBe(`tool version ${listed.items}`);
   const bad=await client.callTool({name:"add_item",arguments:{title:""}});expect(bad.isError).toBe(true);
   const about=(bad.content as {text:string}[])[1]!.text;expect(about).toStartWith(`tool version ${listed.add_item}; input schema `);expect(JSON.parse(about.slice(about.indexOf("{")))).toMatchObject({required:["title"],properties:{title:{type:"string",minLength:1}}});
   await client.close();
  }
 } finally {db.close();await rm(dir,{recursive:true,force:true});}
});

const eras=["legacy",{pin:"2026-07-28"}] as const;
const connect=async(handle:(request:Request,env:unknown)=>Promise<Response|undefined>,mode:typeof eras[number],path="/mcp",headers:Record<string,string>={})=>{
 const client=new Client({name:"test",version:"1"},{versionNegotiation:{mode}});
 await client.connect(new StreamableHTTPClientTransport(new URL("https://app.test"+path),{fetch:async(url,init)=>{const request=new Request(String(url),init);for(const [k,v] of Object.entries(headers))request.headers.set(k,v);return (await handle(request,{}))!;}}));
 if(mode==="legacy") expect(client.getNegotiatedProtocolVersion()).not.toBe("2026-07-28"); else expect(client.getNegotiatedProtocolVersion()).toBe("2026-07-28");
 return client;
};
/** What tools/list returns, without the marker, hashes to the version the marker advertises. */
const expectListedHashes=(tools:readonly {name:string;title?:string;description?:string;inputSchema:unknown;outputSchema?:unknown;annotations?:unknown}[])=>{
 expect(tools.length).toBeGreaterThan(0);
 for(const {name,title,description,inputSchema,outputSchema,annotations} of tools){
  const [,text,version]=/^(.*) \(tool version ([0-9a-f]{8})\)$/s.exec(description!)!;
  expect([name,versionOf({name,title,description:text,inputSchema,outputSchema,annotations})]).toEqual([name,version!]);
 }
};
const withApp=async(files:Readonly<Record<string,string>>,run:(mcp:any,db:Database,tools:any[],dir:string)=>Promise<void>)=>{
 const dir=await mkdtemp(resolve(import.meta.dir,".mcp-versions-")),db=new Database(":memory:");
 try {await writeGenerated(dir,files);db.exec(files["schema.sql"]!);const generated=await import(resolve(dir,"mcp.ts"));await run(generated.mcp,db,generated.tools,dir);}
 finally {db.close();await rm(dir,{recursive:true,force:true});}
};

test("what tools/list returns hashes to the version it advertises, View paging included",async()=>{
 await withApp(await generateOrThrow("bun-sqlite",[{sourceId:"v.yaml",text:source}]),async(mcp,db)=>{
  const handle=mcp({db:()=>db,caller:()=>({kind:"anonymous"})});
  for(const mode of eras){const client=await connect(handle,mode);const {tools}=await client.listTools();expect(tools.find(t=>t.name==="items")!.inputSchema.properties).toHaveProperty("limit");expectListedHashes(tools);await client.close();}
 });
});

test("a call naming a tool the catalogue lacks gets the spec's unknown-tool error with the catalogue version, on both eras",async()=>{
 const files=await generateOrThrow("bun-sqlite",[{sourceId:"v.yaml",text:source}]);
 await withApp(files,async(mcp,db,tools)=>{
  const handle=mcp({db:()=>db,caller:()=>({kind:"anonymous"})});
  for(const mode of eras){
   const client=await connect(handle,mode);
   const refused=await client.callTool({name:"add_items",arguments:{title:"x"}}).then(()=>undefined,(error:unknown)=>error as {code:number;message:string});
   expect(refused?.code).toBe(-32602);
   expect(refused?.message).toContain(`No tool named "add_items" exists in the current catalogue (catalogue version ${catalogue(tools)}).`);
   expect((await client.callTool({name:"add_item",arguments:{title:"x"}})).isError).toBeFalsy();
   await client.close();
  }
  // An application's own serverInfo.version is the catalogue version it reports.
  const own=await connect(mcp({db:()=>db,caller:()=>({kind:"anonymous"}),serverInfo:{version:"7.1.0"}}),"legacy");
  expect(await own.callTool({name:"gone",arguments:{}}).then(()=>"",(error:Error)=>error.message)).toContain("(catalogue version 7.1.0)");
  await own.close();
 });
});

test("/mcp/admin over the official client: publishing and media tools carry markers, versioned results and the contract on failure",async()=>{
 const generated=await generateFromSources({target:"bun-sqlite",sources:{sources:[{sourceId:"v.yaml",text:source}]},site:{media:{purposes:[{name:"cover",required:["png"],maxBytes:{"image/png":100}}]}}});
 if(!generated.ok) throw Error(JSON.stringify(generated.diagnostics));
 const admin=fixtureCaller({kind:"user",subject:"u",role:"admin",admin:true,scopes:["mcp"],credential:"session",credentialId:null,clientId:null});
 const storage={async createUpload(){throw Error("unused");},async commitUpload(){throw Error("unused");},async deleteObject(){}};
 await withApp(generated.files,async(mcp,db)=>{
  const handle=mcp({db:()=>db,caller:()=>admin,media:()=>storage});
  for(const mode of eras){
   const client=await connect(handle,mode,"/mcp/admin",{cookie:"fixture=1",origin:"https://app.test"});
   const {tools}=await client.listTools(),version=(name:string)=>/\(tool version ([0-9a-f]{8})\)$/.exec(tools.find(t=>t.name===name)!.description!)![1];
   expect(tools.map(t=>t.name)).toEqual(expect.arrayContaining(["publish_posts","archive_posts","get_media_upload_policy","create_media_upload"]));
   expectListedHashes(tools);
   const policy=await client.callTool({name:"get_media_upload_policy",arguments:{}});
   expect(policy.isError).toBeFalsy();expect((policy.content as {type:string;text:string}[])[1]).toEqual({type:"text",text:`tool version ${version("get_media_upload_policy")}`});
   for(const [name,args] of [["publish_posts",{id:"",expectedVersion:1}],["create_media_upload",{filename:"x"}]] as const){
    const bad=await client.callTool({name,arguments:args});expect(bad.isError).toBe(true);
    const about=(bad.content as {text:string}[])[1]!.text;expect(about).toStartWith(`tool version ${version(name)}; input schema `);
    expect(JSON.parse(about.slice(about.indexOf("{")))).toEqual(tools.find(t=>t.name===name)!.inputSchema);
   }
   await client.close();
  }
 });
});

test("the kernel wired as the templates wire it reports the served catalogue's version, not a fixed one, on both eras",async()=>{
 const versionsOf=async(text:string)=>{let seen:string[]=[];await withApp(await generateOrThrow("bun-sqlite",[{sourceId:"v.yaml",text}]),async(mcp,db,tools)=>{
  // app-shell and reference-service: the generated tools straight into the kernel's mcp().
  const options={db:()=>db,caller:()=>({kind:"anonymous" as const})},kernel=serveMcp(tools,options),generated=mcp(options);
  for(const mode of eras){
   const client=await connect(kernel,mode),version=client.getServerVersion()!.version;
   expect(version).toBe(catalogue(tools));expect(version).not.toBe("0.2.0");expect(client.getServerCapabilities()?.tools).toEqual({listChanged:false});
   expect(await client.callTool({name:"gone",arguments:{}}).then(()=>"",(error:Error)=>error.message)).toContain(`(catalogue version ${version}).`);
   await client.close();
   const viaGenerated=await connect(generated,mode);expect(viaGenerated.getServerVersion()!.version).toBe(version);await viaGenerated.close();
   seen.push(version);
  }
  const own=await connect(serveMcp(tools,{...options,serverInfo:{name:"app",version:undefined}}),"legacy");expect(own.getServerVersion()).toMatchObject({name:"app",version:catalogue(tools)});await own.close();
 });return seen;};
 const before=await versionsOf(source),after=await versionsOf(source.replace("description: Add an item","description: Add one item"));
 expect(new Set(before).size).toBe(1);expect(new Set(after).size).toBe(1);expect(after[0]).not.toBe(before[0]);
});

test("transport and request validation answer before the unknown-tool error; batches, host callers and an empty catalogue get it too",async()=>{
 const files=await generateOrThrow("bun-sqlite",[{sourceId:"g.yaml",text:gatewaySource}]);
 await withApp(files,async(mcp,db,tools,dir)=>{
  const {targets}=await import(resolve(dir,"access-targets.ts"));
  const message=(name:string)=>`No tool named ${JSON.stringify(name)} exists in the current catalogue (catalogue version ${catalogue(tools)}).`;
  const call=(name:string,id=1)=>({jsonrpc:"2.0",id,method:"tools/call",params:{name,arguments:{}}});
  const post=async(handle:(request:Request,env:unknown,ctx?:any)=>Promise<Response|undefined>,body:unknown,headers:Record<string,string>={},ctx?:unknown)=>{
   const response=(await handle(new Request("https://app.test/mcp",{method:"POST",headers:{"content-type":"application/json",accept:"application/json, text/event-stream",...headers},body:JSON.stringify(body)}),{},ctx))!;
   const text=await response.text();return {status:response.status,messages:text.startsWith("event:")?text.split("\n").filter(line=>line.startsWith("data: ")).map(line=>JSON.parse(line.slice(6))):[JSON.parse(text)]};
  };
  const handle=mcp({db:()=>db,caller:()=>({kind:"anonymous"})});
  const quiet=console.error;console.error=()=>{};
  try {
   for(const headers of [{accept:"text/html"},{"content-type":"text/plain"},{"mcp-protocol-version":"bogus"}] as Record<string,string>[]){
    const known=await post(handle,call("public_records"),headers),unknown=await post(handle,call("gone"),headers);
    expect(known.status).toBeGreaterThanOrEqual(400);expect(unknown).toEqual(known);
   }
   // a tool the caller's tools/list hides behind authentication or authorization is challenged before any transport check
   const closed=tools.find(tool=>tool.surface==="public"&&tool.closed).name,denied=mcp({db:()=>db,caller:()=>({kind:"user",id:"person",role:"editor",credential:"session",scopes:[]}),authorize:()=>false});
   for(const headers of [{},{accept:"text/html"},{"content-type":"text/plain"},{"mcp-protocol-version":"bogus"}] as Record<string,string>[]){
    expect((await post(handle,call(closed),headers)).status).toBe(401);
    expect((await post(denied,call("public_records"),headers)).status).toBe(403);
   }
   for(const body of [{...call("gone"),jsonrpc:"1.0"},{...call("gone"),id:{}}]){const refused=await post(handle,body);expect(refused.status).toBe(400);expect(JSON.stringify(refused.messages)).not.toContain("No tool named");}
  } finally {console.error=quiet;}
  const batch=await post(handle,[call("gone",1),call("public_records",2)],{"mcp-protocol-version":"2025-03-26"});
  expect(batch.messages.find(m=>m.id===1)).toEqual({jsonrpc:"2.0",id:1,error:{code:-32602,message:message("gone")}});expect(batch.messages.find(m=>m.id===2).result).toBeDefined();
  const events:any[]=[],host=mcp({db:()=>db,gateway:{tenant:"example"},onAccess:(event:unknown)=>{events.push(event);}});
  const hosted=await post(host,call("gone"),{},{props:{mantle:await pinned(mantleProps(),targets,"procedure:touch")}} as any);
  expect(hosted.status).toBe(200);expect(events).toEqual([expect.objectContaining({target:"procedure:touch",outcome:"error",reason:"INPUT_VALIDATION_FAILED"})]);expect(hosted.messages).toEqual([{jsonrpc:"2.0",id:1,error:{code:-32602,message:message("gone")}}]);
  const empty=serveMcp([],{db:()=>db,caller:()=>({kind:"anonymous"})});
  expect((await post(empty,{jsonrpc:"2.0",id:1,method:"tools/list",params:{}})).messages[0].result.tools).toEqual([]);
  expect((await post(empty,call("gone"))).messages[0].error).toEqual({code:-32602,message:`No tool named "gone" exists in the current catalogue (catalogue version ${catalogue([])}).`});
 });
});
