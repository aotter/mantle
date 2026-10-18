import {expect,test} from "bun:test";
import {Database} from "bun:sqlite";
import {mkdtemp,rm} from "node:fs/promises";
import {join} from "node:path";
import {admin as createAdmin} from "../../src/server/index.js";
import {entries} from "../../src/server/entries.js";
import {generateAdmin,writeAdminFixture} from "./generated-fixture.js";
import {admin} from "./server-native-scenarios.js";

const manifest=`apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: {name: orders}
spec:
 title: Orders
 uniqueIndexes: [[orderRef]]
 schema:
  type: object
  required: [orderRef]
  properties: {orderRef: {type: string}, customer: {type: string}}
---
apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: {name: order_lines}
spec:
 title: Order lines
 uiSchema: {nav: {parentField: orderRef}}
 schema:
  type: object
  required: [orderRef, sku]
  properties: {orderRef: {type: string, x-mantle-ref: {schema: orders, field: orderRef}}, sku: {type: string}}
`;

test("a child folded by a unique-field reference is scoped by the parent's field value",async()=>{
 const files=await generateAdmin("bun-sqlite",manifest),dir=await mkdtemp(join(import.meta.dir,"../../../mantle/tests/apps/.admin-fold-ref-")),db=new Database(":memory:");
 try{
  await writeAdminFixture(dir,files); db.exec(files["schema.sql"]!);
  const {adminBindings}=await import(join(dir,"admin-bindings.ts")),bindings=adminBindings();
  const fetch=createAdmin(bindings.metadata,bindings.views,bindings.operations,{db:()=>db,caller:()=>admin,routes:entries(bindings.schemas,bindings.adapter)});
  const ask=async(path:string,method="GET",input?:unknown)=>{const response=(await fetch(new Request("https://app.test/admin/api"+path,{method,headers:{origin:"https://app.test"},body:input===undefined?undefined:JSON.stringify(input)}),{}))!;const body=await response.json();expect({status:response.status,body}).toMatchObject({status:200});return body;};
  const lines=bindings.metadata.collections.find((c:any)=>c.name==="order_lines");
  expect(lines.parent).toEqual({collection:"orders",parentField:"orderRef",childField:"orderRef"});
  const order=(await ask("/entries","POST",{collection:"orders",data:{orderRef:"ORD-1",customer:"Ada"}})).entry;
  const line=(await ask("/entries","POST",{collection:"order_lines",data:{orderRef:"ORD-1",sku:"A"}})).entry;
  const editor=await ask(`/entries/${order.id}?collection=orders`);
  const section=editor.related.find((s:any)=>s.collection.name==="order_lines");
  expect(section.relationship).toMatchObject({kind:"field",parentField:"orderRef",childField:"orderRef",parentValue:"ORD-1"});
  expect(section.entries.map((e:any)=>e.id)).toEqual([line.id]);
  const scoped=await ask("/entries?collection=order_lines&scope_field=orderRef&scope_value=ORD-1");
  expect(scoped.items.map((e:any)=>e.id)).toEqual([line.id]);
  const child=await ask(`/entries/${line.id}?collection=order_lines`);
  expect(child.parentEntryId).toBe(order.id);
 }finally{db.close();await rm(dir,{recursive:true,force:true});}
},30000);
