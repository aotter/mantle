import {test,expect} from "bun:test";
import {Database} from "bun:sqlite";
import {SQL} from "bun";
import {mkdtemp,rm} from "node:fs/promises";
import {join} from "node:path";
import {generateFromSources} from "../src/infrastructure/generate.js";
import {loadFixtureSources,writeGenerated} from "./apps/link.js";
import {r2MediaStorage,type R2Bucket} from "../src/kernel/r2-media.js";
import {ContractError,wire} from "../src/kernel/contracts.js";
const defaults = {origin:"https://site.test",locales:["en","zh-TW"],brand:"Seed",media:{purposes:[{name:"cover",required:["jpg,png","webp"],maxBytes:{"image/jpeg":100,"image/png":100,"image/webp":100}}]}};
const admin:any={kind:"user",subject:"admin-id",role:"admin", admin: true,scopes:[],credential:"session",credentialId:null,clientId:null};
function memoryStorage() {
 const objects=new Map<string,{type:string;size:number}>(); let failedDelete:string|undefined;
 const bucket:R2Bucket={async head(key){const o=objects.get(key);return o?{size:o.size,httpMetadata:{contentType:o.type}}:null;},async get(key){const o=objects.get(key);return o?{size:o.size,httpMetadata:{contentType:o.type},body:new Blob([new Uint8Array(o.size)]).stream()}:null;},async put(key,body,options){objects.set(key,{size:(await new Response(body).arrayBuffer()).byteLength,type:options.httpMetadata.contentType});},async delete(keys){for(const key of typeof keys==="string"?[keys]:keys){if(key===failedDelete)throw new Error("temporary private blob deletion failure");objects.delete(key);}}};
 const storage=r2MediaStorage({bucket,signer:{async sign(url){return {url};}},endpoint:"https://r2.test",publicBase:"https://media.test"});
 return {objects,storage,failDelete(key:string|undefined){failedDelete=key;}};
}
const upload={filename:"photo.png",purpose:"cover",alt:"original",variants:[{mimeType:"image/png",byteSize:90,role:"primary"},{mimeType:"image/webp",byteSize:60,role:"alternate"}]};
async function scenario(site:any, dbRead:(sql:string)=>Promise<any[]>) {
 const before=await site.read();expect(before.brand).toBe("Seed");expect(before.canonicalLocale).toBe("en");
 expect((await site.updateSettings({brand:"Operator",title:"Title",description:""})).brand).toBe("Operator");
 await expect(site.updateSettings({title:"x".repeat(201)})).rejects.toMatchObject({code:"INPUT_VALIDATION_FAILED"});
 const mem=memoryStorage(),media=site.media(mem.storage);
 await expect(media.createUpload({...upload,purpose:"other"})).rejects.toMatchObject({code:"MEDIA_PURPOSE_REJECTED"});
 await expect(media.createUpload({...upload,variants:[upload.variants[0]]})).rejects.toMatchObject({code:"MEDIA_VARIANTS_INCOMPLETE"});
 await expect(media.createUpload({...upload,variants:upload.variants.map(v=>({...v,byteSize:101}))})).rejects.toMatchObject({code:"MEDIA_VARIANT_SIZE_EXCEEDED"});
 await expect(media.createUpload({...upload,variants:[{...upload.variants[0],byteSize:30},upload.variants[1]]})).rejects.toMatchObject({code:"MEDIA_VARIANTS_SUSPICIOUS_SIZE"});
 const created=await media.createUpload(upload);expect(created.expiresAt-Date.now()).toBeGreaterThan(899000);expect(created.capabilities[0].storageKey).toBeUndefined();
 for(const c of created.capabilities)mem.objects.set(new URL(c.uploadUrl).pathname.slice(1),{type:c.mimeType,size:c.role==="primary"?90:60});
 const asset=await media.commitUpload(created.uploadGroupId,{caption:"Cat 100%_\\ caption"});expect(asset.id).toBe(created.uploadGroupId);expect(asset.variants).toHaveLength(2);expect(asset.alt).toBe("original");
 expect(mem.objects.has(asset.variants[0].storageKey)).toBe(true);expect(asset.variants[0].storageKey.startsWith("uploads/")).toBe(false);
 expect(await media.commitUpload(created.uploadGroupId)).toEqual(asset);
 expect((await media.list({search:"%_\\"})).rows).toEqual([asset]);expect((await media.list({search:"cat"})).rows).toEqual([asset]);
 expect(await media.update(asset.id,{alt:""})).toMatchObject({alt:"",caption:"Cat 100%_\\ caption"});
 await expect(media.list({cursor:"01"})).rejects.toMatchObject({code:"INPUT_VALIDATION_FAILED"});
 mem.failDelete(asset.variants[1].storageKey);
 try{await media.delete(asset.id);throw new Error("expected failure");}catch(error){expect(wire(error)).toMatchObject({status:503,error:{code:"PARTIAL_FAILURE",failure:{outcome:"partial",retry:"safe"}}});}
 expect(await media.get(asset.id)).toMatchObject({id:asset.id});mem.failDelete(undefined);expect(await media.delete(asset.id)).toEqual({deleted:true,variantsRemoved:2});
 await expect(media.get(asset.id)).rejects.toMatchObject({code:"MEDIA_ASSET_NOT_FOUND"});
 const rejected=await media.createUpload(upload);for(const c of rejected.capabilities)mem.objects.set(new URL(c.uploadUrl).pathname.slice(1),{type:"image/svg+xml",size:1});
 await expect(media.commitUpload(rejected.uploadGroupId)).rejects.toMatchObject({code:"MEDIA_MIME_REJECTED"});expect([...mem.objects.keys()].filter(k=>k.includes(rejected.uploadGroupId))).toEqual([]);
 expect((await dbRead("SELECT * FROM media_assets")).length).toBe(0);
}
async function fixture(target:"bun-sqlite"|"bun-postgres") {
 const result=await generateFromSources({target,sources:{sources:await loadFixtureSources()},site:defaults});if(!result.ok)throw Error(JSON.stringify(result.diagnostics));
 const dir=await mkdtemp(join(import.meta.dir,"apps/.site-media-"));await writeGenerated(dir,result.files);return {dir,files:result.files,site:(await import(join(dir,"site.ts"))).site};
}
test("optional site/media emits no runtime DDL or boot queries; native SQLite preserves 0.2 wire and retry",async()=>{
 const {dir,files,site}=await fixture("bun-sqlite"),db=new Database(":memory:");
 try{expect(()=>site({query(){throw Error("boot query");}},admin)).not.toThrow();db.exec(files["schema.sql"]!);const capability=site(db,admin);await scenario(capability,async sql=>db.query(sql).all());
 db.exec(files["site-seed.sql"]!);expect((await site(db,{kind:"anonymous"}).read()).brand).toBe("Operator");expect(()=>site(db,{kind:"anonymous"}).media(memoryStorage().storage)).toThrow(ContractError);
 expect(files["site.ts"]).not.toMatch(/CREATE TABLE|INSERT INTO/);
 }finally{db.close();await rm(dir,{recursive:true,force:true});}
});
(process.env.MANTLE_NEXT_BUN_PG_URL?test:test.skip)("native PostgreSQL site/media uses the same durable state and wire oracle",async()=>{
 const {dir,files,site}=await fixture("bun-postgres"),sql=new SQL(process.env.MANTLE_NEXT_BUN_PG_URL!,{max:1}),schema="site_"+crypto.randomUUID().replaceAll("-","");
 try{await sql.unsafe(`CREATE SCHEMA ${schema}`);await sql.unsafe(`SET search_path TO ${schema}`);await sql.unsafe(files["schema.sql"]!);await scenario(site(sql,admin),async q=>[...await sql.unsafe(q)]);}finally{await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await sql.close();await rm(dir,{recursive:true,force:true});}
},30000);
test("site is absent unless selected and invalid deployment defaults fail generation",async()=>{
 const sources={sources:await loadFixtureSources()};const absent=await generateFromSources({target:"bun-sqlite",sources});expect(absent.ok&&absent.files["site.ts"]).toBeUndefined();expect(absent.ok&&absent.files["schema.sql"]).not.toContain("media_assets");
 const bad=await generateFromSources({target:"bun-sqlite",sources,site:{origin:"https://site.test/path"}});expect(bad.ok).toBe(false);
});
test("commit retries retain UUID and sources across failed or uncertain SQL writes; expiry is enforced",async()=>{
 const {dir,files}=await fixture("bun-sqlite"),db=new Database(":memory:");
 const {mediaLibrary}=await import("../src/kernel/media.js"),driver=await import("../src/kernel/driver/bun-sqlite.js"),d=await import("../src/kernel/dialect/sqlite.js");
 let now=1000,fail:"before"|"after"|undefined;
 try{db.exec(files["schema.sql"]!);const mem=memoryStorage(),policies=[{...defaults.media.purposes[0]!,required:["image/jpeg,image/png","image/webp"]}];
 const media=mediaLibrary({read:(sql,binds)=>driver.read(db,sql,binds),async write(steps){if(steps.some(s=>s.sql.startsWith("INSERT INTO media_assets"))&&fail){const which=fail;fail=undefined;if(which==="before")throw new ContractError("OUTCOME_UNKNOWN","lost response","media");await driver.procedure(db,steps,"media");throw new ContractError("OUTCOME_UNKNOWN","lost COMMIT response","media");}return driver.procedure(db,steps,"media");}},d,mem.storage,policies,()=>now);
 const put=async()=>{const u=await media.createUpload(upload);for(const c of u.capabilities)mem.objects.set(new URL(c.uploadUrl).pathname.slice(1),{type:c.mimeType,size:c.role==="primary"?90:60});return u;};
 const first=await put();fail="before";await expect(media.commitUpload(first.uploadGroupId)).rejects.toMatchObject({code:"OUTCOME_UNKNOWN"});expect([...mem.objects.keys()].some(k=>k.startsWith("uploads/"))).toBe(true);expect([...mem.objects.keys()].filter(k=>k.startsWith("committed/")&&k.includes(first.uploadGroupId))).toHaveLength(2);expect((await media.commitUpload(first.uploadGroupId)).id).toBe(first.uploadGroupId);
 const second=await put();fail="after";await expect(media.commitUpload(second.uploadGroupId)).rejects.toMatchObject({code:"OUTCOME_UNKNOWN"});expect((await media.get(second.uploadGroupId)).variants.every(v=>mem.objects.has(v.storageKey))).toBe(true);expect((await media.commitUpload(second.uploadGroupId)).id).toBe(second.uploadGroupId);expect((await media.list({limit:1})).nextCursor).toBe("1");expect((await media.list({limit:1,cursor:"1"})).rows).toHaveLength(1);
 const expired=await put();now+=900000;await expect(media.commitUpload(expired.uploadGroupId)).rejects.toMatchObject({code:"MEDIA_UPLOAD_EXPIRED"});expect([...mem.objects.keys()].some(k=>k.includes(expired.uploadGroupId))).toBe(false);
 }finally{db.close();await rm(dir,{recursive:true,force:true});}
});
test("R2 refuses changed GET snapshots and rolls back copied public objects on failure",async()=>{
 let written=0,removed=0,changed=true,failedCleanup=false;
 const bucket:R2Bucket={async head(){return {size:5,httpMetadata:{contentType:"image/png"}};},async get(){return {size:changed?6:5,httpMetadata:{contentType:"image/png"},body:new Blob([new Uint8Array(5)]).stream()};},async put(){written++;throw Error("lost object copy response");},async delete(){removed++;if(failedCleanup)throw Error("delete failed");}};
 const storage=r2MediaStorage({bucket,endpoint:"https://r2.test",publicBase:"https://media.test",signer:{async sign(url,init){expect(init).toEqual({method:"PUT",aws:{signQuery:true,service:"s3"}});expect(new URL(url).searchParams.get("X-Amz-Expires")).toBe("900");return {url};}}});
 await storage.createUpload({uploadGroupId:"g",purpose:"cover",filename:"x.png",now:1000,expiresAt:901000,variants:[{mimeType:"image/png",role:"primary",byteSize:5,maxBytes:5}]});
 const args={uploadGroupId:"g",filename:"x.png",now:1000,variants:[{mimeType:"image/png",role:"primary" as const,storageKey:"uploads/cover/g/primary.png",maxBytes:5}]};
 await expect(storage.commitUpload(args)).rejects.toMatchObject({code:"MEDIA_OBJECT_NOT_FOUND"});expect(written).toBe(0);
 changed=false;await expect(storage.commitUpload(args)).rejects.toMatchObject({code:"OUTCOME_UNKNOWN"});expect(removed).toBe(1);
 failedCleanup=true;await expect(storage.commitUpload(args)).rejects.toMatchObject({code:"PARTIAL_FAILURE"});
});
(process.env.MANTLE_NEXT_BUN_PG_URL?test:test.skip)("postgres.js uses the same site/media persistence contract",async()=>{
 const postgres=(await import("postgres")).default,{dir,files,site}=await fixture("bun-postgres"),sql=postgres(process.env.MANTLE_NEXT_BUN_PG_URL!,{max:1}),schema="site_js_"+crypto.randomUUID().replaceAll("-","");
 try{await sql.unsafe(`CREATE SCHEMA ${schema}`);await sql.unsafe(`SET search_path TO ${schema}`);await sql.unsafe(files["schema.sql"]!);await scenario(site(sql,admin),async q=>[...await sql.unsafe(q)]);}finally{await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await sql.end();await rm(dir,{recursive:true,force:true});}
},30000);
test("optional site and media stay out of an app's bundle unless imported",async()=>{
 const {build}=await import("esbuild"),{dir,files}=await fixture("bun-sqlite");
 try{
 const bare=await build({stdin:{contents:`import {store} from ${JSON.stringify(join(dir,"generated.ts"))}; export default store;`,resolveDir:dir,sourcefile:"worker.ts"},bundle:true,write:false,metafile:true,format:"esm",platform:"neutral",external:["node:async_hooks"]});
 expect(Object.keys(bare.metafile!.inputs).some(path=>/kernel\/(site|media|r2-media)\.ts$/.test(path))).toBe(false);
 const selected=await build({stdin:{contents:`export {site} from ${JSON.stringify(join(dir,"site.ts"))};`,resolveDir:dir,sourcefile:"worker.ts"},bundle:true,write:false,metafile:true,format:"esm",platform:"neutral",external:["node:async_hooks"]});
 expect(Object.keys(selected.metafile!.inputs).some(path=>/kernel\/media\.ts$/.test(path))).toBe(true);expect(Object.keys(selected.metafile!.inputs).some(path=>/kernel\/r2-media\.ts$/.test(path))).toBe(false);
 expect(files["site.ts"]).not.toMatch(/prepareSite|CREATE TABLE/);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test("site and media projections preserve the Admin SPA envelope and null convenience fields",async()=>{
 const {siteInfo}=await import("../src/kernel/site.js"),{mediaItem}=await import("../src/kernel/media.js");
 const projected=siteInfo({brand:"Brand",title:"Title",description:"",origin:"",locales:[],canonicalLocale:null,icons:[],media:{purposes:[]}},{origin:"https://app.test",mcpEndpoints:{public:"/mcp",admin:"/mcp/admin"},media:true,invitationEmail:false});
 expect(projected).toMatchObject({publicUrl:"https://app.test",mcpEndpoints:{public:"https://app.test/mcp",admin:"https://app.test/mcp/admin"},capabilities:{siteSettings:true,media:true,invitationEmail:false,statistics:false},extensions:[]});
 expect(mediaItem({id:"id",createdAt:1234,variants:[]})).toEqual({id:"id",createdAt:1234,variants:[],primaryUrl:null,mime:null,byteSize:null,alt:null,caption:null});
});
for (const target of ["bun-sqlite","bun-postgres"] as const) {
 (target === "bun-postgres" && !process.env.MANTLE_NEXT_BUN_PG_URL ? test.skip : test)(`${target}: concurrent commit cleanup cannot delete the durable winner's R2 copies`,async()=>{
  const {dir,files}=await fixture(target),sqlite=target==="bun-sqlite",db:any=sqlite?new Database(":memory:"):new SQL(process.env.MANTLE_NEXT_BUN_PG_URL!,{max:1}),schema="media_race_"+crypto.randomUUID().replaceAll("-","");
  const {mediaLibrary}=await import("../src/kernel/media.js"),d=await import(sqlite?"../src/kernel/dialect/sqlite.js":"../src/kernel/dialect/postgres.js"),driver=await import(sqlite?"../src/kernel/driver/bun-sqlite.js":"../src/kernel/driver/postgres.js");
  try {
   if(sqlite)db.exec(files["schema.sql"]!);else{await db.unsafe(`CREATE SCHEMA ${schema}`);await db.unsafe(`SET search_path TO ${schema}`);await db.unsafe(files["schema.sql"]!);}
   for(const cleanupFails of [false,true]) {
    const objects=new Map<string,{size:number;type:string}>();let firstGets=0,primaryPuts=0,releaseCapture!:()=>void,releaseBody!:()=>void,losingKey="";
    const captured=new Promise<void>(r=>releaseCapture=r),bodyReleased=new Promise<void>(r=>releaseBody=r);
    const bucket:R2Bucket={async head(key){const o=objects.get(key);return o?{size:o.size,httpMetadata:{contentType:o.type}}:null;},async get(key){const o=objects.get(key);if(!o)return null;const snapshot={size:o.size,httpMetadata:{contentType:o.type},body:new Blob([new Uint8Array(o.size)]).stream()};if(key.endsWith("primary.png")&&++firstGets===2){releaseCapture();await bodyReleased;}return snapshot;},async put(key,body,options){objects.set(key,{size:(await new Response(body).arrayBuffer()).byteLength,type:options.httpMetadata.contentType});if(key.endsWith("primary.png")){if(++primaryPuts===1)await captured;else losingKey=key;}},async delete(keys){for(const key of typeof keys==="string"?[keys]:keys){if(cleanupFails&&key===losingKey)throw Error("losing-attempt cleanup failed");objects.delete(key);}}};
    const storage=r2MediaStorage({bucket,signer:{async sign(url){return {url};}},endpoint:"https://r2.test",publicBase:"https://media.test"});
    const media=mediaLibrary({definitive:driver.definitive,read:(q,v)=>driver.read(db,q,v),write:steps=>driver.procedure(db,steps,"media")},d,storage,[{...defaults.media.purposes[0]!,required:["image/jpeg,image/png","image/webp"]}]);
    const group=await media.createUpload(upload);for(const c of group.capabilities)objects.set(new URL(c.uploadUrl).pathname.slice(1),{size:c.role==="primary"?90:60,type:c.mimeType});
    const first=media.commitUpload(group.uploadGroupId),second=media.commitUpload(group.uploadGroupId).catch(error=>error);const asset=await first;releaseBody();const failure=await second;
    if(cleanupFails)expect(failure.code).toBe("PARTIAL_FAILURE");else expect(failure).toEqual(asset);expect(await media.get(asset.id)).toEqual(asset);expect(asset.variants.every(v=>objects.has(v.storageKey))).toBe(true);expect(asset.variants.some(v=>v.storageKey===losingKey)).toBe(false);expect(await media.commitUpload(group.uploadGroupId)).toEqual(asset);
    if(!cleanupFails)expect(objects.size).toBe(2);
   }
  }finally{if(sqlite)db.close();else{await db.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await db.close();}await rm(dir,{recursive:true,force:true});}
 },30000);
 (target === "bun-postgres" && !process.env.MANTLE_NEXT_BUN_PG_URL ? test.skip : test)(`${target}: a fully copied concurrent loser removes only its own unused attempt`,async()=>{
  const {dir,files}=await fixture(target),sqlite=target==="bun-sqlite",db:any=sqlite?new Database(":memory:"):new SQL(process.env.MANTLE_NEXT_BUN_PG_URL!,{max:1}),schema="media_winner_"+crypto.randomUUID().replaceAll("-","");
  const {mediaLibrary}=await import("../src/kernel/media.js"),d=await import(sqlite?"../src/kernel/dialect/sqlite.js":"../src/kernel/dialect/postgres.js"),driver=await import(sqlite?"../src/kernel/driver/bun-sqlite.js":"../src/kernel/driver/postgres.js");
  try {
   if(sqlite)db.exec(files["schema.sql"]!);else{await db.unsafe(`CREATE SCHEMA ${schema}`);await db.unsafe(`SET search_path TO ${schema}`);await db.unsafe(files["schema.sql"]!);}
   let writers=0,releaseFirst!:()=>void,releaseSecond!:()=>void;const secondReached=new Promise<void>(r=>releaseFirst=r),firstDurable=new Promise<void>(r=>releaseSecond=r),mem=memoryStorage();
   const media=mediaLibrary({definitive:driver.definitive,read:(q,v)=>driver.read(db,q,v),async write(steps){if(steps.some(s=>s.sql.startsWith("INSERT INTO media_assets"))){if(++writers===1)await secondReached;else{releaseFirst();await firstDurable;}}return driver.procedure(db,steps,"media");}},d,mem.storage,[{...defaults.media.purposes[0]!,required:["image/jpeg,image/png","image/webp"]}]);
   const group=await media.createUpload(upload);for(const c of group.capabilities)mem.objects.set(new URL(c.uploadUrl).pathname.slice(1),{size:c.role==="primary"?90:60,type:c.mimeType});
   const first=media.commitUpload(group.uploadGroupId),second=media.commitUpload(group.uploadGroupId);const asset=await first;releaseSecond();expect(await second).toEqual(asset);expect(mem.objects.size).toBe(2);expect(asset.variants.every(v=>mem.objects.has(v.storageKey))).toBe(true);
  }finally{if(sqlite)db.close();else{await db.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await db.close();}await rm(dir,{recursive:true,force:true});}
 },30000);
}
for (const target of ["bun-sqlite","bun-postgres"] as const) {
 (target === "bun-postgres" && !process.env.MANTLE_NEXT_BUN_PG_URL ? test.skip : test)(`${target}: definitive native write rollback cleans only this attempt's public copies`,async()=>{
  const {dir,files}=await fixture(target),sqlite=target==="bun-sqlite",db:any=sqlite?new Database(":memory:"):new SQL(process.env.MANTLE_NEXT_BUN_PG_URL!,{max:1}),schema="media_cleanup_"+crypto.randomUUID().replaceAll("-","");
  const {mediaLibrary}=await import("../src/kernel/media.js"),d=await import(sqlite?"../src/kernel/dialect/sqlite.js":"../src/kernel/dialect/postgres.js"),driver=await import(sqlite?"../src/kernel/driver/bun-sqlite.js":"../src/kernel/driver/postgres.js");let fail=false;
  try {
   if(sqlite)db.exec(files["schema.sql"]!);else{await db.unsafe(`CREATE SCHEMA ${schema}`);await db.unsafe(`SET search_path TO ${schema}`);await db.unsafe(files["schema.sql"]!);}
   const mem=memoryStorage(),media=mediaLibrary({definitive:driver.definitive,read:(q,v)=>driver.read(db,q,v),write:steps=>{if(fail&&steps.some(s=>s.sql.startsWith("INSERT INTO media_assets"))){fail=false;return driver.procedure(db,[...steps,{sql:"SELECT nonexistent_media_column FROM media_assets",binds:[]}],"media");}return driver.procedure(db,steps,"media");}},d,mem.storage,[{...defaults.media.purposes[0]!,required:["image/jpeg,image/png","image/webp"]}]);
   const put=async()=>{const group=await media.createUpload(upload);for(const c of group.capabilities)mem.objects.set(new URL(c.uploadUrl).pathname.slice(1),{size:c.role==="primary"?90:60,type:c.mimeType});return group;};
   const winner=await put(),durable=await media.commitUpload(winner.uploadGroupId),candidate=await put();fail=true;
   await expect(media.commitUpload(candidate.uploadGroupId)).rejects.toThrow();expect([...mem.objects.keys()].filter(key=>key.startsWith("committed/")&&key.includes(candidate.uploadGroupId))).toHaveLength(0);expect(durable.variants.every(v=>mem.objects.has(v.storageKey))).toBe(true);expect([...mem.objects.keys()].filter(key=>key.startsWith("uploads/")&&key.includes(candidate.uploadGroupId))).toHaveLength(2);expect((await media.commitUpload(candidate.uploadGroupId)).id).toBe(candidate.uploadGroupId);
  }finally{if(sqlite)db.close();else{await db.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await db.close();}await rm(dir,{recursive:true,force:true});}
 },30000);
}
test("blank stored and default brands fall back as in 0.2",async()=>{
 const {createSite}=await import("../src/kernel/site.js"),d=await import("../src/kernel/dialect/sqlite.js"),driver={read:()=>[{key:"brand",value:""}],async write(){return [];}};
 expect((await createSite(driver,d,admin,{brand:"Default"},[]).read()).brand).toBe("Default");expect((await createSite(driver,d,admin,{brand:""},[]).read()).brand).toBe("AotterMantle");
});
test("real D1 driver lost batch response preserves the committed asset's copies",async()=>{
 const {dir,files}=await fixture("bun-sqlite"),db=new Database(":memory:"),{d1Shim}=await import("./apps/d1-shim.js"),driver=await import("../src/kernel/driver/d1.js"),d=await import("../src/kernel/dialect/sqlite.js"),{mediaLibrary}=await import("../src/kernel/media.js");
 try {db.exec(files["schema.sql"]!);const native=d1Shim(db),mem=memoryStorage();let loseResponse=false;
 const handle={prepare:native.prepare.bind(native),async batch(statements:any[]){const rows=await native.batch(statements);if(loseResponse)throw new Error("D1 transport response lost after batch committed");return rows;}};
 const media=mediaLibrary({definitive:driver.definitive,read:(q,v)=>driver.read(handle,q,v),write:steps=>driver.procedure(handle,steps,"media")},d,mem.storage,[{...defaults.media.purposes[0]!,required:["image/jpeg,image/png","image/webp"]}]);
 const group=await media.createUpload(upload);for(const c of group.capabilities)mem.objects.set(new URL(c.uploadUrl).pathname.slice(1),{size:c.role==="primary"?90:60,type:c.mimeType});loseResponse=true;
 await expect(media.commitUpload(group.uploadGroupId)).rejects.toMatchObject({code:"OUTCOME_UNKNOWN",cause:{message:"D1 transport response lost after batch committed"}});const durable=await media.get(group.uploadGroupId);expect(durable.variants.every(v=>mem.objects.has(v.storageKey))).toBe(true);expect(await media.commitUpload(group.uploadGroupId)).toEqual(durable);
 expect(driver.definitive(new Error("network failure"))).toBe(false);
 } finally {db.close();await rm(dir,{recursive:true,force:true});}
});
