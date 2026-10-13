import {expect, test} from "bun:test";
import {Database} from "bun:sqlite";
import {SQL} from "bun";
import {mkdtemp,rm} from "node:fs/promises";
import {resolve} from "node:path";
import {generateOrThrow,writeGenerated} from "./apps/link.js";
import {wireRows,checkOrigin} from "../src/kernel/contracts.js";
import {outputConversions} from "../src/domain/columns.js";
import {compilePlan} from "../src/build/compiler.js";
import * as postgresCompiler from "../src/build/postgres/compile/index.js";

const source=`apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: {name: values}
spec:
 title: Values
 lifecycle: operational
 scope: {ownerId: 'auth.uid()'}
 indexes: [[ownerId, amount, id]]
 schema:
  type: object
  properties: {ownerId: {type: string}, amount: {type: integer}, flag: {type: boolean}, payload: {type: object}, maybe: {type: [integer, 'null']}}
  required: [ownerId, amount, flag, payload]
---
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: {name: values}
spec:
 surface: public
 requires: {auth: {all: [ctx.user]}}
 sql: SELECT id,amount AS "integerAlias",flag AS "booleanAlias",payload AS "jsonAlias",maybe,version AS rev,created_at AS "createdAt" FROM values ORDER BY amount,id
---
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: {name: computed}
spec:
 surface: internal
 sql: SELECT id,amount+0 AS computed FROM values ORDER BY id
---
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: {name: aggregate}
spec:
 surface: public
 sql: WITH totals AS (SELECT SUM(amount) AS summed,MIN(amount) AS low FROM values) SELECT summed,low FROM totals
---
apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: {name: raw}
spec:
 input: {type: object, properties: {id: {type: string}, version: {type: integer}}, required: [id,version], additionalProperties: false}
 output: {type: object}
 handler: {sql: 'UPDATE values SET flag=flag WHERE id=input.id AND version=input.version RETURNING id,amount'}
---
apiVersion: cms.mantle.aotter.net/v2
kind: Trigger
metadata: {name: raw-mcp}
spec: {source: {kind: mcp, surface: public}, target: {procedure: raw}}
`;
const fixture = source + ([['int','amount'],['bool','flag'],['json','payload']] as const).map(([kind,field])=>`---
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: {name: proto-${kind}}
spec: {surface: public, sql: 'SELECT id,${field} AS "__proto__" FROM values ORDER BY id'}
`).join('');
const caller:any={kind:"user",subject:"a",role:null,credential:"api-key",credentialId:null,clientId:null,scopes:["mcp"]};

test("selected scalar conversion is static, copies rows and preserves native computed/missing/null values",async()=>{
 const raw=Object.assign(Object.create({inherited:"42"}),{safe:42n,large:9007199254740993n,unsafeNumber:9007199254740992,json:'{"x":true}',bool:1,nil:null,computed:9007199254740993n});
 const converted=wireRows([raw],[["safe","int"],["large","int"],["unsafeNumber","int"],["json","json"],["bool","bool"],["nil","int"],["missing","int"],["inherited","int"]])[0]!;
 expect(converted).toEqual({safe:42,large:"9007199254740993",unsafeNumber:9007199254740992,json:{x:true},bool:true,nil:null,computed:9007199254740993n});
 expect(raw.safe).toBe(42n);expect(raw.json).toBe('{"x":true}');expect(converted).not.toBe(raw);expect(Object.hasOwn(converted,"missing")).toBe(false);expect(Object.hasOwn(converted,"inherited")).toBe(false);
 const rows=[raw];expect(wireRows(rows)).toBe(rows);
 const alias=Object.fromEntries([["__proto__","42"],["constructor","43"]]);const result=wireRows([alias],[["__proto__","int"],["constructor","int"]])[0]!;
 expect(Object.getPrototypeOf(result)).toBe(Object.prototype);expect(result["__proto__"]).toBe(42);expect(result["constructor"]).toBe(43);
 const compiled=await compilePlan({sources:[{sourceId:"values",text:fixture}]},postgresCompiler,"operational");
 if(!compiled.ok)throw Error(JSON.stringify(compiled.diagnostics));
 expect(outputConversions(compiled.plan,"values","bun-postgres")).toEqual([["integerAlias","int"],["maybe","int"],["rev","int"]]);
 expect(outputConversions(compiled.plan,"values","cloudflare-d1")).toEqual([["booleanAlias","bool"],["jsonAlias","json"]]);
 expect(outputConversions(compiled.plan,"computed","bun-postgres")).toEqual([]);
 expect(outputConversions(compiled.plan,"aggregate","bun-postgres")).toEqual([]);
 expect(Object.getPrototypeOf(compiled.plan.views["proto-int"]!.columns)).toBeNull();
 expect(outputConversions(compiled.plan,"proto-int","bun-postgres")).toEqual([["__proto__","int"]]);
 expect(outputConversions(compiled.plan,"proto-json","cloudflare-d1")).toEqual([["__proto__","json"]]);
 const direct=await compilePlan({sources:[{sourceId:"cte",text:source+`---
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: {name: direct-cte}
spec: {surface: internal, sql: 'WITH p AS (SELECT amount,flag,payload FROM values) SELECT amount,flag,payload FROM p'}
`}]},postgresCompiler,"operational");
 if(!direct.ok)throw Error(JSON.stringify(direct.diagnostics));
 expect(outputConversions(direct.plan,"direct-cte","bun-postgres")).toEqual([["amount","int"]]);
 expect(outputConversions(direct.plan,"direct-cte","cloudflare-d1")).toEqual([["flag","bool"],["payload","json"]]);
 expect(()=>checkOrigin(new Request("https://app.test/api/edit",{method:"POST",headers:{origin:"https://evil.test"}}),{...caller,credential:"session"})).toThrow("Cross-origin");
});

async function verify(target:"bun-sqlite"|"bun-postgres",db:any,run:(sql:string)=>Promise<any>|any,bigint=false){
 const files=await generateOrThrow(target,[{sourceId:"values",text:fixture}]),dir=await mkdtemp(resolve(import.meta.dir,".selected-output-"));
 try{
  await writeGenerated(dir,files);await run(files["schema.sql"]!);
  const pg=target==="bun-postgres";
  const stamp=pg?"'2026-02-01T00:00:00.123456Z'":"1770000000123456";
  for(const[id,owner,amount]of[["a","a","42"],["b","a","9223372036854775806"],["c","a","9223372036854775807"],["foreign","b","9223372036854775807"]])await run(`INSERT INTO "values"(id,version,created_at,updated_at,ownerId,amount,flag,payload,maybe) VALUES('${id}',1,${stamp},${stamp},'${owner}',${pg?amount:id==='a'?42:id==='b'?43:44},${pg?"true":"1"},'${JSON.stringify({id})}',NULL)`);
  const {default:bare}=await import(resolve(dir,"views/values.ts")),{default:computed}=await import(resolve(dir,"views/computed.ts")),{default:raw}=await import(resolve(dir,"procedures/raw.ts"));
  const native=await bare(db,caller,{});expect(native.map((r:any)=>r.id)).toEqual(["a","b","c"]);expect(typeof native[0].integerAlias).toBe(pg?(bigint?"bigint":"string"):"number");expect(typeof native[0].booleanAlias).toBe(pg?"boolean":"number");expect(typeof native[0].jsonAlias).toBe(pg?"object":"string");
  const system={kind:"system",reason:"native-control"};const c=await computed(db,system,{});expect(typeof c[0].computed).toBe(pg?(bigint?"bigint":"string"):"number");expect(typeof(await raw(db,system,{id:"foreign",version:1})).results[0][0].amount).toBe(pg?(bigint?"bigint":"string"):"number");
  const{default:aggregate}=await import(resolve(dir,"views/aggregate.ts"));const totals=await aggregate(db,caller,{});expect(typeof totals[0].low).toBe(pg?(bigint?"bigint":"string"):"number");
  const{rest}=await import(resolve(dir,"rest.ts"));let calls=0;const counted=pg?{unsafe:(s:string,p:any[])=>{calls++;return db.unsafe(s,p)}}:{query:(s:string)=>{calls++;return db.query(s)}};
  const serve=rest({db:()=>counted,caller:async()=>caller});let cursor:string|undefined;const seen:any[]=[];
  for(let i=0;i<3;i++){const response=await serve(new Request("https://app.test/api/views/values?limit=1"+(cursor?"&cursor="+encodeURIComponent(cursor):"")),{});expect(response.status).toBe(200);const p=await response.json();seen.push(p.rows[0]);cursor=p.nextCursor;expect(calls).toBe(i+1);}
  expect(cursor).toBeUndefined();expect(seen.map(r=>r.id)).toEqual(["a","b","c"]);expect(seen[0].integerAlias).toBe(42);expect(seen[0].rev).toBe(1);expect(seen.every(r=>r.booleanAlias===true&&r.jsonAlias.id===r.id&&r.maybe===null)).toBe(true);
  if(pg){expect(seen[1].integerAlias).toBe("9223372036854775806");expect(seen[2].integerAlias).toBe("9223372036854775807");expect(seen[0].createdAt).toBe("2026-02-01T00:00:00.123456Z");}
  else {expect(seen[1].integerAlias).toBe(native[1].integerAlias);const unsafe=db.query("SELECT 9223372036854775807 AS value").get();expect(typeof unsafe.value).toBe("number");expect(wireRows([unsafe],[])[0]!.value).toBe(unsafe.value);}
  if(!bigint){const response=await serve(new Request("https://app.test/api/views/aggregate"),{});expect(response.status).toBe(200);expect((await response.json()).rows).toEqual(totals);}
  const before=calls;expect((await serve(new Request("https://app.test/api/views/values?cursor=bad"),{})).status).toBe(400);expect(calls).toBe(before);
  const{mcp}=await import(resolve(dir,"mcp.ts"));const handle=mcp({db:()=>counted,caller:()=>caller});
  const response=await handle(new Request("https://app.test/mcp",{method:"POST",headers:{"content-type":"application/json",accept:"application/json, text/event-stream"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name:"values",arguments:{limit:1}}})}),{});
  const text=await response.text(),data=JSON.parse(text.startsWith("event:")?text.split("data: ")[1]!.split("\n")[0]!:text);expect(response.status).toBe(200);expect(data.result.isError).toBeUndefined();expect(data.result.structuredContent.rows[0]).toEqual(seen[0]);expect(calls).toBe(before+1);
  for(const[kind,expected]of[['int',42],['bool',true],['json',{id:'a'}]] as const){
   const prior=calls,reply=await serve(new Request(`https://app.test/api/views/proto-${kind}?limit=1`),{});expect(reply.status).toBe(200);const json=await reply.json();expect(json.rows[0]['__proto__']).toEqual(expected);expect(Object.hasOwn(json.rows[0],'__proto__')).toBe(true);expect(calls).toBe(prior+1);
   const rpc=await handle(new Request('https://app.test/mcp',{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:`proto_${kind}`,arguments:{limit:1}}})}),{});const payload=await rpc.text(),result=JSON.parse(payload.startsWith('event:')?payload.split('data: ')[1]!.split('\n')[0]!:payload);expect(rpc.status).toBe(200);expect(result.result.isError).toBeUndefined();expect(result.result.structuredContent.rows[0]['__proto__']).toEqual(expected);expect(calls).toBe(prior+2);
  }
 }finally{await rm(dir,{recursive:true,force:true})}
}
test("generated selected SQLite REST/MCP converts JSON/bool, leaving bare values and unsafe numbers native",async()=>{const db=new Database(":memory:");try{await verify("bun-sqlite",db,s=>db.exec(s))}finally{db.close()}});
(process.env.MANTLE_NEXT_BUN_PG_URL?test:test.skip)("generated selected PG REST/MCP accepts native strings and bigint with exact integer cursors",async()=>{
 const schema="selected_"+crypto.randomUUID().replaceAll("-", ""),root=new SQL(process.env.MANTLE_NEXT_BUN_PG_URL!);try{
  await root.unsafe(`CREATE SCHEMA ${schema}`);
  for(const bigint of[false,true]){const db=new SQL({url:process.env.MANTLE_NEXT_BUN_PG_URL!,max:1,bigint,connection:{search_path:schema}});try{await verify("bun-postgres",db,s=>db.unsafe(s),bigint)}finally{await db.close();await root.unsafe(`DROP SCHEMA ${schema} CASCADE`);await root.unsafe(`CREATE SCHEMA ${schema}`)}}
 }finally{await root.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await root.close()}
},30000);
