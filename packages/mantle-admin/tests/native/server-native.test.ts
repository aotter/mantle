import {test,expect} from "bun:test";
import {admin} from "../../src/server/index.js";
import {entries} from "../../src/server/entries.js";
import {nativeEntryPage} from "../../src/server/native.js";
import {Database} from "bun:sqlite";
import {SQL} from "bun";
import postgres from "../../../mantle/node_modules/postgres";
import {mkdtemp,rm} from "node:fs/promises";
import {join} from "node:path";
import {generateAdmin,writeAdminFixture} from "./generated-fixture.js";
import {d1Shim} from "../../../mantle/tests/apps/d1-shim.js";
import {refManifest,handlers,verifyAdminBindings,staff} from "./server-native-scenarios.js";
for(const target of process.env.MANTLE_NATIVE_TESTS ? ["bun-sqlite","cloudflare-d1","bun-postgres","cloudflare-postgres"] as const : ["bun-sqlite"] as const){
 const sqlite=!target.endsWith("postgres"), url=process.env.MANTLE_NEXT_BUN_PG_URL;
 (sqlite||url?test:test.skip)(`${target} thin Admin dispatches scoped generated Views and atomic Procedures`,async()=>{
  const files=await generateAdmin(target,refManifest);
  const dir=await mkdtemp(join(import.meta.dir,"../../../mantle/tests/apps/.thin-admin-"));
  const schema="thin_admin_"+crypto.randomUUID().replaceAll("-","");
  const db:any=sqlite?new Database(":memory:"):target==="cloudflare-postgres"?postgres(url!,{max:1,onnotice:()=>{}}):new SQL(url!,{max:1});
  try{
   await writeAdminFixture(dir,files);
   if(sqlite)db.exec(files["schema.sql"]!);else{await db.unsafe(`CREATE SCHEMA ${schema}`);await db.unsafe(`SET search_path TO ${schema}`);await db.unsafe(files["schema.sql"]!);}
   let reads=0,writes=0,auth=0;
   const tapped=sqlite?{query(text:string){if(!text.startsWith("SELECT changes()")){if(/^(SELECT|WITH)\b/.test(text))reads++;else writes++;}return db.query(text);},exec:db.exec.bind(db),transaction:db.transaction.bind(db)}: {unsafe(text:string,values:unknown[]){if(/^(SELECT|WITH)\b/.test(text))reads++;else writes++;return db.unsafe(text,values);},begin:db.begin.bind(db)};
   const handle=target==="cloudflare-d1"?d1Shim(tapped as Database):tapped;
   const {adminBindings}=await import(join(dir,"admin-bindings.ts"));
   expect(await verifyAdminBindings(adminBindings({handlers}),handle,()=>reads)).toEqual({ok:true,checks:14,extensionLocks:true});
   if(!sqlite){
    let attempts=0;
    const lostReply={unsafe:async(text:string,values:unknown[])=>{const rows=await tapped.unsafe(text,values);if(text.startsWith("INSERT INTO")){attempts++;throw Error("Lost reply after native autocommit");}return rows;},begin:tapped.begin};
    const bindings=adminBindings({handlers}),fetch=admin(bindings.metadata,bindings.views,bindings.operations,{db:()=>lostReply,caller:()=>staff,routes:entries(bindings.schemas,bindings.adapter)});
    const before=reads;
    const response=await fetch(new Request("https://app.test/admin/api/entries",{method:"POST",headers:{origin:"https://app.test"},body:JSON.stringify({collection:"notes",data:{title:"committed without reply"}})}),{});
    expect(response?.status).toBe(503);expect((await response!.json()).error.code).toBe("OUTCOME_UNKNOWN");expect(attempts).toBe(1);expect(reads).toBe(before);
    const notes=bindings.schemas.find((schema:any)=>schema.name==="notes")!,query=notes.query(new URLSearchParams({filter_field:"title",filter_value:"committed without reply",sort:"id"}));
    expect((await nativeEntryPage(notes.binding,bindings.adapter,()=>handle,staff,query!)).rows).toHaveLength(1);
   }


  }finally{
   if(sqlite)db.close();else{await db.unsafe(`DROP SCHEMA ${schema} CASCADE`);if(target==="cloudflare-postgres")await db.end();else await db.close();}await rm(dir,{recursive:true,force:true});
  }
 },30000);
}
