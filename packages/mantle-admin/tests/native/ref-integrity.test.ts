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

// #1761: Admin's generic create and patch check an x-mantle-ref to a scoped Schema like the Store does (ADR-0034 §8).
const schema=(name:string,scope:string,key:string,properties:string,required:string)=>`apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: {name: ${name}}
spec:
 title: ${name}
 lifecycle: operational
 scope: "${scope}"
 indexes: [[${key}, id]]
 schema: {type: object, required: [${required}], properties: {${properties}}}
`;
const manifest=[
 schema("clients","rep IN auth.user('rep')","rep","rep: {type: string}, name: {type: string}, code: {type: string}","rep, name").replace(" indexes:"," uniqueIndexes: [[code]]\n indexes:"),
 schema("contacts","rep IN auth.user('rep')","rep","rep: {type: string}, name: {type: string}, client_id: {type: string, x-mantle-ref: clients}, client_code: {type: string, x-mantle-ref: {schema: clients, field: code}}","rep, name"),
 schema("lists","owner = auth.uid()","owner","owner: {type: string}, name: {type: string}","owner, name"),
 schema("items","owner = auth.uid()","owner","owner: {type: string}, name: {type: string}, list_id: {type: string, x-mantle-ref: lists}","owner, name"),
].join("---\n");
const fields={rep:{type:"string" as const,multiple:true}};
const caller=(id:string,rep:unknown)=>userCaller({id,rep,role:"admin"},{fields,adminRoles:["admin"]});

for(const target of ["bun-sqlite","bun-postgres"] as const){
 const url=process.env.MANTLE_NEXT_BUN_PG_URL;
 (target==="bun-sqlite"||url?test:test.skip)(`${target} Admin create and patch check a reference to a scoped Schema`,async()=>{
  const files=await generateAdmin(target,manifest),dir=await mkdtemp(join(import.meta.dir,"../../../mantle/tests/apps/.admin-ref-integrity-"));
  const namespace="admin_ref_"+crypto.randomUUID().replaceAll("-",""),pg=target==="bun-postgres";
  const db:any=pg?new SQL(url!,{max:1}):new Database(":memory:");
  try{
   await writeAdminFixture(dir,files);
   if(pg){await db.unsafe(`CREATE SCHEMA ${namespace}`);await db.unsafe(`SET search_path TO ${namespace}`);await db.unsafe(files["schema.sql"]!);}else db.exec(files["schema.sql"]!);
   const {adminBindings}=await import(join(dir,"admin-bindings.ts")),bindings=adminBindings();
   const as=(who:ReturnType<typeof caller>)=>{
    const fetch=createAdmin(bindings.metadata,bindings.views,bindings.operations,{db:()=>db,caller:()=>who,routes:entries(bindings.schemas,bindings.adapter)});
    return async(path:string,method:string,input:unknown)=>{const response=(await fetch(new Request("https://app.test/admin/api"+path,{method,headers:{origin:"https://app.test"},body:JSON.stringify(input)}),{}))!;const body=await response.json();return response.status===200?body.entry:body.error.code;};
   };
   const a=as(caller("a","A")),b=as(caller("b","B")),both=as(caller("both",["A","B"])),every=as(caller("every",{all:true}));
   const create=(ask:ReturnType<typeof as>,collection:string,data:object)=>ask("/entries","POST",{collection,data});
   const patch=(ask:ReturnType<typeof as>,collection:string,entry:{id:string;version:number},data:object)=>ask(`/entries/${entry.id}?collection=${collection}`,"PATCH",{data,expectedVersion:entry.version});
   const ca=await create(a,"clients",{name:"client-a",code:"ca"}),cb=await create(b,"clients",{name:"client-b",code:"cb"});
   expect(ca.id).toBeString();expect(cb.id).toBeString();
   const code=(value:unknown)=>typeof value==="string"?value:"ok";

   // create
   expect(code(await create(a,"contacts",{name:"own",client_id:ca.id}))).toBe("ok");
   expect(code(await create(a,"contacts",{name:"null ref",client_id:null}))).toBe("ok");
   expect(code(await create(b,"contacts",{name:"foreign",client_id:ca.id}))).toBe("CONFLICT");            // invisible parent
   expect(code(await create(b,"contacts",{name:"missing",client_id:"does-not-exist"}))).toBe("CONFLICT");
   expect(code(await create(both,"contacts",{rep:"B",name:"cross",client_id:ca.id}))).toBe("CONFLICT"); // visible, other partition
   expect(code(await create(both,"contacts",{rep:"A",name:"same",client_id:ca.id}))).toBe("ok");
   expect(code(await create(every,"contacts",{rep:"B",name:"cross-all",client_id:ca.id}))).toBe("CONFLICT");
   expect(code(await create(every,"contacts",{rep:"A",name:"all-same",client_id:ca.id}))).toBe("ok");
   expect(code(await create(b,"contacts",{name:"foreign code",client_code:"ca"}))).toBe("CONFLICT");     // object form: its field
   const own=await create(b,"contacts",{name:"by code",client_code:"cb"});
   expect(code(own)).toBe("ok");
   // patch: only a written reference is checked; the partition is the row's own
   expect(code(await patch(b,"contacts",own,{client_id:ca.id}))).toBe("CONFLICT");
   expect(code(await patch(both,"contacts",own,{client_id:ca.id}))).toBe("CONFLICT");
   const moved=await patch(b,"contacts",own,{client_id:cb.id,name:"moved"});
   expect(moved.data).toMatchObject({client_id:cb.id,name:"moved"});
   const renamed=await patch(b,"contacts",moved,{name:"renamed"});
   expect(code(renamed)).toBe("ok");
   expect(code(await patch(b,"contacts",renamed,{client_code:null}))).toBe("ok");
   // owner scope
   const la=await create(a,"lists",{name:"list-a"});
   expect(code(await create(a,"items",{name:"own item",list_id:la.id}))).toBe("ok");
   expect(code(await create(b,"items",{name:"foreign item",list_id:la.id}))).toBe("CONFLICT");

   // trusted: unchecked, like the other row rules
   const contacts=bindings.schemas.find((s:any)=>s.name==="contacts");
   await nativeEntryProcedure(contacts.binding,bindings.adapter,db,{kind:"system",reason:"fixture"},"create",{rep:"B",name:"trusted",client_id:"does-not-exist"});
   const rows=async(sql:string)=>[...await(pg?db.unsafe(sql):Promise.resolve(db.query(sql).all()))];
   expect(await rows("SELECT c.name FROM contacts c LEFT JOIN clients p ON p.id = c.client_id WHERE c.client_id IS NOT NULL AND (p.id IS NULL OR p.rep <> c.rep)")).toEqual([{name:"trusted"}]);
   expect(await rows("SELECT name FROM items ORDER BY name")).toEqual([{name:"own item"}]);
  }finally{
   if(pg){await db.unsafe(`DROP SCHEMA IF EXISTS ${namespace} CASCADE`);await db.close();}else db.close();
   await rm(dir,{recursive:true,force:true});
  }
 },30000);
}
