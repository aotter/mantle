import { fixtureCaller } from "./apps/fixtures.js";
import {test,expect} from "bun:test";
import {Database} from "bun:sqlite";
import {SQL} from "bun";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {generateOrThrow,writeGenerated,loadFixtureSources} from "./apps/link.js";
import {verifyTranslations} from "./translation-scenarios.js";
import {toCanonicalLocale} from "../src/kernel/translations.js";
import {userCaller} from "../src/kernel/user-caller.js";

const parentScopeSource=[
 {apiVersion:'cms.mantle.aotter.net/v2',kind:'Schema',metadata:{name:'parents'},spec:{title:'Parents',lifecycle:'publishing',scope:"region IN auth.user('region')",indexes:[['region','slug']],schema:{type:'object',required:['region','slug','title'],properties:{region:{type:'string'},slug:{type:'string'},title:{type:'string'}}}}},
 {apiVersion:'cms.mantle.aotter.net/v2',kind:'Schema',metadata:{name:'children'},spec:{title:'Children',lifecycle:'publishing',localized:true,translates:{parent:'parents',on:'slug'},uniqueIndexes:[['slug','locale']],schema:{type:'object',required:['slug','locale','title'],properties:{slug:{type:'string'},locale:{type:'string'},title:{type:'string'}}}}},
].map(value=>JSON.stringify(value)).join('\n---\n');
async function verifyParentScopeTransitions(app:any,db:any){
 const system={kind:'system',reason:'fixture'} as const,trusted=app.store(db,system),parent=await trusted.collection('parents').insert({region:'JP',slug:'foreign',title:'Foreign'});await trusted.collection('parents').insert({region:'TW',slug:'visible',title:'Visible'});await trusted.procedures['parents.publish']({id:parent.id,expectedVersion:1});
 const children=[];for(const locale of ['en','fr']){const child=await trusted.collection('children').insert({slug:'foreign',locale,title:locale});await trusted.procedures['children.publish']({id:child.id,expectedVersion:1});children.push(child);}
 const fields={region:{type:'string',multiple:true}} as const,outside=app.store(db,userCaller({id:'outside',role:'admin',region:'TW'},{fields})),inside=app.store(db,userCaller({id:'inside',role:'admin',region:'JP'},{fields}));
 for(const [verb,child] of [['unpublish',children[0]],['archive',children[1]]] as const){await expect(outside.procedures[`children.${verb}`]({id:child!.id,expectedVersion:2})).rejects.toMatchObject({code:'CONFLICT'});expect(await trusted.collection('children').findById(child!.id)).toMatchObject({status:'published',version:2});await inside.procedures[`children.${verb}`]({id:child!.id,expectedVersion:2});}
}
test("locale canonicalisation follows the existing language/region subset without a site list",()=>{
 for(const [raw,canonical] of [["zh_TW","zh-TW"],["zhTW","zh-TW"],["ZH-tw","zh-TW"],["fil","fil"],["en-US-x","en-US"]] as const)expect(toCanonicalLocale(raw!)).toBe(canonical);
 for(const raw of ["","zh-Hant","e"," en ","en-123","zh-ß","zh-ıı","ıı-US","KK-US"])expect(()=>toCanonicalLocale(raw)).toThrow();
});
(process.env.MANTLE_NEXT_BUN_PG_URL?test:test.skip)("bun-postgres translation publication is atomic, scoped and one-write guarded",async()=>{
 const files=await generateOrThrow("bun-postgres",await loadFixtureSources("translations.yaml")),dir=await mkdtemp(join(tmpdir(),"mantle-translations-"));
 const schema="tr_"+crypto.randomUUID().replaceAll("-","");
 const db=new SQL(process.env.MANTLE_NEXT_BUN_PG_URL!,{max:1});
 try {
  await writeGenerated(dir,files);await db.unsafe(`CREATE SCHEMA ${schema}`);await db.unsafe(`SET search_path TO ${schema}`);await db.unsafe(files["schema.sql"]!);
  const app=await import(join(dir,"generated.ts")),{translationLocales}=await import(join(dir,"translations.ts"));
  await verifyTranslations(app,translationLocales,db);expect(true).toBe(true);
 } finally {await db.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await db.close();await rm(dir,{recursive:true,force:true});}
},30000);
test("bun-sqlite translation transitions keep the parent field scope",async()=>{
 const files=await generateOrThrow('bun-sqlite',[{sourceId:'translation-parent-scope.yaml',text:parentScopeSource}]),dir=await mkdtemp(join(tmpdir(),'mantle-translation-parent-scope-')),db=new Database(':memory:');
 try{await writeGenerated(dir,files);db.exec(files['schema.sql']!);await verifyParentScopeTransitions(await import(join(dir,'generated.ts')),db);}
 finally{db.close();await rm(dir,{recursive:true,force:true});}
});
(process.env.MANTLE_NEXT_BUN_PG_URL?test:test.skip)("bun-postgres translation transitions keep the parent field scope",async()=>{
 const files=await generateOrThrow('bun-postgres',[{sourceId:'translation-parent-scope.yaml',text:parentScopeSource}]),dir=await mkdtemp(join(tmpdir(),'mantle-translation-parent-scope-')),schema='tr_scope_'+crypto.randomUUID().replaceAll('-',''),db=new SQL(process.env.MANTLE_NEXT_BUN_PG_URL!,{max:1});
 try{await writeGenerated(dir,files);await db.unsafe(`CREATE SCHEMA ${schema}`);await db.unsafe(`SET search_path TO ${schema}`);await db.unsafe(files['schema.sql']!);await verifyParentScopeTransitions(await import(join(dir,'generated.ts')),db);}
 finally{await db.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await db.close();await rm(dir,{recursive:true,force:true});}
},30000);
test("translation helper types are generated for all four target handles",async()=>{
 const ts=(await import("typescript")).default,{writeFile}=await import("node:fs/promises");const dir=await mkdtemp(join(import.meta.dir,"apps/.translation-types-"));
 try {
  const entries:string[]=[];
  for(const target of ["bun-sqlite","bun-postgres","cloudflare-d1","cloudflare-postgres"] as const){const files=await generateOrThrow(target,await loadFixtureSources("translations.yaml")),app=join(dir,target);await writeGenerated(app,files,false);const entry=join(app,"use.ts");await writeFile(entry,`import {store} from './generated.js';const collection=store({} as any,{kind:'anonymous'}).collection('translations');collection.find().then(page=>{const cover:string|null|undefined=page.rows[0]!.cover;});\n// @ts-expect-error inherited parent field is read-only\ncollection.insert({slug:'s',locale:'fr',title:'t',cover:'x'});\n// @ts-expect-error inherited parent field is not an update column\ncollection.update('id',{cover:'x'},{lock:1});\nimport {translationLocales} from './translations.js';translationLocales({} as any,{kind:'anonymous'},'posts',[{id:'id',slug:'slug'}]);\n// @ts-expect-error parent name is generated\ntranslationLocales({} as any,{kind:'anonymous'},'missing',[]);`);entries.push(entry);}
  const program=ts.createProgram(entries,{noEmit:true,strict:true,skipLibCheck:true,target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.NodeNext,moduleResolution:ts.ModuleResolutionKind.NodeNext,types:["bun-types"]});const diagnostics=ts.getPreEmitDiagnostics(program);expect(diagnostics.map(d=>ts.flattenDiagnosticMessageText(d.messageText,"\n"))).toEqual([]);
 } finally {await rm(dir,{recursive:true,force:true});}
},30000);
test("locale page reads stay at 50 keys and 500 child rows without per-parent reads",async()=>{
 const files=await generateOrThrow("bun-sqlite",await loadFixtureSources("translations.yaml")),dir=await mkdtemp(join(tmpdir(),"mantle-locale-page-")),db=new Database(":memory:");
 try {
  await writeGenerated(dir,files);db.exec(files["schema.sql"]!);const app=await import(join(dir,"generated.ts")),{translationLocales}=await import(join(dir,"translations.ts"));
  const caller=fixtureCaller({kind:"user",subject:"a",role:"admin",admin:true,scopes:[],credential:"session",credentialId:null,clientId:null}),store=app.store(db,caller),parents=[];
  for(let i=0;i<51;i++)parents.push(await store.collection("posts").insert({slug:"p"+i,title:"parent"}));
  for(let i=0;i<605;i++)db.query("INSERT INTO translations(id,version,created_at,updated_at,owner,slug,locale,title) VALUES (?,1,0,0,'a','p0',?,'t')").run("bulk-"+String(i).padStart(4,"0"),"custom-"+i);
  const queries:string[]=[],handle={query(sql:string){queries.push(sql);return db.query(sql);}};
  const locales=await translationLocales(handle,caller,"posts",parents);expect(locales[parents[0].id]).toHaveLength(605);expect(locales[parents[50].id]).toEqual([]);expect(queries).toHaveLength(3);
  expect(queries.every(sql=>sql.includes("LIMIT 500")&&!sql.includes("OFFSET"))).toBe(true);expect(queries[1]).toContain("t.id >");
 } finally {db.close();await rm(dir,{recursive:true,force:true});}
});
test("selected translation helper shakes out publishing operations",async()=>{
 const {writeFile,readFile}=await import("node:fs/promises"),{bundle,startupGraph}=await import("../src/infrastructure/bundle.js"),dir=await mkdtemp(join(import.meta.dir,"apps/.translation-size-"));
 try {
  await writeGenerated(dir,await generateOrThrow("cloudflare-d1",await loadFixtureSources("translations.yaml")),false);const entry=join(dir,"worker.ts");await writeFile(entry,`import {translationLocales} from './translations.js';export default{async fetch(request:Request,env:any){return Response.json(await translationLocales(env.DB,{kind:'anonymous'},'posts',[{id:'p',slug:'s'}]));}};`);
  const meta=await bundle(entry,join(dir,"dist")),graph=startupGraph(meta,entry),bytes=graph.reduce((total,name)=>total+meta.outputs[name]!.bytes,0),budgets=JSON.parse(await readFile(join(import.meta.dir,"../size-budgets.json"),"utf8"));expect(bytes).toBeLessThanOrEqual(budgets["cloudflare-d1"]);
  const code=await readFile(resolve(process.cwd(),graph[0]!),"utf8");expect(code).not.toContain('UPDATE "posts" SET');console.log(JSON.stringify({entry:"translation-locales",startupBytes:bytes,budgetBytes:budgets["cloudflare-d1"]}));
 }finally{await rm(dir,{recursive:true,force:true});}
});

test("scoped translations refuse different or missing child scope columns",async()=>{
 const {generateFromSources}=await import("../src/infrastructure/generate.js"),[source]=await loadFixtureSources("translations.yaml"),parts=source!.text.split("---");
 for(const child of [parts[1]!.replaceAll("owner","tenant"),parts[1]!.replace(' scope: "owner = auth.uid()"\n',"").replaceAll("owner,","").replace("owner: {type: string}, ","")]){
  const result=await generateFromSources({target:"bun-sqlite",sources:{sources:[{sourceId:"scope.yaml",text:[parts[0],child,parts[2]].join("---")}]}});
  expect(result.ok).toBe(false);if(result.ok)throw Error("unsafe translation scope generated");
  expect(result.diagnostics).toContainEqual(expect.objectContaining({code:"GENERATE_UNSUPPORTED",path:"schemas/translations/translates",message:expect.stringContaining("same child scope column 'owner'")}));
 }
});
test("Core translation SQL correlates every parent term on every target",async()=>{
 for(const target of ["bun-sqlite","bun-postgres","cloudflare-d1","cloudflare-postgres"] as const){
  const files=await generateOrThrow(target,await loadFixtureSources("translations.yaml")),source=files["generated.ts"]!;
  const encoded=source.match(/const view0Caller = \{ sql: ("(?:\\.|[^"\\])*")/)!;
  const sql=JSON.parse(encoded[1]!).replaceAll('"','');expect(sql).toMatch(/_mantle_parent\.owner\s*=\s*translations\.owner/);
  for(const verb of ['publish','unpublish','archive']){const line=source.split('\n').find(line=>line.startsWith(`const procedure_translations$2e${verb}Caller =`))!,encoded=line.match(/"sql":("(?:\\.|[^"\\])*")/)!;const sql=JSON.parse(encoded[1]!).replaceAll('"','');expect(sql).toContain('_mantle_parent.slug = translations.slug');expect(sql).not.toContain('_mantle_parent.slug = slug');}
 }
});
