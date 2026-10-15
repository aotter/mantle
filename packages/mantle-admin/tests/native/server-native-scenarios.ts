import { sdkFixtureCaller as fixtureCaller } from "../../../mantle/tests/apps/fixtures.js";
import assert from "node:assert/strict";
import { admin as adminFunction} from "../../src/server/index.js";
import {nativeEntryGet,nativeEntryPage,nativeEntryProcedure} from "../../src/server/native.js";
import {entries} from "../../src/server/entries.js";
import {ContractError} from "@aotter/mantle/contracts";
export const admin=fixtureCaller({kind:"user" as const,subject:"owner-a",role:"admin", admin: true,scopes:[],credential:"session" as const,credentialId:null,clientId:null});
export const manifest=`apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: {name: notes}
spec:
 title: Notes
 lifecycle: operational
 scope: "owner = auth.uid()"
 indexes: [[owner, title]]
 schema: {type: object, required: [owner, title], properties: {owner: {type: string}, title: {type: string}, _k0: {type: string}, _k1: {type: string}}}
---
apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: {name: posts}
spec:
 title: Posts
 lifecycle: publishing
 scope: "owner = auth.uid()"
 indexes: [[owner,title]]
 schema: {type: object, required: [owner,title], properties: {owner: {type: string}, title: {type: string}}}
`;
export const refManifest=manifest+`---
apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: {name: edit-note}
spec:
 requires: {auth: {all: [ctx.admin]}}
 input: {type: object, properties: {id: {type: string}, title: {type: string}}, required: [id,title], additionalProperties: false}
 output: {type: object, properties: {title: {type: string}}, required: [title]}
 handler: {ref: app.editNote}
---
apiVersion: cms.mantle.aotter.net/v2
kind: Trigger
metadata: {name: edit-note-mcp}
spec: {source: {kind: mcp, surface: admin}, target: {procedure: edit-note}}
`;
/** Uses the existing ref dispatcher and its real Store, including scoped reads and OCC. */
export const handlers={"edit-note":async(ctx:any,input:{id:string;title:string})=>{
 const notes=ctx.store.collection("notes"),row=await notes.findById(input.id);
 if(!row)throw new ContractError("NOT_FOUND","No such note.","notes");
 const changed=await notes.update(input.id,{title:input.title},{lock:row.version});
 return {title:changed.title};
}};
export async function verifyAdminBindings(bindings:any,handle:any,reads:()=>number){
 const specs=bindings.schemas,adapter=bindings.adapter,notes=specs.find((schema:any)=>schema.name==="notes");let providers=0;
 const create=(caller:typeof admin,title:string)=>nativeEntryProcedure(notes.binding,adapter,handle,caller,"create",notes.values(notes.validate({title,_k0:"field-key:"+title,_k1:"field-id:"+title},true)));
 const a=await create(admin,"first"),b=await create(fixtureCaller({...admin,subject:"owner-b"}),"other owner");
   const fetch=adminFunction(bindings.metadata,bindings.views,bindings.operations,{db:()=>{providers++;return handle;},caller:()=>admin,handlers,routes:entries(specs,adapter)});
   const ask=(path:string,method="GET",body?:unknown)=>fetch(new Request("https://app.test/admin/api"+path,{method,headers:{origin:"https://app.test"},body:body===undefined?undefined:JSON.stringify(body)}),{});
   let before=reads();
   const bootstrap=await(await ask("/bootstrap"))!.json();assert.equal(Object.hasOwn(bootstrap,"entries"),false);assert.equal(providers,0);assert.equal(reads(),before);
   for(const path of ["/entries?collection=unknown","/entries?collection=notes&limit=0","/entries?collection=notes&sort=unknown","/entries?collection=notes&filter_field=unknown&filter_value=x"]){assert.equal((await ask(path))?.status,path.includes("collection=unknown")?404:400);assert.equal(providers,0);assert.equal(reads(),before);}
   const empty=await ask('/entries?collection=notes&filter_field=title&filter_values=%5B%22other%22%5D&scope_field=title&scope_value=first&sort=unknown');assert.equal(empty?.status,200);assert.deepEqual((await empty!.json()).items,[]);assert.equal(providers,0);assert.equal(reads(),before);
   const response=await ask("/entries?collection=notes&limit=1");const item=(await response!.json()).items[0];assert.equal(item.id,a.id);assert.equal(item.data._k0,"field-key:first");assert.equal(item.data._k1,"field-id:first");assert.equal(reads()-before,1);
   assert.equal((await ask(`/entries/${b.id}?collection=notes`))?.status,404);
   const beforeInvalidLock=providers;before=reads();
   for(const expectedVersion of [Number.MAX_SAFE_INTEGER+1,"9223372036854775808"]){assert.equal((await ask(`/entries/${a.id}?collection=notes`,"PATCH",{expectedVersion,data:{title:"rounded lock"}}))?.status,400);assert.equal(providers,beforeInvalidLock);assert.equal(reads(),before);}
   before=reads();const changed=await ask(`/entries/${a.id}?collection=notes`,"PATCH",{expectedVersion:1,data:{title:"second"}});assert.equal(changed?.status,200);assert.equal((await changed!.json()).entry.data.title,"second");assert.equal(reads()-before,1);
   assert.equal((await ask(`/entries/${a.id}?collection=notes`,"PATCH",{expectedVersion:1,data:{title:"stale"}}))?.status,409);assert.equal(notes.row(await nativeEntryGet(notes.binding,adapter,handle,admin,a.id)).title,"second");
   before=reads();const noop=await ask(`/entries/${a.id}?collection=notes`,"PATCH",{expectedVersion:2,data:{}});assert.equal(noop?.status,200);assert.equal((await noop!.json()).entry.version,2);assert.equal(reads()-before,1);
   const searches=await(await ask("/entries?collection=notes&q="+a.id))!.json();assert.deepEqual(searches.items.map((row:any)=>row.id),[a.id]);
   assert.deepEqual((await(await ask("/entries?collection=notes&q="+b.id))!.json()).items,[]);
   before=reads();const beforeProviders=providers;
   assert.equal((await ask("/operations/edit-note","POST",{id:a.id}))?.status,400);assert.equal(providers,beforeProviders);assert.equal(reads(),before);
   const ref=await ask("/operations/edit-note","POST",{id:a.id,title:"ref changed"});assert.equal(ref?.status,200);assert.deepEqual(await ref!.json(),{ok:true,output:{title:"ref changed"}});assert.equal(reads()-before,1);
   before=reads();assert.equal((await ask("/operations/edit-note","POST",{id:b.id,title:"foreign write"}))?.status,404);assert.equal(reads()-before,1);
   assert.equal((await nativeEntryGet(notes.binding,adapter,handle,fixtureCaller({...admin,subject:"owner-b"}),b.id)).title,"other owner");
   before=reads();const providerBeforeStats=providers;
   assert.equal((await ask("/collections/notes/statistics?range=unknown"))?.status,400);assert.equal(providers,providerBeforeStats);assert.equal(reads(),before);
   const statistics=await ask("/collections/notes/statistics?range=1h");assert.equal(statistics?.status,200);const counts=await statistics!.json();assert.equal(counts.total,1);assert.equal(counts.buckets.reduce((sum:number,bucket:any)=>sum+bucket.count,0),1);assert.equal(reads()-before,1);
   const download=await ask("/entries/export?collection=notes");assert.equal(download?.status,200);const text=await download!.text();assert.ok(text.includes("ref changed"));assert.ok(!text.includes("other owner"));

   const draft=await(await ask("/entries","POST",{collection:"posts",data:{title:"Draft"}}))!.json();assert.equal(draft.entry.status,"draft");
   const published=await ask(`/entries/${draft.entry.id}/publish?collection=posts`,"POST",{});assert.equal(published?.status,200);assert.equal((await published!.json()).entry.status,"published");
   assert.equal((await ask(`/entries/${draft.entry.id}?collection=posts`,"PATCH",{expectedVersion:2,data:{title:"forbidden"}}))?.status,409);
   const archived=await ask(`/entries/${draft.entry.id}/archive?collection=posts`,"POST",{});assert.equal(archived?.status,200);assert.equal((await archived!.json()).entry.status,"archived");


 const removable=await create(admin,"removable");
 const q=notes.query(new URLSearchParams({sort:"id",limit:"1"})),firstPage=await nativeEntryPage(notes.binding,adapter,()=>handle,admin,q);assert.ok(firstPage.nextCursor);
 const secondPage=await nativeEntryPage(notes.binding,adapter,()=>handle,admin,{...q,cursor:firstPage.nextCursor}),authored=new Map([[a.id,["field-key:first","field-id:first"]],[removable.id,["field-key:removable","field-id:removable"]]]);
 assert.equal(firstPage.rows.length+secondPage.rows.length,2);for(const row of [...firstPage.rows,...secondPage.rows])assert.deepEqual([row._k0,row._k1],authored.get(String(row.id)));
 let invalidProviders=0;before=reads();
 const provider=()=>{invalidProviders++;return handle;};
 await assert.rejects(()=>nativeEntryPage(notes.binding,adapter,provider,fixtureCaller({...admin,subject:"owner-b"}),{...q,cursor:firstPage.nextCursor}),(error:any)=>error.code==="INPUT_VALIDATION_FAILED");
 const foreignFilter=notes.query(new URLSearchParams({sort:"id",limit:"1",filter_field:"title",filter_value:"second",cursor:firstPage.nextCursor}));
 await assert.rejects(()=>nativeEntryPage(notes.binding,adapter,provider,admin,foreignFilter),(error:any)=>error.code==="INPUT_VALIDATION_FAILED");assert.equal(invalidProviders,0);assert.equal(reads(),before);
 const forgedId=JSON.parse(decodeURIComponent(firstPage.nextCursor));forgedId[0]="another-id";
 await assert.rejects(()=>nativeEntryPage(notes.binding,adapter,provider,admin,{...q,cursor:encodeURIComponent(JSON.stringify(forgedId))}),(error:any)=>error.code==="INPUT_VALIDATION_FAILED");
 for(const filter of [null,{}, {in:null}, {in:[]}, {in:[NaN]}])await assert.rejects(()=>nativeEntryPage(notes.binding,adapter,provider,admin,{...q,match:{filters:{title:filter}}}),(error:any)=>error.code==="INPUT_VALIDATION_FAILED");
 assert.equal(invalidProviders,0);assert.equal(reads(),before);
 before=reads();const removed=await ask(`/entries/${removable.id}?collection=notes`,"DELETE");assert.equal(removed?.status,200);assert.deepEqual(await removed!.json(),{affected:1});assert.equal(reads()-before,1);assert.equal(await nativeEntryGet(notes.binding,adapter,handle,admin,removable.id),null);
return {ok:true,checks:14};
}
