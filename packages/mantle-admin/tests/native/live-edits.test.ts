import {expect,test} from "bun:test";
import {Database} from "bun:sqlite";
import {SQL} from "bun";
import {mkdtemp,rm} from "node:fs/promises";
import {join} from "node:path";
import {admin as createAdmin} from "../../src/server/index.js";
import {entries} from "../../src/server/entries.js";
import {authenticatedAs as userCaller} from "@aotter/mantle/testing";
import {generateAdmin,writeAdminFixture} from "./generated-fixture.js";

// #1822: generic patches edit drafts only, as an implicit lock entry.locks shows, unless a publishing Schema opts into liveEdits;
// a live edit keeps the row publishable and its published_at. Declared locks still apply, and transitions ignore the implicit one.
const schema=(name:string,extra:string)=>`apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: {name: ${name}}
spec:
 title: ${name}
 lifecycle: publishing
${extra} schema: {type: object, required: [title], properties: {title: {type: string}, body: {type: string}}}
`;
const manifest=[schema("pages",""),schema("posts",` publishing: {liveEdits: true}
 lock:
  - name: frozen
    on: [update]
    when: title = 'frozen'
    message: This post is frozen.
`)].join("---\n");
const DRAFTS="Only drafts may be edited.",UNPUBLISH="Published entries must be unpublished before deletion.";
const implicit=(collection:string,verb:string,message:string)=>({status:409,code:"CONFLICT",kind:"lock",schema:collection,verb,lock:"publishing",message});

for(const target of ["bun-sqlite","bun-postgres"] as const){
 const url=process.env.MANTLE_NEXT_BUN_PG_URL;
 (target==="bun-sqlite"||url?test:test.skip)(`${target} liveEdits and the implicit drafts-only lock`,async()=>{
  const files=await generateAdmin(target,manifest),dir=await mkdtemp(join(import.meta.dir,"../../../mantle/tests/apps/.admin-live-"));
  const namespace="admin_live_"+crypto.randomUUID().replaceAll("-",""),pg=target==="bun-postgres";
  const db:any=pg?new SQL(url!,{max:1}):new Database(":memory:");
  try{
   await writeAdminFixture(dir,files);
   if(pg){await db.unsafe(`CREATE SCHEMA ${namespace}`);await db.unsafe(`SET search_path TO ${namespace}`);await db.unsafe(files["schema.sql"]!);}else db.exec(files["schema.sql"]!);
   const {adminBindings}=await import(join(dir,"admin-bindings.ts")),bindings=adminBindings();
   const fetch=createAdmin(bindings.metadata,bindings.views,bindings.operations,{db:()=>db,caller:()=>userCaller({id:"a",role:"admin"},{adminRoles:["admin"]}),routes:entries(bindings.schemas,bindings.adapter)});
   const ask=async(path:string,method:string,input?:unknown)=>{const response=(await fetch(new Request("https://app.test/admin/api"+path,{method,headers:{origin:"https://app.test"},...(input?{body:JSON.stringify(input)}:{})}),{}))!;const body:any=await response.json();return response.status===200?body.entry??body:{status:response.status,...body.error};};
   const stamps=async(table:string,id:string)=>{const sql=`SELECT published_at, updated_at FROM ${table} WHERE id = ${pg?"$1":"?"}`;return (pg?await db.unsafe(sql,[id]):db.query(sql).all(id))[0];};
   const create=(collection:string,data:object)=>ask("/entries","POST",{collection,data});
   const at=(collection:string,e:{id:string},tail="")=>`/entries/${e.id}${tail}?collection=${collection}`;
   const patch=(collection:string,e:{id:string;version:number},data:object)=>ask(at(collection,e),"PATCH",{data,expectedVersion:e.version});
   const move=(collection:string,e:{id:string;version:number},verb:string)=>ask(at(collection,e,"/"+verb),"POST",{expectedVersion:e.version});

   // default: a draft is free; a published page is locked for data writes, shown before the edit, and its transitions still run
   const page=await create("pages",{title:"p"});
   expect(page.locks).toEqual({update:false,delete:false});
   const livePage=await move("pages",page,"publish");
   expect(livePage.locks).toEqual({update:true,delete:true,lock:"publishing",message:DRAFTS});
   expect(await patch("pages",livePage,{body:"x"})).toMatchObject(implicit("pages","update",DRAFTS));
   expect(await ask(at("pages",livePage),"DELETE")).toMatchObject(implicit("pages","delete",UNPUBLISH));
   const unpublished=await move("pages",livePage,"unpublish");
   expect(unpublished).toMatchObject({status:"draft",locks:{update:false,delete:false}});
   expect((await patch("pages",unpublished,{body:"x"})).data).toMatchObject({body:"x"});

   // liveEdits: a published post edits in place, keeps published_at and moves updated_at
   const post=await create("posts",{title:"t"}),live=await move("posts",post,"publish");
   expect(live.locks).toEqual({update:false,delete:true,lock:"publishing",message:UNPUBLISH});
   const before=await stamps("posts",post.id);
   await new Promise(r=>setTimeout(r,5));
   const edited=await patch("posts",live,{body:"live"});
   expect(edited).toMatchObject({status:"published",data:{body:"live"},version:live.version+1});
   const after=await stamps("posts",post.id);
   expect(+after.published_at).toBe(+before.published_at);
   expect(+after.updated_at).toBeGreaterThan(+before.updated_at);
   // the merged row must stay publishable
   expect(await patch("posts",edited,{title:null})).toMatchObject({status:400,code:"INPUT_VALIDATION_FAILED"});
   expect(await ask(at("posts",edited),"DELETE")).toMatchObject(implicit("posts","delete",UNPUBLISH));
   // a declared lock still applies, and binds transitions too
   const frozen=await patch("posts",edited,{title:"frozen"});
   expect(frozen.locks).toEqual({update:true,delete:true,lock:"frozen",message:"This post is frozen."});
   expect(await patch("posts",frozen,{body:"x"})).toMatchObject({status:409,kind:"lock",lock:"frozen"});
   expect(await move("posts",frozen,"unpublish")).toMatchObject({status:409,kind:"lock",lock:"frozen"});
  }finally{
   if(pg){await db.unsafe(`DROP SCHEMA IF EXISTS ${namespace} CASCADE`);await db.close();}else db.close();
   await rm(dir,{recursive:true,force:true});
  }
 },30000);
}
