import { mantleProps, pinned } from "./gateway-fixture.js";
import { fixtureCaller } from "./apps/fixtures.js";
import {test,expect,spyOn} from "bun:test";
import {Database} from "bun:sqlite";
import {SQL} from "bun";
import {mkdtemp,rm} from "node:fs/promises";
import {join} from "node:path";
import {generateFromSources} from "../src/infrastructure/generate.js";
import {mediaError} from "../src/kernel/media.js";
import {wire} from "../src/kernel/contracts.js";
import {writeGenerated} from "./apps/link.js";
import type {MediaStorage} from "../src/kernel/site-types.js";
const source=`apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: {name: entries}
spec: {title: Entries, lifecycle: operational, schema: {type: object, properties: {title: {type: string}}}}
---
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: {name: entries}
spec: {surface: public, sql: 'SELECT id FROM entries ORDER BY id'}
`;
const site={media:{purposes:[{name:"cover",required:["png"],maxBytes:{"image/png":100}}]}};
const names=["get_media_upload_policy","create_media_upload","commit_media_upload","list_media_assets","get_media_asset","update_media_asset","delete_media_asset"];
const admin=fixtureCaller({kind:"user",subject:"u",role:"admin", admin: true,scopes:["mcp"],credential:"session",credentialId:null,clientId:null});
for(const target of ["bun-sqlite","bun-postgres"] as const) (target === "bun-sqlite" || process.env.MANTLE_NEXT_BUN_PG_URL ? test : test.skip)(`${target}: seven admin media tools reuse native library, input checks, wire shapes and origin gate`,async()=>{
 const generated=await generateFromSources({target,sources:{sources:[{sourceId:"media.yaml",text:source}]},site});if(!generated.ok)throw Error(JSON.stringify(generated.diagnostics));
 const dir=await mkdtemp(join(import.meta.dir,".mcp-media-"));await writeGenerated(dir,generated.files);const db:any=target === "bun-sqlite" ? new Database(":memory:") : new SQL(process.env.MANTLE_NEXT_BUN_PG_URL!,{max:1}),schema="mcp_media_"+crypto.randomUUID().replaceAll("-","");if(target === "bun-sqlite")db.exec(generated.files["schema.sql"]!);else{await db.unsafe(`CREATE SCHEMA ${schema}`);await db.unsafe(`SET search_path TO ${schema}`);await db.unsafe(generated.files["schema.sql"]!);}let caller:any=admin,calls=0,deleteFails=false;const queries=spyOn(db,target === "bun-sqlite" ? "query" : "unsafe");
 const storage:MediaStorage={async createUpload(a){calls++;return {capabilities:a.variants.map(v=>({...v,method:"PUT" as const,storageKey:"uploads/"+a.uploadGroupId,uploadUrl:"https://upload.test/"+a.uploadGroupId,requiredHeaders:{"content-type":v.mimeType}}))};},async commitUpload(a){calls++;return {id:a.uploadGroupId,createdAt:a.now,variants:a.variants.map(v=>({...v,storageKey:"committed/"+a.uploadGroupId,publicUrl:"https://media.test/"+a.uploadGroupId,byteSize:5})),...(a.alt!==undefined?{alt:a.alt}:{})};},async deleteObject(){if(deleteFails)throw mediaError("PARTIAL_FAILURE","retry");}};
 try {
 const {mcp}=await import(join(dir,"mcp.ts"));let readOnly=false;const options={db:()=>db,allowedOrigins:["https://app.test"],caller:(_request:Request,_env:unknown,authority:{readOnly:boolean})=>{readOnly=authority.readOnly;return caller;}},handle=mcp({...options,media:()=>storage});
 const rpc=async(method:string,params:any={},path="/mcp/admin",origin?:string,handler=handle)=>{const response=await handler(new Request("https://app.test"+path,{method:"POST",headers:{cookie:"fixture=1",origin:"https://app.test","content-type":"application/json",accept:"application/json, text/event-stream",...(origin?{origin}:{})},body:JSON.stringify({jsonrpc:"2.0",id:1,method,params})}),{});const text=await response.text();return {response,data:JSON.parse(text.startsWith("event:")?text.split("data: ")[1]!.split("\n")[0]!:text)};};
 const call=async(name:string,args:any={})=>(await rpc("tools/call",{name,arguments:args})).data.result;
 const tools=(await rpc("tools/list")).data.result.tools;expect(tools.map((t:any)=>t.name)).toEqual(names);expect(calls).toBe(0);expect(queries).not.toHaveBeenCalled();
 expect(tools.every((t:any)=>t.inputSchema.additionalProperties===false&&t.annotations.openWorldHint)).toBe(true);expect(tools[0].annotations.readOnlyHint).toBe(true);expect(tools[6].annotations.destructiveHint).toBe(true);expect(tools[0].title).toBe("Get media upload policy");expect(tools.every((t:any)=>t.title&&typeof t.annotations.destructiveHint==="boolean")).toBe(true);
 expect((await rpc("tools/list",{},"/mcp")).data.result.tools.map((t:any)=>t.name)).toEqual(["entries"]);
 expect((await call(names[0]!)).structuredContent.purposes[0].name).toBe("cover");expect(readOnly).toBe(true);expect(queries).toHaveBeenCalledTimes(1);
 for(const [name,args] of [[names[0],{bytes:"x"}],[names[1],{filename:"x",purpose:"cover",variants:[{mimeType:"image/png",byteSize:0,role:"primary"}]}],[names[2],{}],[names[3],{limit:501}],[names[4],{id:2}],[names[5],{id:"x",alt:null}],[names[6],{id:"x",bytes:"x"}]]){expect((await call(name as string,args)).isError).toBe(true);expect(readOnly).toBe([names[0],names[3],names[4]].includes(name as string));}
 expect(calls).toBe(0);expect(queries).toHaveBeenCalledTimes(1);
 const upload=await call(names[1]!,{filename:"x.png",purpose:"cover",variants:[{mimeType:"image/png",byteSize:5,role:"primary"}],alt:"original"}),group=upload.structuredContent.uploadGroupId;
 expect(upload.structuredContent.capabilities[0].requiredHeaders).toEqual({"content-type":"image/png"});expect((await call(names[2]!,{uploadGroupId:group})).structuredContent.id).toBe(group);
 expect((await call(names[3]!)).structuredContent.rows).toHaveLength(1);expect((await call(names[4]!,{id:group})).structuredContent.alt).toBe("original");expect((await call(names[5]!,{id:group,alt:""})).structuredContent.alt).toBe("");
 expect((await rpc("tools/call",{name:names[6],arguments:{id:group}},"/mcp/admin","https://evil.test")).response.status).toBe(403);deleteFails=true;const partial=await call(names[6]!,{id:group});expect(partial.isError).toBe(true);expect(JSON.parse(partial.content[0].text).diagnostics[0].code).toBe("PARTIAL_FAILURE");expect((await call(names[4]!,{id:group})).structuredContent.id).toBe(group);deleteFails=false;expect((await call(names[6]!,{id:group})).structuredContent.deleted).toBe(true);expect(JSON.parse((await call(names[4]!,{id:group})).content[0].text).diagnostics[0].code).toBe("MEDIA_ASSET_NOT_FOUND");
 caller={kind:"anonymous"};expect((await rpc("tools/list")).response.status).toBe(401);caller=fixtureCaller({...admin,role:"user",admin:false});expect((await rpc("tools/list")).response.status).toBe(403);caller=admin;
 expect((await rpc("tools/list",{},"/mcp/admin",undefined,mcp(options))).data.result.tools).toEqual([]);
 await rpc("tools/call",{name:names[0],arguments:{}},"/mcp/admin",undefined,mcp(options));expect(readOnly).toBe(false);
 const gateway=mcp({...options,gateway:{tenant:"example"},media:()=>storage});
 const {targets}=await import(join(dir,"access-targets.ts"));
 const forward=async(request:Request,env:unknown)=>{const body=await request.clone().text(),name=JSON.parse(body).params.name;return gateway(request,env,{props:{mantle:await pinned(mantleProps({authenticatedAs:"snapshot"}),targets,"admin:tool:"+name)}});};
 const beforeCalls=calls,policy=await rpc("tools/call",{name:names[0],arguments:{}},"/mcp/admin",undefined,forward);
 expect(policy.response.status).toBe(200);expect(policy.data.result.structuredContent.purposes[0].name).toBe("cover");
 const stale=await rpc("tools/call",{name:names[1],arguments:{}},"/mcp/admin",undefined,forward);expect(stale.response.status).toBe(403);expect(stale.data.error.code).toBe("STALE_CALLER");expect(calls).toBe(beforeCalls);
 }finally{queries.mockRestore();if(target === "bun-sqlite")db.close();else{await db.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await db.close();}await rm(dir,{recursive:true,force:true});}
});
test("media tool collisions refuse generation",async()=>{
 const text=source.replace('name: entries}\nspec: {surface: public','name: get-media-asset}\nspec: {surface: admin');const result=await generateFromSources({target:"bun-sqlite",sources:{sources:[{sourceId:"collision.yaml",text}]},site});expect(result.ok).toBe(false);expect(JSON.stringify(result)).toContain("collides on admin");
});
test("a query-only Worker excludes media MCP and the SDK from its bundle",async()=>{
 const generated=await generateFromSources({target:"cloudflare-d1",sources:{sources:[{sourceId:"media.yaml",text:source}]},site});if(!generated.ok)throw Error(JSON.stringify(generated.diagnostics));
 const dir=await mkdtemp(join(import.meta.dir,".mcp-media-bundle-"));
 try{await writeGenerated(dir,generated.files);const {build}=await import("esbuild");const result=await build({stdin:{contents:`export {store} from ${JSON.stringify(join(dir,"generated.ts"))};`,resolveDir:dir,sourcefile:"worker.ts"},bundle:true,write:false,metafile:true,format:"esm",platform:"neutral",external:["node:async_hooks"]});expect(Object.keys(result.metafile!.inputs).some(path=>/kernel\/(mcp-media|media|site|r2-media)\.ts|@modelcontextprotocol/.test(path))).toBe(false);const entry=join(dir,"mcp.ts"),selected=await build({entryPoints:[entry],outdir:join(dir,"out"),bundle:true,splitting:true,write:false,metafile:true,format:"esm",platform:"neutral",conditions:["workerd","worker","browser"],external:["node:*"],});const {startupGraph}=await import("../src/infrastructure/bundle.js");const startup=startupGraph(selected.metafile!,entry).flatMap(path=>Object.keys(selected.metafile!.outputs[path]!.inputs));expect(startup.some(path=>/kernel\/(media|site|r2-media)\.ts|@modelcontextprotocol/.test(path))).toBe(false);expect(Object.keys(selected.metafile!.inputs).some(path=>/kernel\/media\.ts$/.test(path))).toBe(true);}finally{await rm(dir,{recursive:true,force:true});}
});

test("media errors retain their HTTP status outside the core status vocabulary",()=>{expect(wire(mediaError("MEDIA_ASSET_NOT_FOUND","missing")).status).toBe(404);expect(wire(mediaError("PARTIAL_FAILURE","retry")).status).toBe(503);expect(wire(mediaError("SITE_NOT_CONFIGURED","unwired")).status).toBe(501);});
test("generated media inputs and MCP options typecheck on all native targets",async()=>{
 const ts=await import("typescript"),dir=await mkdtemp(join(import.meta.dir,".mcp-types-")),files:string[]=[];
 try{for(const target of ["bun-sqlite","bun-postgres","cloudflare-d1","cloudflare-postgres"] as const){const withRef=source+`---
apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: {name: media-ref}
spec: {input: {type: object, additionalProperties: false}, output: {type: object}, handler: {ref: app.mediaRef}}
---
apiVersion: cms.mantle.aotter.net/v2
kind: Trigger
metadata: {name: media-ref-mcp}
spec: {source: {kind: mcp, surface: admin}, target: {procedure: media-ref}}
`;const generated=await generateFromSources({target,sources:{sources:[{sourceId:"media.yaml",text:withRef}]},site});if(!generated.ok)throw Error(JSON.stringify(generated.diagnostics));const path=join(dir,target);await writeGenerated(path,generated.files,false);files.push(join(path,"mcp.ts"));}
 const program=ts.createProgram(files,{strict:true,noEmit:true,target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.NodeNext,moduleResolution:ts.ModuleResolutionKind.NodeNext,skipLibCheck:true,types:["bun-types"]});expect(ts.getPreEmitDiagnostics(program).map(d=>ts.flattenDiagnosticMessageText(d.messageText,"\n"))).toEqual([]);
 }finally{await rm(dir,{recursive:true,force:true});}
},30000);

test("generated media keeps one App catalogue but binds each concurrent request's native DB and storage",async()=>{
 const generated=await generateFromSources({target:"bun-sqlite",sources:{sources:[{sourceId:"media.yaml",text:source}]},site});if(!generated.ok)throw Error(JSON.stringify(generated.diagnostics));
 const dir=await mkdtemp(join(import.meta.dir,".mcp-media-apps-")),a=new Database(":memory:"),b=new Database(":memory:");
 try{
  a.exec(generated.files["schema.sql"]!);b.exec(generated.files["schema.sql"]!);await writeGenerated(dir,generated.files);
  const {mcp}=await import(join(dir,"mcp.ts"));let catalogues=0;const used:string[]=[],subjects:string[]=[];
  const env=(id:string,db:Database)=>({db,caller:fixtureCaller({...admin,subject:id}),storage:{async createUpload(input:any){used.push(id);return{capabilities:input.variants.map((v:any)=>({...v,method:"PUT",storageKey:id+"/"+input.uploadGroupId,uploadUrl:"https://"+id+".test/"+input.uploadGroupId}))};},async commitUpload(){throw Error("not used");},async deleteObject(){}}});
  const first=env("tenant-a",a),second=env("tenant-b",b),handle=mcp({db:(env:typeof first)=>env.db,allowedOrigins:["https://app.test"],caller:(_request:Request,env:typeof first)=>env.caller,media:(env:typeof first)=>env.storage,onObservation:(event:any)=>{if(event.kind==="invocation"&&event.phase==="attempt")subjects.push(event.caller.subject);},apps:{admin:[{get resources(){catalogues++;return[{uri:"ui://media/upload",name:"upload",html:"<h1>Upload</h1>",renders:["create_media_upload"]}];}}]}});
  const call=async(env:typeof first,method:string,params:Record<string,unknown>={},path="/mcp/admin")=>{const response=await handle(new Request("https://app.test"+path,{method:"POST",headers:{origin:"https://app.test","content-type":"application/json",accept:"application/json, text/event-stream"},body:JSON.stringify({jsonrpc:"2.0",id:1,method,params:{...params,_meta:{"io.modelcontextprotocol/clientCapabilities":{extensions:{"io.modelcontextprotocol/ui":{mimeTypes:["text/html;profile=mcp-app"]}}}}}})}),env);const text=await response.text();return JSON.parse(text.startsWith("event:")?text.split("data: ")[1]!.split("\n")[0]!:text).result;};
  expect((await call(first,"tools/list",{},"/mcp")).tools.map((tool:any)=>tool.name)).toEqual(["entries"]);expect(catalogues).toBe(1); // read once when mcp(...) is built
  const lists=await Promise.all([call(first,"tools/list"),call(second,"tools/list")]);expect(catalogues).toBe(1);expect(used).toEqual([]);
  expect(lists.every(list=>list.tools.find((tool:any)=>tool.name==="create_media_upload")._meta.ui.resourceUri==="ui://media/upload")).toBe(true);
  const args={filename:"x.png",purpose:"cover",variants:[{mimeType:"image/png",byteSize:5,role:"primary"}]};
  const uploads=await Promise.all([call(first,"tools/call",{name:"create_media_upload",arguments:args}),call(second,"tools/call",{name:"create_media_upload",arguments:args})]);
  expect(new URL(uploads[0].structuredContent.capabilities[0].uploadUrl).hostname).toBe("tenant-a.test");expect(new URL(uploads[1].structuredContent.capabilities[0].uploadUrl).hostname).toBe("tenant-b.test");expect(used.sort()).toEqual(["tenant-a","tenant-b"]);expect(catalogues).toBe(1);expect(subjects.sort()).toEqual(["tenant-a","tenant-b"]);
  expect(a.query("SELECT id FROM pending_media_uploads").all()).toEqual([{id:uploads[0].structuredContent.uploadGroupId}]);expect(b.query("SELECT id FROM pending_media_uploads").all()).toEqual([{id:uploads[1].structuredContent.uploadGroupId}]);
 }finally{a.close();b.close();await rm(dir,{recursive:true,force:true});}
});
