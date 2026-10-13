import assert from "node:assert/strict";
import {admin} from "../../src/server/index.js";
import {extensionOptions} from "../../src/server/extensions.js";
import {nativeEntryGet,nativeEntryPage,nativeEntryProcedure} from "../../src/server/native.js";
import {entries} from "../../src/server/entries.js";
import {ContractError} from "@aotter/mantle/contracts";
export const staff={kind:"user" as const,subject:"owner-a",role:"staff",scopes:[],credential:"session" as const,credentialId:null,clientId:null};
export const manifest=`apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: {name: notes}
spec:
 title: Notes
 lifecycle: operational
 scope: {owner: auth.uid()}
 indexes: [[owner, title]]
 schema: {type: object, required: [owner, title], properties: {owner: {type: string}, title: {type: string}, _k0: {type: string}, _k1: {type: string}}}
---
apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: {name: posts}
spec:
 title: Posts
 lifecycle: publishing
 scope: {owner: auth.uid()}
 indexes: [[owner,title]]
 schema: {type: object, required: [owner,title], properties: {owner: {type: string}, title: {type: string}}}
`;
export const refManifest=manifest+`---
apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: {name: edit-note}
spec:
 requires: {auth: {all: [{ctx.staff: [staff]}]}}
 input: {type: object, properties: {id: {type: string}, title: {type: string}}, required: [id,title], additionalProperties: false}
 output: {type: object, properties: {title: {type: string}}, required: [title]}
 handler: {ref: app.editNote}
---
apiVersion: cms.mantle.aotter.net/v2
kind: Trigger
metadata: {name: edit-note-mcp}
spec: {source: {kind: mcp, surface: staff}, target: {procedure: edit-note}}
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
 const create=(caller:typeof staff,title:string)=>nativeEntryProcedure(notes.binding,adapter,handle,caller,"create",notes.values(notes.validate({title,_k0:"field-key:"+title,_k1:"field-id:"+title},true)));
 const a=await create(staff,"first"),b=await create({...staff,subject:"owner-b"},"other owner");
   const fetch=admin(bindings.metadata,bindings.views,bindings.operations,{db:()=>{providers++;return handle;},caller:()=>staff,handlers,routes:entries(specs,adapter)});
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
   assert.equal((await ask(`/entries/${a.id}?collection=notes`,"PATCH",{expectedVersion:1,data:{title:"stale"}}))?.status,409);assert.equal(notes.row(await nativeEntryGet(notes.binding,adapter,handle,staff,a.id)).title,"second");
   before=reads();const noop=await ask(`/entries/${a.id}?collection=notes`,"PATCH",{expectedVersion:2,data:{}});assert.equal(noop?.status,200);assert.equal((await noop!.json()).entry.version,2);assert.equal(reads()-before,1);
   const searches=await(await ask("/entries?collection=notes&q="+a.id))!.json();assert.deepEqual(searches.items.map((row:any)=>row.id),[a.id]);
   assert.deepEqual((await(await ask("/entries?collection=notes&q="+b.id))!.json()).items,[]);
   before=reads();const beforeProviders=providers;
   assert.equal((await ask("/operations/edit-note","POST",{id:a.id}))?.status,400);assert.equal(providers,beforeProviders);assert.equal(reads(),before);
   const ref=await ask("/operations/edit-note","POST",{id:a.id,title:"ref changed"});assert.equal(ref?.status,200);assert.deepEqual(await ref!.json(),{ok:true,output:{title:"ref changed"}});assert.equal(reads()-before,1);
   before=reads();assert.equal((await ask("/operations/edit-note","POST",{id:b.id,title:"foreign write"}))?.status,404);assert.equal(reads()-before,1);
   assert.equal((await nativeEntryGet(notes.binding,adapter,handle,{...staff,subject:"owner-b"},b.id)).title,"other owner");
   before=reads();const providerBeforeStats=providers;
   assert.equal((await ask("/collections/notes/statistics?range=unknown"))?.status,400);assert.equal(providers,providerBeforeStats);assert.equal(reads(),before);
   const statistics=await ask("/collections/notes/statistics?range=1h");assert.equal(statistics?.status,200);const counts=await statistics!.json();assert.equal(counts.total,1);assert.equal(counts.buckets.reduce((sum:number,bucket:any)=>sum+bucket.count,0),1);assert.equal(reads()-before,1);

   const draft=await(await ask("/entries","POST",{collection:"posts",data:{title:"Draft"}}))!.json();assert.equal(draft.entry.status,"draft");
   const published=await ask(`/entries/${draft.entry.id}/publish?collection=posts`,"POST",{});assert.equal(published?.status,200);assert.equal((await published!.json()).entry.status,"published");
   assert.equal((await ask(`/entries/${draft.entry.id}?collection=posts`,"PATCH",{expectedVersion:2,data:{title:"forbidden"}}))?.status,409);
   const archived=await ask(`/entries/${draft.entry.id}/archive?collection=posts`,"POST",{});assert.equal(archived?.status,200);assert.equal((await archived!.json()).entry.status,"archived");


 const removable=await create(staff,"removable");
 const q=notes.query(new URLSearchParams({sort:"id",limit:"1"})),firstPage=await nativeEntryPage(notes.binding,adapter,()=>handle,staff,q);assert.ok(firstPage.nextCursor);
 const secondPage=await nativeEntryPage(notes.binding,adapter,()=>handle,staff,{...q,cursor:firstPage.nextCursor}),authored=new Map([[a.id,["field-key:first","field-id:first"]],[removable.id,["field-key:removable","field-id:removable"]]]);
 assert.equal(firstPage.rows.length+secondPage.rows.length,2);for(const row of [...firstPage.rows,...secondPage.rows])assert.deepEqual([row._k0,row._k1],authored.get(String(row.id)));
 let invalidProviders=0;before=reads();
 const provider=()=>{invalidProviders++;return handle;};
 await assert.rejects(()=>nativeEntryPage(notes.binding,adapter,provider,{...staff,subject:"owner-b"},{...q,cursor:firstPage.nextCursor}),(error:any)=>error.code==="INPUT_VALIDATION_FAILED");
 const foreignFilter=notes.query(new URLSearchParams({sort:"id",limit:"1",filter_field:"title",filter_value:"second",cursor:firstPage.nextCursor}));
 await assert.rejects(()=>nativeEntryPage(notes.binding,adapter,provider,staff,foreignFilter),(error:any)=>error.code==="INPUT_VALIDATION_FAILED");assert.equal(invalidProviders,0);assert.equal(reads(),before);
 const forgedId=JSON.parse(decodeURIComponent(firstPage.nextCursor));forgedId[0]="another-id";
 await assert.rejects(()=>nativeEntryPage(notes.binding,adapter,provider,staff,{...q,cursor:encodeURIComponent(JSON.stringify(forgedId))}),(error:any)=>error.code==="INPUT_VALIDATION_FAILED");
 for(const filter of [null,{}, {in:null}, {in:[]}, {in:[NaN]}])await assert.rejects(()=>nativeEntryPage(notes.binding,adapter,provider,staff,{...q,match:{filters:{title:filter}}}),(error:any)=>error.code==="INPUT_VALIDATION_FAILED");
 assert.equal(invalidProviders,0);assert.equal(reads(),before);
 before=reads();const removed=await ask(`/entries/${removable.id}?collection=notes`,"DELETE");assert.equal(removed?.status,200);assert.deepEqual(await removed!.json(),{affected:1});assert.equal(reads()-before,1);assert.equal(await nativeEntryGet(notes.binding,adapter,handle,staff,removable.id),null);
await verifyExtensionVersions(notes,adapter,handle,reads);
return {ok:true,checks:14,extensionLocks:true};
}

/** Real generated Procedure writes, not a mocked SQL adapter. */
async function verifyExtensionVersions(notes:any,adapter:any,handle:any,reads:()=>number){
 const row=await nativeEntryProcedure(notes.binding,adapter,handle,staff,"create",notes.values(notes.validate({title:"extension before"},true)));
 let providers=0,attempts=0;
 const declaration={apiVersion:1 as const,id:"versions",title:"Versions",contributes:{}};
 const facets=extensionOptions([{id:"versions",declaration:JSON.stringify(declaration),public:declaration,source:false,settings:[],actions:[{id:"change",target:"record/v1",schema:["notes"]}]}],{},[{...declaration,handlers:{actions:{change:{run:async(caller,input,ctx)=>{
  attempts++;const record=input.record!;
  const changed=await nativeEntryProcedure(notes.binding,adapter,ctx.db,caller,"patch",notes.values(notes.validate({title:"extension safe"},false)),record.id,record.version!);
  return {version:String(changed.version),lock:record.version};
 }}}}}]);
 const fetch=admin({collections:[],views:[],operations:[],webmcp:{tools:[],routes:{}}},[],[],{db:()=>{providers++;return handle;},caller:()=>staff,routes:facets.routes});
 const ask=(version:number|string)=>fetch(new Request("https://app.test/admin/api/x/versions/actions/change",{method:"POST",headers:{origin:"https://app.test"},body:JSON.stringify({record:{schema:"notes",id:row.id,version}})}),{});
 const before=reads();
 for(const version of [Number.MAX_SAFE_INTEGER+1,"9007199254740993"]){assert.equal((await ask(version))?.status,400);assert.equal(providers,0);assert.equal(attempts,0);assert.equal(reads(),before);}
 assert.equal((await nativeEntryGet(notes.binding,adapter,handle,staff,row.id)).title,"extension before");
 const first=await ask(1);assert.equal(first?.status,200);assert.deepEqual((await first!.json()).result,{version:"2",lock:1});
 assert.equal((await ask(1))?.status,409);
 const second=await ask(2);assert.equal(second?.status,200);assert.deepEqual((await second!.json()).result,{version:"3",lock:2});
 assert.equal(String((await nativeEntryGet(notes.binding,adapter,handle,staff,row.id)).version),"3");
 assert.equal(providers,3);assert.equal(attempts,3);
}
