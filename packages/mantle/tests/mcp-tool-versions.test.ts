import {expect,test} from "bun:test";
import {Database} from "bun:sqlite";
import {resolve} from "node:path";
import {mkdtemp,rm} from "node:fs/promises";
import {Client,StreamableHTTPClientTransport} from "@modelcontextprotocol/client";
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
const app=(mcp:string)=>/version: "([0-9a-f]{8})", \.\.\.options\.serverInfo/.exec(mcp)![1];

test("a tool's version and description change only with its own definition; the app version with any",async()=>{
 const first=(await generateOrThrow("bun-sqlite",[{sourceId:"v.yaml",text:source}]))["mcp.ts"]!,again=(await generateOrThrow("bun-sqlite",[{sourceId:"v.yaml",text:source}]))["mcp.ts"]!;
 expect(again).toBe(first);
 const before=versions(first);expect(Object.keys(before)).toEqual(["items","add_item","publish_posts","unpublish_posts","archive_posts"]);
 expect(first).toContain(`description: "List items (tool version ${before.items})"`);
 const edited=(await generateOrThrow("bun-sqlite",[{sourceId:"v.yaml",text:source.replace("description: Add an item","description: Add one item")}]))["mcp.ts"]!,after=versions(edited);
 expect(after.add_item).not.toBe(before.add_item);expect({...after,add_item:before.add_item}).toEqual(before);
 expect(edited.split("\n").filter(line=>line.includes('name: "items"'))).toEqual(first.split("\n").filter(line=>line.includes('name: "items"')));
 expect(app(edited)).not.toBe(app(first));
});

test("official client on both protocol eras sees version markers, versioned results and the input contract on failure",async()=>{
 const files=await generateOrThrow("bun-sqlite",[{sourceId:"v.yaml",text:source}]),listed=versions(files["mcp.ts"]!);
 const dir=await mkdtemp(resolve(import.meta.dir,".mcp-versions-")),db=new Database(":memory:");
 try {
  await writeGenerated(dir,files);db.exec(files["schema.sql"]!);
  const {mcp}=await import(resolve(dir,"mcp.ts"));const handle=mcp({db:()=>db,caller:()=>({kind:"anonymous"})});
  for(const mode of ["legacy",{pin:"2026-07-28"}] as const) {
   const client=new Client({name:"test",version:"1"},{versionNegotiation:{mode}});
   await client.connect(new StreamableHTTPClientTransport(new URL("https://app.test/mcp"),{fetch:async(url,init)=>(await handle(new Request(String(url),init),{}))!}));
   if(mode==="legacy") expect(client.getNegotiatedProtocolVersion()).not.toBe("2026-07-28"); else expect(client.getNegotiatedProtocolVersion()).toBe("2026-07-28");
   expect(client.getServerVersion()).toMatchObject({name:"aotter.mantle",version:app(files["mcp.ts"]!)});
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
