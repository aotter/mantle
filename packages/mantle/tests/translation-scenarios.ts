import { fixtureCaller as mintFixtureCaller } from "./apps/fixtures.js";
/** The same native state/visibility checks run on SQLite, PostgreSQL and local D1. */
import assert from "node:assert/strict";
export async function verifyTranslations(app:any,locales:any,db:any,factory?:Parameters<typeof mintFixtureCaller>[1]):Promise<void> {
 const fixtureCaller = <T extends Parameters<typeof mintFixtureCaller>[0]>(caller:T):T => mintFixtureCaller(caller,factory);
 const state=async(table:string,id:string)=>{const text=`SELECT status,version FROM ${table} WHERE id = ?`;return db.batch?(await db.prepare(text).bind(id).all()).results[0]:db.unsafe?(await db.unsafe(text.replace("?","$1"),[id]))[0]:db.query(text).all(id)[0];};
 const admin=fixtureCaller({kind:"user",subject:"a",role:"admin",admin:true,scopes:[],credential:"session",credentialId:null,clientId:null}),store=app.store(db,admin),other=app.store(db,fixtureCaller({...admin,subject:"b"}));
 const parent=await store.collection("posts").insert({slug:"shared",title:"parent",cover:"parent-cover"}),child=await store.collection("translations").insert({slug:"shared",locale:"zh_TW",title:"child"});assert.equal(child.locale,"zh_TW");
 const foreign=await other.collection("posts").insert({slug:"shared",title:"foreign",cover:"foreign-cover"});await other.procedures["posts.publish"]({id:foreign.id,expectedVersion:1});const foreignChild=await other.collection("translations").insert({slug:"shared",locale:"fr",title:"private foreign"});await other.procedures["translations.publish"]({id:foreignChild.id,expectedVersion:1});
 const system={kind:"system",reason:"translation tenant regression"},systemStore=app.store(db,system);
 const future="UPDATE posts SET created_at = "+(db.unsafe?"created_at + INTERVAL '100 years'":"created_at + 1000000000000")+" WHERE id = ?";
 if(db.batch)await db.prepare(future).bind(foreign.id).run();else if(db.unsafe)await db.unsafe(future.replace("?","$1"),[foreign.id]);else db.query(future).run(foreign.id);
 await assert.rejects(systemStore.procedures["translations.publish"]({id:child.id,expectedVersion:1}),{code:"CONFLICT"});
 const systemChild=await systemStore.collection("translations").findById(child.id);assert.equal(systemChild.cover,"parent-cover");assert.equal(systemChild.title,"child");assert.equal(systemChild.id,child.id);
 await assert.rejects(store.procedures["translations.publish"]({id:child.id,expectedVersion:1}),{code:"CONFLICT"});
 await store.procedures["posts.publish"]({id:parent.id,expectedVersion:1});await store.procedures["translations.publish"]({id:child.id,expectedVersion:1});await store.procedures["translations.unpublish"]({id:child.id,expectedVersion:2});
 if(store.transaction)for(const reverse of [false,true])await assert.rejects(store.transaction(async(tx:any)=>{
  if(reverse){await tx.procedures["translations.publish"]({id:child.id,expectedVersion:3});await tx.procedures["posts.unpublish"]({id:parent.id,expectedVersion:2});}
  else{await tx.procedures["posts.unpublish"]({id:parent.id,expectedVersion:2});await tx.procedures["translations.publish"]({id:child.id,expectedVersion:3});}
 }),{code:"INPUT_VALIDATION_FAILED"});
 assert.equal(Number((await state("posts",parent.id)).version),2);assert.equal((await state("translations",child.id)).status,"draft");
 const sibling=await store.collection("posts").insert({slug:"shared",title:"sibling",cover:"sibling-cover"});await store.procedures["posts.unpublish"]({id:parent.id,expectedVersion:2});await assert.rejects(store.procedures["translations.publish"]({id:child.id,expectedVersion:3}),{code:"CONFLICT"});await store.procedures["posts.publish"]({id:sibling.id,expectedVersion:1});await store.procedures["translations.publish"]({id:child.id,expectedVersion:3});
 const page=[{id:parent.id,slug:"shared"},{id:"missing",slug:"unknown"}];assert.deepEqual(await locales(db,admin,"posts",page),{[parent.id]:["zh_TW"],missing:[]});assert.deepEqual(await locales(db,{kind:"anonymous"},"posts",page),{[parent.id]:[],missing:[]});
 const reader=fixtureCaller({...admin,role:null,admin:false}),read=app.store(db,reader),preview=app.store(db,{kind:"system",reason:"translation preview"});
 const visible=async(expected:boolean)=>{
  assert.equal(!!await read.collection("translations").findById(child.id),expected);
  assert.equal((await read.collection("translations").find()).rows.length,expected?1:0);
  assert.equal(!!await read.collection("translations").first(),expected);
  assert.equal(await read.collection("translations").count(),expected?1:0);
  assert.equal((await app.views.translated(db,reader,{})).length,expected?1:0);
  if(!expected){await assert.rejects(async()=>await read.collection("translations").update(child.id,{title:"blocked"},{lock:4}),{code:"CONFLICT"});await assert.rejects(async()=>await read.collection("translations").delete(child.id,{lock:4}),{code:"CONFLICT"});}
  assert.deepEqual(await locales(db,reader,"posts",page),{[parent.id]:expected?["zh_TW"]:[],missing:[]});
 };
 await visible(true);assert.equal((await store.collection("translations").find()).rows.length,1);
 await store.procedures["posts.publish"]({id:parent.id,expectedVersion:3});await visible(true); // two visible parents must not multiply child rows
 await store.procedures["posts.unpublish"]({id:parent.id,expectedVersion:4});
 const merged=await read.collection("translations").findById(child.id);assert.equal(merged.cover,"sibling-cover");assert.equal(merged.title,"child");assert.equal(merged.id,child.id);assert.equal(merged.owner,undefined);
 assert.equal((await app.views.translated(db,reader,{}))[0].cover,undefined); // authored SELECT keeps its projection
 await store.procedures["posts.unpublish"]({id:sibling.id,expectedVersion:2});await visible(false);
 assert.equal((await state("translations",child.id)).status,"published");assert.ok(await store.collection("translations").findById(child.id));assert.ok(await preview.collection("translations").findById(child.id));
 await store.procedures["posts.publish"]({id:sibling.id,expectedVersion:3});await visible(true);
 await store.procedures["posts.archive"]({id:sibling.id,expectedVersion:4});await visible(false);assert.ok(await store.collection("translations").findById(child.id));
 await store.procedures["translations.unpublish"]({id:child.id,expectedVersion:4});assert.deepEqual(await locales(db,fixtureCaller({...admin,role:null,admin:false}),"posts",page),{[parent.id]:[],missing:[]});
 if(store.transaction){
  const p=await store.collection("posts").insert({slug:"reset",title:"tracker"}),c=await store.collection("translations").insert({slug:"reset",locale:"fr",title:"tracker"});await store.procedures["posts.publish"]({id:p.id,expectedVersion:1});
  await store.transaction(async(tx:any)=>{await assert.rejects(tx.procedures["translations.publish"]({id:c.id,expectedVersion:99}),{code:"CONFLICT"});await tx.procedures["posts.unpublish"]({id:p.id,expectedVersion:2});});
  await store.procedures["posts.publish"]({id:p.id,expectedVersion:3});
  await assert.rejects(store.transaction(async(tx:any)=>{await tx.procedures["translations.publish"]({id:c.id,expectedVersion:1});await assert.rejects(tx.procedures["translations.publish"]({id:c.id,expectedVersion:1}),{code:"CONFLICT"});await tx.procedures["posts.unpublish"]({id:p.id,expectedVersion:4});}),{code:"INPUT_VALIDATION_FAILED"});
  assert.equal((await state("translations",c.id)).status,"draft");assert.equal((await state("posts",p.id)).status,"published");
 }
 await assert.rejects(locales(db,admin,"posts",Array.from({length:501},(_,i)=>({id:String(i),slug:String(i)}))),{code:"INPUT_VALIDATION_FAILED"});
}
