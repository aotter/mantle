import {test,expect} from "bun:test";
import {Database} from "bun:sqlite";
import {mkdtemp,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {generateOrThrow,loadFixtureSources,writeGenerated} from "./apps/link.js";
import {generateFromSources} from "../src/infrastructure/generate.js";
import {verifySearch} from "./search-scenarios.js";
test("SQLite search preserves scope, TTL, publishing, OCC and bounded native calls",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"mantle-search-")),db=new Database(":memory:");
 try {
  const files=await generateOrThrow("bun-sqlite",await loadFixtureSources("search.yaml"));
  await writeGenerated(dir,files);db.exec(files["schema.sql"]!);
  const app=await import(join(dir,"generated.ts"));await verifySearch(app,db);
  let calls=0;const counted={query(sql:string){calls++;return db.query(sql);}};
  const owner={kind:"user",subject:"search-owner",role:"staff",scopes:[],credential:"session",credentialId:null,clientId:null};
  const collection=app.store(counted,owner).collection("search_records");
  await collection.find({search:"Beta"});expect(calls).toBe(1);
  for(const search of [" ", "\0", "Alpha\0"]){await expect(collection.find({search})).rejects.toHaveProperty("code","INPUT_VALIDATION_FAILED");expect(calls).toBe(1);}
  const row=await app.store(db,owner).collection("search_records").insert({title:"Counted delete"});calls=0;
  await collection.delete(row.id,{lock:1});expect(calls).toBe(2);
 }finally{db.close();await rm(dir,{recursive:true,force:true});}
});
test("unsupported search declarations/rank fail during generation with actionable diagnostics",async()=>{
 const sources=await loadFixtureSources("search.yaml"),text=sources[0]!.text;
 for(const target of ["bun-sqlite","bun-postgres"] as const){
  for(const invalid of [text.replace("searchableFields: [title, body]","searchableFields: [missing]"),text.replace("OR mantle.search(r, input.q)",""),text.replace("searchableFields: [title, body]","searchableFields: []")]){
   const result=await generateFromSources({target,sources:{sources:[{sourceId:"bad-search.yaml",text:invalid}]}});
   expect(result.ok).toBe(false);if(!result.ok)expect(result.diagnostics.some(d=>/search|field/i.test(d.message))).toBe(true);
  }
 }
});
