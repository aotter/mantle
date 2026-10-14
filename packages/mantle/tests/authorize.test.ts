import { test, expect, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateOrThrow, writeGenerated } from "./apps/link.js";
import { fixtureCaller } from "./apps/fixtures.js";
import type { Authorize, Caller, Target } from "../src/kernel/contracts.js";

const doc = (kind: string, name: string, spec: object) => JSON.stringify({apiVersion:"cms.mantle.aotter.net/v2",kind,metadata:{name},spec});
const source = [
  doc("Schema", "notes", {title:"Notes",lifecycle:"operational",schema:{type:"object",properties:{title:{type:"string"}},required:["title"]}}),
  doc("View", "list-notes", {surface:"public",requires:{auth:{all:["ctx.user"]}},sql:"SELECT id FROM notes ORDER BY id"}),
  doc("View", "open-notes", {surface:"public",sql:"SELECT id FROM notes ORDER BY id"}),
  doc("Procedure", "echo-notes", {requires:{auth:{all:["ctx.admin"]}},input:{type:"object",additionalProperties:false},output:{type:"object"},handler:{ref:"app.echo"}}),
  doc("Trigger", "echo-http", {source:{kind:"http",method:"POST",path:"/api/echo"},target:{procedure:"echo-notes"}}),
  doc("Trigger", "echo-mcp", {source:{kind:"mcp",surface:"public"},target:{procedure:"echo-notes"}}),
].join("\n---\n");
const admin: Caller = fixtureCaller({kind:"user",subject:"a",role:"admin",admin:true,scopes:["mcp"],credential:"api-key",credentialId:null,clientId:null});
const cases: readonly [Authorize | undefined, number][] = [[undefined,200],[()=>true,200],[async()=>true,200],[()=>false,403],[async()=>false,403],[()=>Promise.reject(Error("refused")),403],[()=>{throw Error("broken");},500]];

async function fixture(run: (dir: string, db: Database) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(),"mantle-authorize-")), db = new Database(":memory:");
  const log = spyOn(console,"error").mockImplementation(()=>{});
  try {
    const files = await generateOrThrow("bun-sqlite",[{sourceId:"authorize.yaml",text:source}]);
    await writeGenerated(dir,files); db.exec(files["schema.sql"]!);
    await run(dir,db);
  } finally {log.mockRestore(); db.close(); await rm(dir,{recursive:true,force:true});}
}

test("generated REST authorizes manifest targets before SQL/handlers, with requires first", async () => fixture(async (dir,db) => {
  const {rest} = await import(join(dir,"rest.ts"));
  for (const [authorize,status] of cases) for (const [path,method,target] of [
    ["/api/views/list-notes","GET",{kind:"view",name:"list-notes"}],
    ["/api/echo","POST",{kind:"procedure",name:"echo-notes"}],
  ] as const) {
    let providers=0, handlers=0, calls=0;
    const fetch = rest({db:()=>{providers++;return db;},caller:()=>admin,handlers:{"echo-notes":()=>{handlers++;return {ok:true};}},...(authorize ? {authorize:(t:Target,c:Caller)=>{calls++;expect(t).toEqual(target);expect(c).toBe(admin);return authorize(t,c);}} : {})});
    const response = await fetch(new Request("https://app.test"+path,{method,...(method==="POST"?{body:"{}"}:{})}),{});
    expect(response.status).toBe(status);
    expect(providers).toBe(status===200?1:0); expect(handlers).toBe(status===200 && method==="POST"?1:0);
    expect(calls).toBe(authorize?1:0);
    if(status===403) expect((await response.json()).error.code).toBe("AUTH_DENIED");
  }
  let authorizations=0;
  const fetch = rest({db:()=>{throw Error("SQL before requires");},caller:()=>({kind:"anonymous"}),handlers:{"echo-notes":()=>{throw Error("handler before requires");}},authorize:()=>{authorizations++;return true;}});
  for (const [path,method] of [["/api/views/list-notes","GET"],["/api/echo","POST"]]) expect((await fetch(new Request("https://app.test"+path,{method,body:method==="POST"?"{}":undefined}),{})).status).toBe(401);
  expect(authorizations).toBe(0);
  const publicFetch=rest({db:()=>{throw Error("denied public SQL");},caller:()=>({kind:"anonymous"}),handlers:{},authorize:()=>false});
  expect((await publicFetch(new Request("https://app.test/api/views/open-notes"),{})).status).toBe(403);
}));

test("generated MCP authorizes calls and filters lists using requires and manifest names", async () => fixture(async (dir,db) => {
  const {mcp} = await import(join(dir,"mcp.ts"));
  const ask = async (fetch: (request:Request, env:object)=>Promise<Response>,method:string,params:object={}) => {
    const response = await fetch(new Request("https://app.test/mcp",{method:"POST",headers:{"content-type":"application/json",accept:"application/json, text/event-stream"},body:JSON.stringify({jsonrpc:"2.0",id:1,method,params})}),{});
    const text = await response.text();
    return {response,data:JSON.parse(text.startsWith("event:")?text.split("data: ")[1]!.split("\n")[0]!:text)};
  };
  for(const [authorize,status] of cases) for(const [name,target] of [["list_notes",{kind:"view",name:"list-notes"}],["echo_notes",{kind:"procedure",name:"echo-notes"}]] as const) {
    let providers=0, handlers=0;
    const fetch=mcp({db:()=>{providers++;return db;},caller:()=>admin,handlers:{"echo-notes":()=>{handlers++;return {ok:true};}},...(authorize?{authorize:(t:Target,c:Caller)=>{expect(t).toEqual(target);expect(c).toBe(admin);return authorize(t,c);}}:{})});
    const result=await ask(fetch,"tools/call",{name,arguments:{}});
    expect(result.response.status).toBe(status);expect(providers).toBe(status===200?1:0);expect(handlers).toBe(status===200 && name==="echo_notes"?1:0);
    if(status===200) expect(result.data.result.isError).toBeUndefined();
    if(status===403) expect(result.data.error.code).toBe("AUTH_DENIED");
  }
  for(const [authorize,status] of cases) {
    const fetch=mcp({apps:{public:{resources:[{uri:"ui://notes",name:"notes",html:"<p>Notes</p>",renders:["list_notes"]}]}},db:()=>{throw Error("listing SQL");},caller:()=>admin,handlers:{"echo-notes":()=>{throw Error("listing handler");}},...(authorize?{authorize}:{})});
    const result=await ask(fetch,"tools/list");
    expect(result.response.status).toBe(status===500?500:200);
    if(status!==500) expect(result.data.result.tools.map((t:{name:string})=>t.name)).toEqual(status===403?[]:["list_notes","open_notes","echo_notes"]);
  }
  const seen: Target[]=[];
  const fetch=mcp({db:()=>{throw Error("requires SQL");},caller:()=>({kind:"anonymous"}),handlers:{},authorize:async(t:Target)=>{seen.push(t);return true;}});
  expect((await ask(fetch,"tools/list")).data.result.tools.map((t:{name:string})=>t.name)).toEqual(["open_notes"]);
  expect(seen).toEqual([{kind:"view",name:"open-notes"}]);seen.length=0;
  expect((await ask(fetch,"tools/call",{name:"list_notes",arguments:{}})).response.status).toBe(401);expect(seen).toEqual([]);
}));
