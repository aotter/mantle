import {test,expect} from "bun:test";
import {Database} from "bun:sqlite";
import {SQL} from "bun";
import postgres from "postgres";
import {mkdtemp,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {generateOrThrow,loadFixtureSources,writeGenerated} from "./apps/link.js";
import {generateFromSources} from "../src/infrastructure/generate.js";
import {d1Shim} from "./apps/d1-shim.js";
import {verifySearch} from "./search-scenarios.js";
for(const target of ["bun-sqlite","cloudflare-d1","bun-postgres","cloudflare-postgres"] as const){
 test.skipIf(target.endsWith("postgres")&&!process.env.MANTLE_NEXT_BUN_PG_URL)(`${target}: search shares native SQL semantics, scope, TTL, publishing and OCC`,async()=>{
  const dir=await mkdtemp(join(tmpdir(),"mantle-search-"));
  const files=await generateOrThrow(target,await loadFixtureSources("search.yaml"));await writeGenerated(dir,files);
  const schema="search_"+crypto.randomUUID().replaceAll("-","");
  const sqlite=target.endsWith("postgres")?undefined:new Database(":memory:");
  const admin=sqlite?undefined:new SQL({url:process.env.MANTLE_NEXT_BUN_PG_URL!,max:1});
  let db:any;
  try {
   if(sqlite){sqlite.exec(files["schema.sql"]!);db=target==="cloudflare-d1"?d1Shim(sqlite):sqlite;
    expect(files["schema.sql"]).toContain("tokenize='trigram'");expect(files["schema.sql"]).toContain("AFTER UPDATE OF");
   }else{
    await admin!.unsafe(`CREATE SCHEMA "${schema}"`,[]);
    db=target==="bun-postgres"?new SQL({url:process.env.MANTLE_NEXT_BUN_PG_URL!,max:1,connection:{search_path:schema}}):postgres(process.env.MANTLE_NEXT_BUN_PG_URL!,{max:1,connection:{search_path:schema}});
    await db.unsafe(files["schema.sql"]!,[]);
    expect(files["schema.sql"]).not.toContain("fts5");
   }
   const app=await import(join(dir,"generated.ts"));expect((await verifySearch(app,db)).checks).toBe(36);
   let calls=0;
   const counting=sqlite?(target==="cloudflare-d1"?{...db,prepare(sql:string){calls++;return db.prepare(sql);}}:{query(sql:string){calls++;return db.query(sql);}}):{unsafe(sql:string,values:any[]){calls++;return db.unsafe(sql,values);}};
   const owner={kind:"user",subject:"search-owner",role:"editor",scopes:[],credential:"session",credentialId:null,clientId:null};
   const collection=app.store(counting,owner).collection("search_records");
   await collection.find({search:"Beta"});expect(calls).toBe(1);
   for (const search of [" ", "\0", "Alpha\0"]) {await expect(collection.find({search})).rejects.toHaveProperty("code","INPUT_VALIDATION_FAILED");expect(calls).toBe(1);}
   const row=await app.store(db,owner).collection("search_records").insert({title:"Counted delete"});calls=0;
   await collection.delete(row.id,{lock:1});expect(calls).toBe(sqlite?2:1);
  }finally{
   if(sqlite)sqlite.close();else{await (db?.close?.()??db?.end?.());await admin!.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`,[]);await admin!.close();}
   await rm(dir,{recursive:true,force:true});
  }
 });
}
test("unsupported search declarations/rank fail during generation with actionable diagnostics",async()=>{
 const sources=await loadFixtureSources("search.yaml"),text=sources[0]!.text;
 for(const target of ["bun-sqlite","bun-postgres"] as const){
  for(const invalid of [text.replace("searchableFields: [title, body]","searchableFields: [missing]"),text.replace("OR mantle.search(r, input.q)",""),text.replace("searchableFields: [title, body]","searchableFields: []")]){
   const result=await generateFromSources({target,sources:{sources:[{sourceId:"bad-search.yaml",text:invalid}]}});
   expect(result.ok).toBe(false);if(!result.ok)expect(result.diagnostics.some(d=>/search|field/i.test(d.message))).toBe(true);
  }
 }
});

// Core lowerPlan currently exposes warning strings, without Refused.code. Pin the real
// messages and assert mode deduplication until that API carries structured diagnostics.
test("search warnings stay actionable and emit one refusal per problem", async () => {
 const [source] = await loadFixtureSources("search.yaml");
 for (const target of ["bun-sqlite", "bun-postgres"] as const) {
  for (const [text, warning] of [
   [source!.text.replace("OR mantle.search(r, input.q)", ""), "mantle.search_rank(r) needs a mantle.search(r, ...) in the same query"],
   [source!.text.replace("searchableFields: [title, body]", "searchableFields: []"), "search_records declares no search fields"],
  ]) {
   const result = await generateFromSources({target, sources:{sources:[{...source!, text:text!}]}});
   expect(result).toEqual({ok:false, diagnostics:[{code:"GENERATE_UNSUPPORTED", path:"views/searched-records", message:`plan#/views/searched-records: ${warning}. Declare searchableFields on the source Schema; search_rank needs mantle.search on the same alias in the same query.`}]});
  }
 }
});
