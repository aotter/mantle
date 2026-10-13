import {test,expect} from "bun:test";
import {Database} from "bun:sqlite";
import {SQL} from "bun";
import {mkdtemp,rm} from "node:fs/promises";
import {join} from "node:path";
import {generateOrThrow,loadFixtureSources,writeGenerated} from "./apps/link.js";
import {generateFromSources} from "../src/infrastructure/generate.js";
import {verifyPaging,pagingSeed} from "./paging-scenarios.js";
async function fixture(target:"bun-sqlite"|"bun-postgres") {
 const files=await generateOrThrow(target,await loadFixtureSources("paging.yaml"));const dir=await mkdtemp(join(import.meta.dir,"apps/.paging-native-"));await writeGenerated(dir,files);
 const pages:Record<string,Function>={};for(const name of ["ordered","mixed","grouped","grouped-time","window-groups","joined","lookup","singleton"])pages[name]=(await import(join(dir,`paged/views/${name}.ts`))).default;
 return{files,dir,pages};
}
test("SQLite safe tuples/groups/singleton joins/internal pages match native SQL with one read",async()=>{
 const {files,dir,pages}=await fixture("bun-sqlite"),db=new Database(":memory:");let calls=0;
 try {db.exec(files["schema.sql"]!);db.exec(pagingSeed(false));
 const fanout="SELECT a.id,a.at FROM positions a JOIN positions b ON a.session=b.session WHERE a.owner='a' AND b.owner='a' AND a.id='0000'";
 expect((db.query(`SELECT count(*) AS n FROM (${fanout})`).get() as any).n).toBe(501);
 expect(db.query(`SELECT * FROM (${fanout}) WHERE (at,id) > (?,?) ORDER BY at,id`).all(1791849600123456,"0000")).toEqual([]);
 const counted={query:(sql:string)=>{calls++;return db.query(sql);}};await verifyPaging(pages,counted,async(sql)=>db.query(sql).all(),()=>calls,false);expect(calls).toBeGreaterThan(500);}
 finally{db.close();await rm(dir,{recursive:true,force:true});}
});
(process.env.MANTLE_NEXT_BUN_PG_URL?test:test.skip)("PostgreSQL same native paging oracle preserves microseconds and tenant isolation",async()=>{
 const {files,dir,pages}=await fixture("bun-postgres"),db=new SQL(process.env.MANTLE_NEXT_BUN_PG_URL!,{max:1}),schema="paging_"+crypto.randomUUID().replaceAll("-","");let calls=0;
 try{await db.unsafe(`CREATE SCHEMA ${schema}`);await db.unsafe(`SET search_path TO ${schema}`);await db.unsafe(files["schema.sql"]!);await db.unsafe(pagingSeed(true));await verifyPaging(pages,{unsafe:(sql:string,values:any[])=>{calls++;return db.unsafe(sql,values);}},sql=>db.unsafe(sql),()=>calls,true);expect(calls).toBeGreaterThan(500);}
 finally{await db.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await db.close();await rm(dir,{recursive:true,force:true});}
},30000);
test("unsafe fanout and NULL/unknown keys remain refused; native-only internal queries remain bare",async()=>{
 const sources=await loadFixtureSources("paging.yaml");
 const view=(sql:string,surface="public")=>`\n---\napiVersion: cms.mantle.aotter.net/v2\nkind: View\nmetadata: {name: unsafe}\nspec:\n  surface: ${surface}\n  sql: ${sql}\n`;
 for(const sql of [
  "WITH x AS (SELECT id,session,row_number() OVER (ORDER BY at) AS block FROM positions) SELECT session AS block,count(*) AS total FROM x GROUP BY block ORDER BY block",
  "SELECT session AS block,count(*) AS total FROM positions GROUP BY block ORDER BY block",
  "WITH x AS (SELECT id,at FROM visible), y AS (WITH x AS (SELECT id,at FROM visible ORDER BY at DESC LIMIT 1) SELECT id,at FROM x) SELECT s.id,v.at FROM y s JOIN x v ON true ORDER BY s.id",
  "SELECT m.id AS group_id,count(*) AS total FROM visible v LEFT JOIN (latest l JOIN latest m ON true) ON v.block=0 GROUP BY m.id ORDER BY m.id",
  "SELECT l.id, v.block FROM latest l JOIN visible v ON true ORDER BY l.id",
  "SELECT a.id,a.at FROM positions a JOIN positions b ON a.session=b.session ORDER BY a.at",
  "SELECT p.id,p.at FROM positions p JOIN sessions s ON s.id=p.session OR s.label=p.optional ORDER BY p.at",
  "SELECT id, optional FROM positions ORDER BY optional",
  "SELECT id, lower(session) AS key FROM positions ORDER BY lower(session)",
  "SELECT optional,count(*) AS n FROM positions GROUP BY optional ORDER BY optional",
 ]){
 const r=await generateFromSources({target:"bun-sqlite",sources:{sources:[{...sources[0]!,text:sources[0]!.text+view(sql)}]}});expect(r).toMatchObject({ok:false});if(!r.ok)expect(r.diagnostics.some(d=>d.path==="views/unsafe")).toBe(true);
 }
 const files=await generateOrThrow("bun-sqlite",[{...sources[0]!,text:sources[0]!.text+view("SELECT id,optional FROM positions ORDER BY optional","internal")}]);
 expect(files["views/unsafe.ts"]).toBeDefined();expect(files["paged/views/unsafe.ts"]).toBeUndefined();expect(files["rest.ts"]).not.toContain("grouped-time");expect(files["mcp.ts"]).not.toContain("grouped-time");
});
test("a scalar subquery does not prove its outer query singleton",async()=>{
 const sources=await loadFixtureSources("paging.yaml");
 const extra=(sql:string)=>`\n---\napiVersion: cms.mantle.aotter.net/v2\nkind: View\nmetadata: {name: bounded}\nspec:\n  surface: public\n  sql: ${sql}\n`;
 const bad=await generateFromSources({target:"bun-sqlite",sources:{sources:[{...sources[0]!,text:sources[0]!.text+extra("SELECT id,(SELECT count(*) FROM positions) AS total FROM positions")}]}});
 expect(bad).toMatchObject({ok:false});
});
test("PostgreSQL window/filtered min-max cannot masquerade as non-null group keys",async()=>{
 const sources=await loadFixtureSources("paging.yaml");
 for(const expression of ["min(day) OVER(ORDER BY day ROWS BETWEEN 1 PRECEDING AND 1 PRECEDING)","min(day) FILTER (WHERE false)"]){
  const result=await generateFromSources({target:"bun-postgres",sources:{sources:[{...sources[0]!,text:sources[0]!.text+`\n---\napiVersion: cms.mantle.aotter.net/v2\nkind: View\nmetadata: {name: nullable-aggregate}\nspec:\n  surface: public\n  sql: SELECT day,${expression} AS prior FROM positions GROUP BY day ORDER BY prior NULLS FIRST\n`}]}});
  expect(result).toMatchObject({ok:false});if(!result.ok)expect(result.diagnostics.some(d=>d.path==="views/nullable-aggregate")).toBe(true);
 }
});
test("an equality on the leading order column does not erase its matching index",async()=>{
 const sources=await loadFixtureSources("paging.yaml");
 const files=await generateOrThrow("bun-sqlite",[{...sources[0]!,text:sources[0]!.text+`\n---\napiVersion: cms.mantle.aotter.net/v2\nkind: View\nmetadata: {name: fixed-order}\nspec:\n  surface: public\n  input: {type: object, required: [session, block], properties: {session: {type: string}, block: {type: integer}}}\n  sql: SELECT id,block,position FROM positions WHERE session=input.session AND block=input.block ORDER BY block,position\n`}]);
 expect(files["paged/views/fixed-order.ts"]).toBeDefined();
});
test("GROUP BY output aliases remain supported when they do not shadow input names",async()=>{
 const sources=await loadFixtureSources("paging.yaml");
 const files=await generateOrThrow("bun-sqlite",[{...sources[0]!,text:sources[0]!.text+`\n---\napiVersion: cms.mantle.aotter.net/v2\nkind: View\nmetadata: {name: alias-group}\nspec:\n  surface: public\n  sql: SELECT day AS bucket,count(*) AS total FROM positions GROUP BY bucket ORDER BY bucket\n`}]);
 expect(files["paged/views/alias-group.ts"]).toBeDefined();
});

for (const target of ["bun-sqlite","bun-postgres"] as const) (target === "bun-postgres" && !process.env.MANTLE_NEXT_BUN_PG_URL ? test.skip : test)(`${target}: lexical CTE identity and column renaming cannot falsely prove uniqueness`, async () => {
 const sources = await loadFixtureSources("paging.yaml");
 const sqls = ["WITH sessions AS (SELECT a.id FROM positions a JOIN positions b ON true) SELECT id FROM sessions ORDER BY id", "WITH x(id, position) AS (SELECT position,id FROM positions) SELECT id FROM x ORDER BY id"];
 const view = (sql: string, surface: string) => `\n---\napiVersion: cms.mantle.aotter.net/v2\nkind: View\nmetadata: {name: shadow-proof}\nspec:\n  surface: ${surface}\n  sql: ${sql}\n`;
 const sqlite = target === "bun-sqlite", db:any = sqlite ? new Database(":memory:") : new SQL(process.env.MANTLE_NEXT_BUN_PG_URL!,{max:1}), schema="paging_cte_"+crypto.randomUUID().replaceAll("-","");
 try {
  if(!sqlite){await db.unsafe(`CREATE SCHEMA ${schema}`);await db.unsafe(`SET search_path TO ${schema}`);}
  const base = await generateOrThrow(target,sources);
  if(sqlite){db.exec(base["schema.sql"]!);db.exec(pagingSeed(false));}else{await db.unsafe(base["schema.sql"]!);await db.unsafe(pagingSeed(true));}
  for(const sql of sqls){
   const native = sqlite ? db.query(sql).all() : await db.unsafe(sql);
   expect(native.length).toBeGreaterThan(new Set(native.map((row:any)=>row.id)).size);
   const publicResult = await generateFromSources({target,sources:{sources:[{...sources[0]!,text:sources[0]!.text+view(sql,"public")}]}});
   expect(publicResult).toMatchObject({ok:false});if(!publicResult.ok)expect(publicResult.diagnostics.some(d=>d.path==="views/shadow-proof")).toBe(true);
   const internal = await generateOrThrow(target,[{...sources[0]!,text:sources[0]!.text+view(sql,"internal")}]);
   expect(internal["views/shadow-proof.ts"]).toBeDefined();expect(internal["paged/views/shadow-proof.ts"]).toBeUndefined();
  }
 } finally {if(sqlite)db.close();else{await db.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await db.close();}}
},30000);

for (const target of ["bun-sqlite","bun-postgres"] as const) (target === "bun-postgres" && !process.env.MANTLE_NEXT_BUN_PG_URL ? test.skip : test)(`${target}: grouped integer number/string cursors agree without rewriting SQL literals or bare outputs`, async () => {
 const sources = await loadFixtureSources("paging.yaml");
 const extra = `\n---\napiVersion: cms.mantle.aotter.net/v2\nkind: View\nmetadata: {name: integer-groups}\nspec:\n  surface: public\n  sql: SELECT block,MIN(position) AS low,'literal?1' AS literal FROM positions GROUP BY block ORDER BY MIN(position),block\n`;
 const files = await generateOrThrow(target,[{...sources[0]!,text:sources[0]!.text+extra}]), dir=await mkdtemp(join(import.meta.dir,"apps/.paging-integer-"));await writeGenerated(dir,files);
 const paged=(await import(join(dir,"paged/views/integer-groups.ts"))).default, sqlite=target==="bun-sqlite", db:any=sqlite?new Database(":memory:"):new SQL(process.env.MANTLE_NEXT_BUN_PG_URL!,{max:1}),schema="paging_integer_"+crypto.randomUUID().replaceAll("-","");
 try {
  if(sqlite){db.exec(files["schema.sql"]!);db.exec(pagingSeed(false));}else{await db.unsafe(`CREATE SCHEMA ${schema}`);await db.unsafe(`SET search_path TO ${schema}`);await db.unsafe(files["schema.sql"]!);await db.unsafe(pagingSeed(true));}
  const caller={kind:"user",subject:"a",role:null,scopes:[],credential:"api-key",credentialId:null,clientId:null} as const;
  const first=await paged(db,caller,{},{limit:1}), tuple=JSON.parse(decodeURIComponent(first.nextCursor!));
  expect(first.rows[0].literal).toBe("literal?1");
  const cursor=(text:boolean)=>encodeURIComponent(JSON.stringify(tuple.map((value:any,i:number)=>i<2?(text?String(value):Number(value)):value)));
  const numerical=await paged(db,caller,{},{limit:1,cursor:cursor(false)}),exact=await paged(db,caller,{},{limit:1,cursor:cursor(true)});
  expect(exact).toEqual(numerical);expect(exact.rows.length).toBe(1);expect(exact.rows[0].literal).toBe("literal?1");
  expect(files["views/integer-groups.ts"]).not.toContain("CAST(");
 } finally {if(sqlite)db.close();else{await db.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await db.close();}await rm(dir,{recursive:true,force:true});}
},30000);

for(const target of ["bun-sqlite","bun-postgres","cloudflare-d1","cloudflare-postgres"] as const)test(`${target}: computed output aliases cannot collide with actual hidden cursor keys`,async()=>{
 const sources=await loadFixtureSources("paging.yaml"),sqlite=!target.endsWith("postgres");
 const view=(alias:string,surface:string)=>`\n---\napiVersion: cms.mantle.aotter.net/v2\nkind: View\nmetadata: {name: cursor-collision}\nspec:\n  surface: ${surface}\n  sql: SELECT id,session AS "${alias}" FROM positions WHERE session='s' ORDER BY block,position,id\n`;
 for(const alias of ["_k2",...(sqlite?["_K2"]:[])]){
  const publicResult=await generateFromSources({target,sources:{sources:[{...sources[0]!,text:sources[0]!.text+view(alias,"public")}]}});
  expect(publicResult).toMatchObject({ok:false});if(!publicResult.ok)expect(publicResult.diagnostics.some(d=>d.path==="views/cursor-collision"&&d.message.includes("hidden cursor"))).toBe(true);
  const internal=await generateOrThrow(target,[{...sources[0]!,text:sources[0]!.text+view(alias,"internal")}]);
  expect(internal["views/cursor-collision.ts"]).toBeDefined();expect(internal["paged/views/cursor-collision.ts"]).toBeUndefined();
 }
 const safe=await generateOrThrow(target,[{...sources[0]!,text:sources[0]!.text+view(sqlite?"_k3":"_K2","public")}]);expect(safe["paged/views/cursor-collision.ts"]).toBeDefined();
});

(process.env.MANTLE_NEXT_BUN_PG_URL?test:test.skip)("PostgreSQL temporal cursor casts preserve authored bind-looking literals on every page",async()=>{
 const sources=await loadFixtureSources("paging.yaml");
 const views=`\n---\napiVersion: cms.mantle.aotter.net/v2\nkind: View\nmetadata: {name: temporal-literal}\nspec:\n  surface: public\n  sql: SELECT id,at,block,'$2' AS literal FROM positions ORDER BY at,block,id\n---\napiVersion: cms.mantle.aotter.net/v2\nkind: View\nmetadata: {name: date-literal}\nspec:\n  surface: public\n  sql: SELECT day,block,session,'$2' AS literal FROM positions GROUP BY day,block,session ORDER BY day,block,session\n`;
 const files=await generateOrThrow("bun-postgres",[{...sources[0]!,text:sources[0]!.text.replace("[owner, at]]","[owner, at], [owner, at, block]]")+views}]),dir=await mkdtemp(join(import.meta.dir,"apps/.paging-temporal-"));await writeGenerated(dir,files);
 const db=new SQL(process.env.MANTLE_NEXT_BUN_PG_URL!,{max:1}),schema="paging_temporal_"+crypto.randomUUID().replaceAll("-","");
 try{
  await db.unsafe(`CREATE SCHEMA ${schema}`);await db.unsafe(`SET search_path TO ${schema}`);await db.unsafe(files["schema.sql"]!);await db.unsafe(pagingSeed(true));
  const caller={kind:"user",subject:"a",role:null,scopes:[],credential:"api-key",credentialId:null,clientId:null} as const;
  for(const name of ["temporal-literal","date-literal"]){
   const paged=(await import(join(dir,`paged/views/${name}.ts`))).default;
   let reads=0;const counted={unsafe:(sql:string,values:any[])=>{reads++;return db.unsafe(sql,values);}};
   const first=await paged(counted,caller,{},{limit:1}),next=await paged(counted,caller,{},{limit:1,cursor:first.nextCursor});
   expect(reads).toBe(2);expect(first.nextCursor).toBeDefined();expect(first.rows[0].literal).toBe("$2");expect(next.rows.length).toBe(1);expect(next.rows[0].literal).toBe("$2");expect(next.rows).not.toEqual(first.rows);
   expect(files["generated.ts"]).toContain("'$2'");expect(files[`paged/views/${name}.ts`]).toContain("'$2'");
  }
 }finally{await db.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await db.close();await rm(dir,{recursive:true,force:true});}
},30000);

test("a nullable foreign key still proves a non-fanning id join", async () => {
 const sources=await loadFixtureSources("paging.yaml");
 const text=sources[0]!.text+`\n---\napiVersion: cms.mantle.aotter.net/v2\nkind: View\nmetadata: {name: nullable-reference}\nspec:\n  surface: public\n  sql: SELECT p.id,p.at FROM positions p JOIN sessions s ON s.id=p.optional ORDER BY p.at\n`;
 for(const target of ["bun-sqlite","bun-postgres"] as const) expect((await generateOrThrow(target,[{sourceId:"nullable.yaml",text}]))["paged/views/nullable-reference.ts"]).toBeDefined();
});
