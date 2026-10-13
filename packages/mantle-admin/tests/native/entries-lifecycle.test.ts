import {test,expect} from "bun:test";
import {Database} from "bun:sqlite";
import {mkdtemp,readFile,rm} from "node:fs/promises";
import {join} from "node:path";
import {admin as createAdmin} from "../../src/server/index.js";
import {entries} from "../../src/server/entries.js";
import {generateAdmin,writeAdminFixture} from "./generated-fixture.js";
import {admin} from "./server-native-scenarios.js";
const manifest=await readFile(join(import.meta.dir,"../../../mantle/tests/apps/translations.yaml"),"utf8");
test("a translation entry is read with its parent's fields and saved back unchanged, and a restored archive returns to draft",async()=>{
 const files=await generateAdmin("bun-sqlite",manifest),dir=await mkdtemp(join(import.meta.dir,"../../../mantle/tests/apps/.admin-lifecycle-")),db=new Database(":memory:");
 try{
  await writeAdminFixture(dir,files);db.exec(files["schema.sql"]!);
  const {adminBindings}=await import(join(dir,"admin-bindings.ts")),bindings=adminBindings();
  const fetch=createAdmin(bindings.metadata,bindings.views,bindings.operations,{db:()=>db,caller:()=>admin,routes:entries(bindings.schemas,bindings.adapter)});
  const ask=async(path:string,method="GET",body?:unknown)=>{const response=(await fetch(new Request("https://app.test/admin/api"+path,{method,headers:{origin:"https://app.test"},body:body===undefined?undefined:JSON.stringify(body)}),{}))!;return {status:response.status,body:await response.json() as any};};
  const parent=(await ask("/entries","POST",{collection:"posts",data:{slug:"same",title:"parent",cover:"cover A"}})).body.entry;
  expect((await ask(`/entries/${parent.id}/publish?collection=posts`,"POST",{})).status).toBe(200);
  const child=(await ask("/entries","POST",{collection:"translations",data:{slug:"same",locale:"fr",title:"traduction"}})).body.entry;
  const read=(await ask(`/entries/${child.id}?collection=translations`)).body.entry;
  expect(read.data.cover).toBe("cover A");
  // the SPA sends the whole read data back
  const saved=await ask(`/entries/${child.id}?collection=translations`,"PATCH",{expectedVersion:read.version,data:{...read.data,title:"traduction 2"}});
  expect(saved.status).toBe(200);expect(saved.body.entry.data).toMatchObject({title:"traduction 2",cover:"cover A"});
  // an inherited field that really changed is still refused, not silently dropped
  expect((await ask(`/entries/${child.id}?collection=translations`,"PATCH",{expectedVersion:saved.body.entry.version,data:{cover:"other"}})).status).toBe(400);
  // archive -> unpublish restores a draft
  const posted=await ask(`/entries/${parent.id}/archive?collection=posts`,"POST",{});expect(posted.body.entry.status).toBe("archived");
  const restored=await ask(`/entries/${parent.id}/unpublish?collection=posts`,"POST",{});expect(restored.status).toBe(200);expect(restored.body.entry.status).toBe("draft");
 }finally{db.close();await rm(dir,{recursive:true,force:true});}
},30000);
