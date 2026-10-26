import {expect,test} from "bun:test";
import {Database} from "bun:sqlite";
import {SQL} from "bun";
import {mkdtemp,rm} from "node:fs/promises";
import {join} from "node:path";
import {admin as createAdmin} from "../../src/server/index.js";
import {entries} from "../../src/server/entries.js";
import {nativeEntryProcedure} from "../../src/server/native.js";
import {authenticatedAs as userCaller} from "@aotter/mantle/testing";
import {generateAdmin,writeAdminFixture} from "./generated-fixture.js";

// #1822: a Schema lock binds Admin's generic patch and delete for admins too; the refusal says which lock, a system write passes.
const manifest=`apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: {name: posts}
spec:
 title: Posts
 lifecycle: operational
 indexes: [[current_revision]]
 schema: {type: object, properties: {title: {type: string}, current_revision: {type: string, x-mantle-ref: post_revisions}}}
---
apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: {name: post_revisions}
spec:
 title: Revisions
 lifecycle: operational
 lock:
  - name: live_revision
    on: [update, delete]
    when: EXISTS (SELECT 1 FROM posts p WHERE p.current_revision = post_revisions.id)
    message: This revision is live. Create a new revision and switch to it.
 schema: {type: object, properties: {body: {type: string}}}
`;
const lock=(verb:string)=>({code:"CONFLICT",kind:"lock",schema:"post_revisions",verb,lock:"live_revision",message:"This revision is live. Create a new revision and switch to it."});

for(const target of ["bun-sqlite","bun-postgres"] as const){
 const url=process.env.MANTLE_NEXT_BUN_PG_URL;
 (target==="bun-sqlite"||url?test:test.skip)(`${target} Admin generic patch and delete refuse a locked row with kind lock`,async()=>{
  const files=await generateAdmin(target,manifest),dir=await mkdtemp(join(import.meta.dir,"../../../mantle/tests/apps/.admin-lock-"));
  const namespace="admin_lock_"+crypto.randomUUID().replaceAll("-",""),pg=target==="bun-postgres";
  const db:any=pg?new SQL(url!,{max:1}):new Database(":memory:");
  try{
   await writeAdminFixture(dir,files);
   if(pg){await db.unsafe(`CREATE SCHEMA ${namespace}`);await db.unsafe(`SET search_path TO ${namespace}`);await db.unsafe(files["schema.sql"]!);}else db.exec(files["schema.sql"]!);
   const {adminBindings}=await import(join(dir,"admin-bindings.ts")),bindings=adminBindings();
   const fetch=createAdmin(bindings.metadata,bindings.views,bindings.operations,{db:()=>db,caller:()=>userCaller({id:"a",role:"admin"},{adminRoles:["admin"]}),routes:entries(bindings.schemas,bindings.adapter)});
   const ask=async(path:string,method:string,input?:unknown)=>{const response=(await fetch(new Request("https://app.test/admin/api"+path,{method,headers:{origin:"https://app.test"},...(input?{body:JSON.stringify(input)}:{})}),{}))!;const body:any=await response.json();return response.status===200?body.entry??body:{status:response.status,...body.error};};
   const create=(collection:string,data:object)=>ask("/entries","POST",{collection,data});
   const patch=(entry:{id:string;version:number},data:object)=>ask(`/entries/${entry.id}?collection=post_revisions`,"PATCH",{data,expectedVersion:entry.version});
   const remove=(entry:{id:string})=>ask(`/entries/${entry.id}?collection=post_revisions`,"DELETE");
   const r1=await create("post_revisions",{body:"one"}),r2=await create("post_revisions",{body:"two"});
   const post=await create("posts",{title:"post",current_revision:r1.id});
   // the editor and list know before the edit: the live revision is locked, another is not, a Schema without locks has no field
   const live={lock:"live_revision",message:lock("update").message},held={update:live,delete:live},free={update:false,delete:false};
   expect((await ask(`/entries/${r1.id}?collection=post_revisions`,"GET")).locks).toEqual(held);
   expect((await ask(`/entries/${r2.id}?collection=post_revisions`,"GET")).locks).toEqual(free);
   expect(post.locks).toBeUndefined();
   const listed=(await ask("/entries?collection=post_revisions","GET")).items;
   expect(Object.fromEntries(listed.map((row:any)=>[row.id,row.locks]))).toEqual({[r1.id]:held,[r2.id]:free});
   expect(listed[0].data).not.toHaveProperty("_mantle_admin_lock_update");
   expect(await patch(r1,{body:"x"})).toMatchObject({status:409,...lock("update")});
   expect(await remove(r1)).toMatchObject({status:409,...lock("delete")});
   expect((await patch(r2,{body:"draft"})).data).toMatchObject({body:"draft"});
   // the maintenance escape hatch: an explicit system write
   const revisions=bindings.schemas.find((s:any)=>s.name==="post_revisions");
   expect(await nativeEntryProcedure(revisions.binding,bindings.adapter,db,{kind:"system",reason:"fixture"},"patch",{body:"fixed"},r1.id,r1.version)).toMatchObject({body:"fixed"});
   // switch the post; the old revision is editable and deletable again
   expect((await ask(`/entries/${post.id}?collection=posts`,"PATCH",{data:{current_revision:r2.id},expectedVersion:post.version})).locks).toBeUndefined();
   // a written row's payload re-reads its locks
   expect((await patch(await ask(`/entries/${r1.id}?collection=post_revisions`,"GET"),{body:"free"})).locks).toEqual(free);
   expect(await remove({id:r1.id})).toEqual({affected:1});
   expect(await remove(r2)).toMatchObject({status:409,...lock("delete")});
  }finally{
   if(pg){await db.unsafe(`DROP SCHEMA IF EXISTS ${namespace} CASCADE`);await db.close();}else db.close();
   await rm(dir,{recursive:true,force:true});
  }
 },30000);
}
