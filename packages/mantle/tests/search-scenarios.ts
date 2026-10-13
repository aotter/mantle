/** The same search contract runs on all four native hosts. */
import assert from "node:assert/strict";
export async function verifySearch(app: any, db: any) {
  const owner = {kind:"user",subject:"search-owner",role:"staff",scopes:[],credential:"session",credentialId:null,clientId:null};
  const store=app.store(db,owner), collection=store.collection("search_records");
  const a=await collection.insert({title:"Alpha%_one",body:"Alpha twice"});
  const b=await collection.insert({title:'Beta "OR" quote',body:"小籠包"});
  const c=await collection.insert({title:"a\\b",body:null});
  const foreign=await app.store(db,{...owner,subject:"search-other"}).collection("search_records").insert({title:"Alpha foreign"});
  const expired=await collection.insert({title:"Alpha expired",expiresat:"2000-01-01T00:00:00Z"});
  for (const row of [foreign, expired]) assert.equal((await collection.find({search:row.id})).rows.length, 0);
  let checks=0;
  for(const text of ["Alpha","ALPHA","a","小籠","%_","Alpha%_",'"OR"',"a\\b",a.id,"missing"]){
    const result=await collection.find({search:text});
    const reference=await app.views["searched-records"](db,owner,{q:text});
    assert.deepEqual(result.rows.map((r:any)=>r.id),reference.map((r:any)=>r.id));
    assert.ok(reference.every((r:any)=>typeof r.rank==="number"&&r.rank<=0));
    checks++;
  }
  assert.deepEqual((await collection.find({search:"  Alpha  "})).rows.map((r:any)=>r.id),[a.id]);
  assert.equal((await collection.first({search:"小籠"})).id,b.id);
  assert.equal((await collection.find({search:"Alpha",where:{title:"unrelated"}})).rows.length,0);
  const ids: string[]=[];let cursor:string|undefined;
  do {const page=await collection.find({search:"a",limit:1,cursor});ids.push(...page.rows.map((r:any)=>r.id));cursor=page.cursor??undefined;}while(cursor);
  assert.deepEqual(ids,[a.id,b.id,c.id].sort());
  const changed=await collection.update(a.id,{title:"Renamed",body:null},{lock:1});
  assert.equal(Number(changed.version),2);
  assert.equal((await collection.find({search:"Alpha"})).rows.length,0);
  assert.equal((await collection.first({search:"Renamed"})).id,a.id);
  await assert.rejects(async()=>collection.update(a.id,{title:"bad"},{lock:1}),{code:"CONFLICT"});
  await collection.delete(a.id,{lock:2});assert.equal((await collection.find({search:"Renamed"})).rows.length,0);
  await assert.rejects(()=>store.batch([collection.update(b.id,{title:"Rollback marker"},{lock:1}),collection.update(c.id,{title:"bad"},{lock:99})]),{code:"CONFLICT"});
  assert.equal((await collection.find({search:"Rollback"})).rows.length,0);
  assert.equal((await collection.first({search:"Beta"})).id,b.id);
  for(const search of ["","  ",42,null,"\0","Alpha\0"])await assert.rejects(()=>collection.find({search}),{code:"INPUT_VALIDATION_FAILED"});
  const idOnly=store.collection("search_ids"),record=await idOnly.insert({title:"Alpha"});
  assert.equal((await idOnly.find({search:"Alpha"})).rows.length,0);
  assert.equal((await idOnly.first({search:record.id})).id,record.id);
  const posts=store.collection("search_posts"),draft=await posts.insert({title:"Visible search"}),published=await posts.insert({title:"Visible search"});
  await store.procedures["search_posts.publish"]({id:published.id,expectedVersion:1});
  assert.equal((await posts.find({search:"Visible"})).rows.length,2);
  assert.deepEqual((await app.store(db,{kind:"anonymous"}).collection("search_posts").find({search:"Visible"})).rows.map((r:any)=>r.id),[published.id]);
  assert.equal((await app.store(db,{kind:"anonymous"}).collection("search_posts").find({search:draft.id})).rows.length,0);
  assert.ok(draft.id!==published.id);
  return {checks:checks+26};
}
