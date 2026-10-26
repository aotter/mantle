import {expect,test} from "bun:test";
import {Database} from "bun:sqlite";
import {SQL} from "bun";
import {mkdtemp,rm} from "node:fs/promises";
import {join} from "node:path";
import {admin as createAdmin} from "../../src/server/index.js";
import {entries} from "../../src/server/entries.js";
import {generateAdmin,writeAdminFixture} from "./generated-fixture.js";
import {admin} from "./server-native-scenarios.js";

// #1787: the record form clears a field by sending null; a key it leaves out keeps the stored value.
const manifest=`apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: {name: owners}
spec:
 title: Owners
 lifecycle: operational
 schema: {type: object, required: [name], properties: {name: {type: string}}}
---
apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: {name: things}
spec:
 title: Things
 lifecycle: operational
 schema:
  type: object
  required: [name]
  properties:
   name: {type: string}
   note: {type: string, minLength: 1}
   email: {type: string, format: email}
   count: {type: integer}
   kind: {type: string, enum: [a, b]}
   due: {type: string, format: date-time}
   day: {type: string, format: date}
   ownerId: {type: string, x-mantle-ref: owners}
   meta: {type: object}
---
apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: {name: posts}
spec:
 title: Posts
 lifecycle: publishing
 schema: {type: object, required: [title, rank], properties: {title: {type: string}, rank: {type: integer}}}
`;
const optional={note:"hi",email:"a@b.test",count:3,kind:"a",due:"2026-10-25T08:00:00.000000Z",day:"2026-10-25",meta:{tags:["x"]}};

for(const target of ["bun-sqlite","bun-postgres"] as const){
 const url=process.env.MANTLE_NEXT_BUN_PG_URL;
 (target==="bun-sqlite"||url?test:test.skip)(`${target} Admin PATCH clears an optional field sent as null and keeps an omitted one`,async()=>{
  const files=await generateAdmin(target,manifest),dir=await mkdtemp(join(import.meta.dir,"../../../mantle/tests/apps/.admin-clear-null-"));
  const namespace="admin_clear_"+crypto.randomUUID().replaceAll("-",""),pg=target==="bun-postgres";
  const db:any=pg?new SQL(url!,{max:1}):new Database(":memory:");
  try{
   await writeAdminFixture(dir,files);
   if(pg){await db.unsafe(`CREATE SCHEMA ${namespace}`);await db.unsafe(`SET search_path TO ${namespace}`);await db.unsafe(files["schema.sql"]!);}else db.exec(files["schema.sql"]!);
   const {adminBindings}=await import(join(dir,"admin-bindings.ts")),bindings=adminBindings();
   const fetch=createAdmin(bindings.metadata,bindings.views,bindings.operations,{db:()=>db,caller:()=>admin,routes:entries(bindings.schemas,bindings.adapter)});
   const ask=async(path:string,method:string,input:unknown)=>{const response=(await fetch(new Request("https://app.test/admin/api"+path,{method,headers:{origin:"https://app.test"},body:JSON.stringify(input)}),{}))!;const body=await response.json();return response.status===200?body.entry:body.error.code;};
   const patch=(entry:{id:string;version:number},data:object)=>ask(`/entries/${entry.id}?collection=things`,"PATCH",{data,expectedVersion:entry.version});
   const owner=await ask("/entries","POST",{collection:"owners",data:{name:"o"}});
   const thing=await ask("/entries","POST",{collection:"things",data:{name:"t",...optional,ownerId:owner.id}});
   expect(thing.data).toMatchObject({name:"t",...optional,ownerId:owner.id});

   // one field at a time: null clears it, every key left out keeps its value
   let current=thing;
   for(const field of [...Object.keys(optional),"ownerId"]){
    const next=await patch(current,{[field]:null});
    expect(next.version).toBe(current.version+1);
    expect(next.data[field]).toBeNull();
    for(const kept of Object.keys(current.data).filter(key=>key!==field)) expect(next.data[kept]).toEqual(current.data[kept]);
    current=next;
   }
   expect(Object.entries(current.data).filter(([,value])=>value!==null).map(([key])=>key)).toEqual(["name"]);
   // clearing what is already null changes nothing: no new version
   expect((await patch(current,{note:null})).version).toBe(current.version);
   // the whole form at once, as the record form sends it: cleared fields null, the rest echoed
   const filled=await patch(current,{...optional,ownerId:owner.id});
   const echoed=await patch(filled,{...filled.data,note:null,count:null,ownerId:null});
   expect(echoed.data).toMatchObject({name:"t",note:null,count:null,ownerId:null,email:optional.email,kind:"a",due:optional.due,day:optional.day,meta:optional.meta});
   // a required field stays unclearable, and "" is not an empty constrained text (why the form sends null)
   expect(await patch(echoed,{name:null})).toBe("INPUT_VALIDATION_FAILED");
   for(const data of [{note:""},{email:""},{due:""},{day:""}]) expect(await patch(echoed,data)).toBe("INPUT_VALIDATION_FAILED");
   // a draft may lack a required field (Publish refuses it): null clears one there, and the person sees it empty, not the old value back
   const post=await ask("/entries","POST",{collection:"posts",data:{title:"p",rank:1}});
   const draft=await ask(`/entries/${post.id}?collection=posts`,"PATCH",{data:{title:null,rank:null},expectedVersion:post.version});
   expect(draft.data).toMatchObject({title:null,rank:null});
   expect(await ask(`/entries/${post.id}/publish?collection=posts`,"POST",{expectedVersion:draft.version})).toBe("INPUT_VALIDATION_FAILED");
  }finally{
   if(pg){await db.unsafe(`DROP SCHEMA IF EXISTS ${namespace} CASCADE`);await db.close();}else db.close();
   await rm(dir,{recursive:true,force:true});
  }
 },30000);
}
