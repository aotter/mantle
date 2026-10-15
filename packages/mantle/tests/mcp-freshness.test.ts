import {expect, test} from "bun:test";
import {InMemoryServerEventBus, CLIENT_CAPABILITIES_META_KEY, PROTOCOL_VERSION_META_KEY} from "@modelcontextprotocol/server";
import {mcp, type Tool} from "../src/kernel/mcp.js";
import {userCaller} from "../src/kernel/user-caller.js";

const user = userCaller({id:"catalogue-user", role:"member"}, {scopes:["mcp"], credential:"oauth"});
const item = (description: Tool<unknown>["description"], properties: object = {}): Tool<unknown> => ({
 name:"item",surface:"public",closed:true,description,
 inputSchema:{type:"object",additionalProperties:false,properties},outputSchema:{type:"object",properties:{}},
 validate:raw=>raw as Record<string,unknown>,run:async(_db,_caller,input)=>input,
});
const request = (method:string, params:Record<string,unknown>={}, modern=true, path="/mcp", signal?:AbortSignal) => new Request("https://catalogue.test"+path,{
 method:"POST",signal,headers:{"content-type":"application/json",accept:"application/json, text/event-stream",
 ...(modern?{"mcp-protocol-version":"2026-07-28","mcp-method":method,...(typeof params.name==="string"?{"mcp-name":params.name}:{})}:{})},
 body:JSON.stringify({jsonrpc:"2.0",id:1,method,params:{...params,...(modern?{_meta:{[PROTOCOL_VERSION_META_KEY]:"2026-07-28",[CLIENT_CAPABILITIES_META_KEY]:{}}}:{})}}),
});
const json = async(response:Response|undefined)=>{expect(response).toBeDefined();expect(response!.status).toBe(200);const raw=await response!.text();return JSON.parse(raw.startsWith("event:")?raw.split("data: ")[1]!.split("\n")[0]!:raw);};

test("native catalogue freshness retains private zero TTL and honest modern/legacy capabilities",async()=>{
 const bus=new InMemoryServerEventBus();
 const handle=mcp([item("Current")],{db:()=>({}),caller:()=>user,bus});
 const modern=await json(await handle(request("tools/list"),{}));
 expect(modern.result.ttlMs).toBe(0);expect(modern.result.cacheScope).toBe("private");
 const discover=await json(await handle(request("server/discover"),{}));
 expect(discover.result.capabilities.tools.listChanged).toBe(true);
 const legacy=await json(await handle(request("initialize",{protocolVersion:"2025-11-25",capabilities:{},clientInfo:{name:"legacy",version:"1"}},false),{}));
 expect(legacy.result.capabilities.tools.listChanged).toBe(false);
 const legacyList=await json(await handle(request("tools/list",{},false),{}));
 expect(legacyList.result.ttlMs).toBeUndefined();expect(legacyList.result.cacheScope).toBeUndefined();
 const defaults=mcp([item("Current")],{db:()=>({}),caller:()=>user});
 const defaultDiscover=await json(await defaults(request("server/discover"),{}));
 expect(defaultDiscover.result.capabilities.tools.listChanged).toBe(false);
 const abort=new AbortController();
 const unsupported=await defaults(request("subscriptions/listen",{notifications:{toolsListChanged:true}},true,"/mcp",abort.signal),{});
 const reader=unsupported!.body!.getReader();
 try {
  const ack=new TextDecoder().decode((await reader.read()).value);
  expect(ack).toContain("notifications/subscriptions/acknowledged");
  expect(ack).not.toContain('"toolsListChanged":true');
 }finally{abort.abort();await reader.cancel();}
});

test("modern native subscription receives catalogue invalidation and refetches changed closed schemas",async()=>{
 const bus=new InMemoryServerEventBus();let tools:Tool<unknown>[]=[item("Before")];
 const handle=mcp(()=>tools,{db:()=>({}),caller:()=>user,bus});
 const old=await json(await handle(request("tools/list"),{}));expect(old.result.tools[0].description).toBe("Before");
 const abort=new AbortController();
 const stream=await handle(request("subscriptions/listen",{notifications:{toolsListChanged:true}},true,"/mcp",abort.signal),{});
 expect(stream!.status).toBe(200);expect(stream!.headers.get("content-type")).toContain("text/event-stream");
 const reader=stream!.body!.getReader(),decoder=new TextDecoder();
 try {
  const ack=decoder.decode((await reader.read()).value);expect(ack).toContain("notifications/subscriptions/acknowledged");
  tools=[item("Description only")];bus.publish({kind:"tools_list_changed"});
  expect(decoder.decode((await reader.read()).value)).toContain("notifications/tools/list_changed");
  const descriptionOnly=await json(await handle(request("tools/list"),{}));
  expect(descriptionOnly.result.tools[0].description).toBe("Description only");
  expect(descriptionOnly.result.tools[0].inputSchema).toEqual(old.result.tools[0].inputSchema);
  expect(descriptionOnly.result.tools[0].outputSchema).toEqual(old.result.tools[0].outputSchema);
  const next={...item("After",{cursor:{type:"string"}}),outputSchema:{type:"object",properties:{updated:{type:"boolean"}}}};
  tools=[next,{...item("Added"),name:"added"}];
  bus.publish({kind:"tools_list_changed"});
  const notification=decoder.decode((await reader.read()).value);
  expect(notification).toContain("notifications/tools/list_changed");expect(notification).not.toContain("After");expect(notification).not.toContain("cursor");
  const refreshed=await json(await handle(request("tools/list"),{}));
  expect(refreshed.result.tools.map((tool:any)=>tool.name)).toEqual(["item","added"]);
  expect(refreshed.result.tools[0].description).toBe("After");
  expect(refreshed.result.tools[0].inputSchema.additionalProperties).toBe(false);
  expect(refreshed.result.tools[0].inputSchema.properties.cursor.type).toBe("string");
  expect(refreshed.result.tools[0].outputSchema.properties.updated.type).toBe("boolean");
  const called=await json(await handle(request("tools/call",{name:"item",arguments:{cursor:"next"}}),{}));
  expect(called.result.structuredContent).toEqual({cursor:"next"});
  tools=[next];bus.publish({kind:"tools_list_changed"});await reader.read();
  const removed=await json(await handle(request("tools/list"),{}));expect(removed.result.tools.map((tool:any)=>tool.name)).toEqual(["item"]);
 }finally{abort.abort();await reader.cancel();}
 expect(bus.listenerCount).toBe(0);
},5000);

test("fresh discovery preserves caller, scope, surface and locale contexts without caching them on the bus",async()=>{
 const bus=new InMemoryServerEventBus();
 const tools=[item({en:"English",zh:"中文"}),{...item("Admin"),name:"admin_item",surface:"admin"}];
 let caller:typeof user|{kind:"anonymous"}=user;
 const options={db:()=>({}),caller:()=>caller,bus};
 const english=mcp(tools,{...options,locale:"en"}),chinese=mcp(tools,{...options,locale:"zh"});
 expect((await json(await english(request("tools/list"),{}))).result.tools[0].description).toBe("English");
 expect((await json(await chinese(request("tools/list"),{}))).result.tools[0].description).toBe("中文");
 caller={kind:"anonymous"};expect((await english(request("tools/list"),{}))!.status).toBe(401);
 expect((await english(request("subscriptions/listen",{notifications:{toolsListChanged:true}}),{}))!.status).toBe(401);
 caller=user;expect((await english(request("tools/list",{},true,"/mcp/admin"),{}))!.status).toBe(403);
 const scoped=mcp(tools,{db:()=>({}),caller:()=>userCaller({id:"no-scope",role:null},{scopes:[],credential:"oauth"}),bus});
 expect((await scoped(request("tools/list"),{}))!.status).toBe(403);
 expect((await scoped(request("subscriptions/listen",{notifications:{toolsListChanged:true}}),{}))!.status).toBe(403);
 bus.publish({kind:"tools_list_changed"});
 expect((await json(await english(request("tools/list"),{}))).result.tools.map((tool:any)=>tool.name)).toEqual(["item"]);
 const denied=mcp(tools,{...options,authorize:()=>false});
 expect((await json(await denied(request("tools/list"),{}))).result.tools).toEqual([]);
});
