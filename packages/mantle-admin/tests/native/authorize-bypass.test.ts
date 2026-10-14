import {test, expect} from "bun:test";
const R="../../src/server/";
const {admin:adminFunction}=await import(R+"index.ts");
const {webmcpRoutes}=await import(R+"webmcp.ts");
const {entries}=await import(R+"entries.ts");
const {sdkFixtureCaller}=await import("../../../mantle/tests/apps/fixtures.ts");
const admin=sdkFixtureCaller({kind:"user",subject:"a",role:"admin",admin:true,scopes:[],credential:"session",credentialId:null,clientId:null});
const metadata={collections:[],views:[],operations:[],webmcp:{tools:[{name:"secret_tool",target:{kind:"procedure",name:"secret"},description:"x",inputSchema:{}}],routes:{}}};

test("WebMCP tool calls are authorized like the operation they run", async()=>{
  let ran=0; const seen:any[]=[];
  const tool={name:"secret_tool",target:{kind:"procedure",name:"secret"},surface:"admin",description:"",inputSchema:{},validate:(x:any)=>x,run:async()=>{ran++;return {leaked:true};}};
  const operation={name:"secret",allows:()=>true,validate:(x:any)=>x,run:async()=>{ran++;return {leaked:true};}};
  const fetch=adminFunction(metadata,[],[operation],{db:()=>({}),caller:()=>admin,authorize:(t:any)=>{seen.push(t);return false;},routes:[...webmcpRoutes(metadata.webmcp,[tool])]});
  const ask=(p:string)=>fetch(new Request("https://app.test/admin/api"+p,{method:"POST",body:"{}",headers:{origin:"https://app.test","content-type":"application/json"}}),{});
  const viaOperations=await ask("/operations/secret");
  expect(viaOperations?.status).toBe(403);
  const viaWebmcp=await ask("/webmcp/secret_tool");
  expect(viaWebmcp?.status).toBe(403);
  expect(ran).toBe(0);
  expect(seen.every((t:any)=>t.kind==="procedure"&&t.name==="secret")).toBe(true);
});

test("a write grant alone never returns the entry it wrote", async()=>{
  const row={id:"a",version:1,created_at:"2026-01-01T00:00:00Z",updated_at:"2026-01-01T00:00:00Z",title:"secret title"};
  const mode={projection:"id, version, title",from:"FROM fixture",policy:"",binds:[],fields:{title:{column:"title",insert:"@value",update:"title=@value"}},create:{prefix:"c(",between:")(",suffix:")",columns:[],values:[],binds:[],returning:""},patch:{prefix:"patch ",sets:[],where:"",returning:"",binds:[{k:"input",name:"id"},{k:"version"}]},remove:{sql:"remove",binds:[{k:"input",name:"id"},{k:"version"}],row:true}};
  const binding={path:"admin/entries",marker:"@value",id:"id",cursorAliases:[{name:"_cursor0",sql:"_cursor0"},{name:"_cursor1",sql:"_cursor1"}],fields:{id:{expression:"id",value:"@value",wire:"id",kind:"text",nullable:false}},orderFields:["id"],caller:mode,trusted:mode};
  const adapter={sqlite:true,values:{},param:(n:number)=>"?"+n,escapeLike:(v:string)=>v,read:()=>[row],procedure:async()=>{throw Error("no write");}};
  const schema={binding,name:"posts",descriptor:{name:"posts"},publishing:false,readOnly:false,fields:{title:"title"},defaults:{},query:()=>({input:{},order:"id:asc"}),validate:(d:any)=>d,values:(d:any)=>d,row:(r:any)=>r};
  const fetch=adminFunction({collections:[],views:[],operations:[],webmcp:{tools:[],routes:{}}},[],[],{db:()=>({}),caller:()=>admin,routes:entries([schema],adapter),authorize:(t:any)=>t.action!=="read"});
  const ask=(p:string,method:string,body?:string)=>fetch(new Request("https://app.test/admin/api"+p,{method,body,headers:{origin:"https://app.test","content-type":"application/json"}}),{});
  expect((await ask("/entries/a?collection=posts","GET"))?.status).toBe(403);
  const r=await ask("/entries/a?collection=posts","PATCH",JSON.stringify({data:{},expectedVersion:1}));
  const j:any=await r?.json();
  expect(r?.status).toBe(200);expect(JSON.stringify(j)).not.toContain("secret title");expect(j.entry).toEqual({id:"a",version:1});
});
