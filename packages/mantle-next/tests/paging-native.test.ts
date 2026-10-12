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
  "SELECT p.id,p.at FROM positions p JOIN sessions s ON s.id=p.optional ORDER BY p.at",
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
