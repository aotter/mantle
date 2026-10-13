import {expect,test} from "bun:test";
import {mkdtemp,rm,writeFile} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {compilePlan,type RuntimePlan} from "../src/build/compiler.js";
import {STAFF_ROLES} from "../src/domain/visibility.js";
import * as compiler from "../src/build/d1/compile/index.js";
import {collectionOf,developerConsole,requiredEnumStates} from "../src/build/compiler.js";
import {appCatalog} from "../src/build/compiler.js";
import {adminOrder} from "../src/domain/adminOrder.js";
import {emitAdminDescriptors} from "../src/usecase/adminDescriptors.js";
import {generateFromSources} from "../src/infrastructure/generateAuth.js";
import type {GenerateDiagnostic} from "../src/domain/model.js";
import {loadGenerated,writeGenerated} from "./apps/link.js";
const manifest=(kind:string,name:string,spec:object)=>({sourceId:name+".json",text:JSON.stringify({apiVersion:"cms.mantle.aotter.net/v2",kind,metadata:{name},spec})});
const schema=(properties:object,required:string[],extras:object={})=>({title:"Records",lifecycle:"operational",schema:{type:"object",properties,required},...extras});
const extensions=[{id:"audit",contributes:{fields:[{id:"color",target:"field.input/v1" as const,optionsSchema:{type:"object" as const,properties:{palette:{type:"string" as const,enum:["brand"]}},required:["palette"]}},{id:"state",target:"field.cell/v1" as const}],panels:[{id:"history",title:"History",target:"record.sidebar/v1" as const,role:STAFF_ROLES[0]!}]}}];
const sources=[
  manifest("Schema","projects",schema({title:{type:"string"},code:{type:"string"},cover:{type:"string","x-mcp-hint":"media-image"}},["title","code"],{uniqueIndexes:[["code"]]})),
  manifest("Schema","tasks",schema({projectId:{type:"string","x-mantle-ref":"projects"},projectCode:{type:"string","x-mantle-ref":{schema:"projects",field:"code"}},title:{type:"string"},expiresAt:{type:"string",format:"date-time"},priority:{type:"integer"},state:{type:"string",enum:["todo","done"]}},["projectId","projectCode","priority","state"],{indexes:[["priority"],["state"]],ttl:{field:"expiresAt",expireAfterSeconds:3600},uiSchema:{list:{primaryField:"title",columns:["projectCode","state"],filterField:"state",cells:{state:"audit/state"}},nav:{standalone:true,parentField:"projectId"},fields:{title:{widget:"audit/color",options:{palette:"brand"}}},panels:["audit/history"]}})),
  manifest("View","tasks-board",{surface:"staff",sql:"SELECT t.id,t.title,t.projectCode,t.priority,t.state,t.created_at FROM tasks t ORDER BY t.id",uiSchema:{list:{columns:["projectCode","state"],searchFields:["title"],filterFields:["state"],cells:{state:"audit/state"}}}}),
  manifest("View","joined-board",{surface:"staff",sql:"SELECT t.id,p.title FROM tasks t JOIN projects p ON p.id=t.projectId ORDER BY t.id"}),
  manifest("View","alias-board",{surface:"staff",sql:"SELECT title AS id FROM tasks ORDER BY id"}),
  manifest("View","cte-board",{surface:"staff",sql:"WITH board AS (SELECT id,projectCode FROM tasks) SELECT id,projectCode FROM board ORDER BY id"}),
  manifest("View","totals",{surface:"staff",sql:"SELECT sum(priority) AS total FROM tasks"}),
  manifest("View","public-tasks",{surface:"public",sql:"SELECT id,title FROM tasks ORDER BY id"}),
  manifest("View","internal-tasks",{surface:"internal",sql:"SELECT id,title FROM tasks ORDER BY id"}),
  manifest("Procedure","mark-done",{title:"Complete",description:"Complete a task.",requires:{auth:{all:[{"ctx.staff":[...STAFF_ROLES]}]}},input:{type:"object",properties:{entryId:{type:"string"},expectedVersion:{type:"integer"}},required:["entryId","expectedVersion"]},output:{type:"object"},target:{schema:"tasks",id:"entryId",version:"expectedVersion"},handler:{sql:"UPDATE tasks SET state='done',priority=CASE WHEN priority>1 THEN priority-1 ELSE priority END WHERE id=input.entryId AND version=input.expectedVersion AND state='todo' RETURNING id,state"}}),
  manifest("Procedure","notify-task",{input:{type:"object",properties:{entryId:{type:"string"},message:{type:"string"}},required:["entryId"]},output:{type:"object"},target:{schema:"tasks",id:"entryId"},handler:{ref:"notify"},uiSchema:{fields:{message:{widget:"audit/color",options:{palette:"brand"}}}}}),
  manifest("Trigger","notify-http",{source:{kind:"http",method:"POST",path:"/api/notify"},target:{procedure:"notify-task"}}),
  manifest("Trigger","complete-mcp",{source:{kind:"mcp",surface:"staff"},target:{procedure:"mark-done"}}),
];
async function planOf(input=sources):Promise<RuntimePlan>{const result=await compilePlan({sources:input},compiler,"operational");if(!result.ok)throw Error(JSON.stringify(result.diagnostics));return result.plan;}
async function metadata(plan:RuntimePlan){const diagnostics:GenerateDiagnostic[]=[];const files=emitAdminDescriptors({plan,adminExtensions:extensions},diagnostics);expect(diagnostics).toEqual([]);return {files,loaded:await loadGenerated(files["admin-descriptors.ts"]!)};}

test("Admin projections match 0.2 collections, operations, SQL graph and MCP catalogue",async()=>{
  const plan=await planOf(),{loaded:m,files}=await metadata(plan),schemas=Object.values(plan.schemas);
  expect(m.collections).toEqual(schemas.map(s=>collectionOf(s,schemas)));
  expect(m.collections.find((x:any)=>x.name==="tasks")).toMatchObject({parent:{collection:"projects",parentField:"id",childField:"projectId"},nav:{standalone:true,parentField:"projectId",parentCollection:"projects"},sortableFields:["priority","state"],filter:{field:"state",values:["todo","done"]},list:{primaryField:"title",columns:["projectCode","state"]}});
  expect(m.operations).toHaveLength(1);expect(m.operations[0]).toMatchObject({name:"mark-done",requiredStates:[{field:"state",value:"todo"}],interactions:[{collection:"tasks",bind:[{input:"entryId",field:"id"}],version:"expectedVersion",mutates:true}]});
  const p=plan.procedures["mark-done"]!;if("sql" in p.handler)expect(m.operations[0].requiredStates).toEqual(requiredEnumStates(p.handler.sql.stmts,"tasks",plan.schemas.tasks!.schema));
  expect(m.views.map((v:any)=>v.name)).not.toContain("public-tasks");expect(m.views.map((v:any)=>v.name)).not.toContain("internal-tasks");expect(Object.keys(m.authorizations.views)).toEqual(m.views.map((v:any)=>v.name));
  expect(m.views.find((v:any)=>v.name==="tasks-board").columns.projectCode).toEqual({schema:"tasks",field:"projectCode"});expect(m.viewNames["tasks-board"].projectcode).toBe("projectCode");expect(m.fieldNames.tasks.projectid).toBe("projectId");expect(m.views.find((v:any)=>v.name==="cte-board").columns.projectCode).toEqual({schema:"tasks",field:"projectCode"});expect(m.views.find((v:any)=>v.name==="totals").columns.total).toEqual({schema:"tasks",field:"priority"});
  expect(m.developerConsole).toEqual(developerConsole(plan));expect(m.developerConsole.logic.procedures[0].handler.flow[0].cases).toHaveLength(1);
  expect(m.developerConsole.graph.relations).toEqual(expect.arrayContaining([expect.objectContaining({kind:"schema-reference",pointer:"/spec/schema/properties/projectId/x-mantle-ref"}),expect.objectContaining({kind:"trigger-target",targetId:"Procedure:mark-done"})]));
  expect(m.developerConsole.operations).toMatchObject({schedules:[],ttlPolicies:[{schema:"tasks",field:"expiresAt",expireAfterSeconds:3600,sweepObservation:"unavailable"}],observationAvailability:"unavailable",runs:[],latestRuns:[]});
  expect(m.mcpAppCatalogues).toEqual({public:appCatalog(plan,"public"),staff:appCatalog(plan,"staff")});expect(m.mcpAppCatalogues.staff.views.tasks_board.actions).toEqual(["mark_done"]);expect(m.mcpAppCatalogues.staff.views.joined_board.actions).toEqual([]);expect(m.mcpAppCatalogues.staff.views.alias_board.actions).toEqual([]);
  expect(m.webmcp.routes.mark_done).toEqual({path:"/admin/c/tasks",entry:true});expect(m.bootstrap).toEqual({collections:m.collections,allCollections:m.allCollections,operations:m.operations,views:m.views,webmcp:m.webmcp,developerConsole:m.developerConsole});
  expect(m.extensionBindings).toEqual(expect.arrayContaining([expect.objectContaining({ref:"audit/color",target:"field.input/v1"}),expect.objectContaining({ref:"audit/history",target:"record.sidebar/v1"}),expect.objectContaining({path:"procedure:notify-task/uiSchema/fields/message/widget",ref:"audit/color"})]));
  expect(files["admin-descriptors.ts"]).not.toMatch(/^import\b/m);expect(files["admin-descriptors.ts"]).not.toContain('"stmts":');expect(files["admin-descriptors.ts"]).not.toContain('"ColumnRef":');
});

test("sortableFields skips the scope column exactly as the server's Admin order does",async()=>{
  const plan=await planOf([manifest("Schema","notes",schema({owner:{type:"string"},title:{type:"string"}},["owner","title"],{scope:{owner:"auth.uid()"},indexes:[["owner","title"]]}))]),notes=plan.schemas.notes!;
  expect(Object.keys(adminOrder(notes))).toEqual(["id","updated_at","title"]);
  expect(collectionOf(notes,Object.values(plan.schemas)).sortableFields).toEqual(["title"]);
});

test("translation projection folds children, inherits media and retains composition",async()=>{
  const plan=await planOf([sources[0]!,manifest("Schema","project-translations",schema({code:{type:"string"},locale:{type:"string"},title:{type:"string"},photo:{type:"string","x-mcp-hint":"media-image"}},["code","locale","title"],{localized:true,translates:{parent:"projects",on:"code"}}))]),{loaded:m}=await metadata(plan);
  expect(m.collections.map((s:any)=>s.name)).toEqual(["projects"]);expect(m.collections[0]).toMatchObject({hasTranslations:true,mediaFields:[{name:"cover",hint:"media-image"},{name:"photo",hint:"media-image"}]});
  expect(m.collections[0]).toBe(m.allCollections.projects);
  expect(m.allCollections["project-translations"]).toMatchObject({localized:true,parent:{collection:"projects",parentField:"code",childField:"code"},translates:{parent:"projects",on:"code"}});
  expect(m.developerConsole.graph.relations).toEqual(expect.arrayContaining([expect.objectContaining({kind:"translation-parent",sourceId:"Schema:project-translations",targetId:"Schema:projects"})]));
});

test("publishing descriptors use generated Procedure and canonical staff MCP names",async()=>{
  const plan=await planOf([manifest("Schema","articles",schema({title:{type:"string"}},["title"],{lifecycle:"publishing"})),manifest("View","articles-list",{surface:"staff",sql:"SELECT id,title FROM articles ORDER BY id"}),manifest("View","articles-second",{surface:"staff",sql:"SELECT id,title FROM articles ORDER BY id"})]),{loaded:m}=await metadata(plan);
  expect(m.operations).toEqual([]);expect(m.webmcp.tools.map((t:any)=>t.name)).toEqual(["articles_list","articles_second"]);expect(m.webmcp.routes.publish_articles).toBeUndefined();
  expect(m.mcpAppCatalogues.staff.views.articles_list.actions).toEqual(["publish_articles","unpublish_articles","archive_articles"]);expect(m.mcpAppCatalogues.staff.views.articles_second.actions).toEqual(["publish_articles","unpublish_articles","archive_articles"]);expect(m.mcpAppCatalogues.public.actions).toEqual({});expect(m.authorizations.procedures["articles.publish"].auth.all).toEqual([{"ctx.staff":[...STAFF_ROLES]}]);
  expect(m.developerConsole.interfaces.callable.find((t:any)=>t.name==="publish_articles")).toMatchObject({target:"articles.publish",surface:"staff",audience:"staff"});
});

test("generation refuses unknown, misplaced and invalid-option bindings",async()=>{
  const plan=await planOf();
  const cases=[{bindings:[],code:"UI_EXTENSION_UNKNOWN"},{bindings:extensions.map(e=>({...e,contributes:{...e.contributes,fields:e.contributes.fields.map(f=>({...f,target:"field.cell/v1" as const}))}})),code:"UI_EXTENSION_TARGET"},{bindings:extensions.map(e=>({...e,contributes:{...e.contributes,fields:e.contributes.fields.map(f=>({...f,optionsSchema:{type:"object" as const,properties:{palette:{type:"string" as const,enum:["other"]}},required:["palette"]}}))}})),code:"UI_EXTENSION_OPTIONS"}];
  for(const {bindings,code} of cases){const diagnostics:GenerateDiagnostic[]=[];expect(emitAdminDescriptors({plan,adminExtensions:bindings},diagnostics)).toEqual({});expect(diagnostics[0]?.code).toBe(code);expect(diagnostics[0]?.path).toContain("schema:tasks/uiSchema/fields/title/widget");}
  const supported=sources.filter(s=>!s.sourceId.startsWith("complete-mcp")&&!s.sourceId.startsWith("joined-board")&&!s.sourceId.startsWith("alias-board"));
  const invalid=await generateFromSources({target:"bun-sqlite",sources:{sources:supported}});expect(invalid).toMatchObject({ok:false,diagnostics:expect.arrayContaining([expect.objectContaining({code:"UI_EXTENSION_UNKNOWN"})])});
  const valid=await generateFromSources({target:"bun-sqlite",sources:{sources:supported},adminExtensions:extensions});expect(valid.ok).toBe(true);if(valid.ok)expect(valid.files["admin-descriptors.ts"]).toContain("export const collections");
});

test("descriptors have no runtime Core imports and unrelated Workers bundle none",async()=>{
  const {build}=await import("esbuild"),plan=await planOf(),{files}=await metadata(plan),dir=await mkdtemp(join(tmpdir(),"mantle-admin-metadata-"));
  try{
    await writeGenerated(dir,files);const entry=join(dir,"selected.ts");await writeFile(entry,'export {collections} from "./admin-descriptors.js";');
    const selected=await build({entryPoints:[entry],bundle:true,write:false,metafile:true,platform:"neutral",format:"esm"});expect(Object.keys(selected.metafile!.inputs)).toHaveLength(2);expect(selected.outputFiles![0]!.text).not.toContain("observationAvailability");expect(selected.outputFiles![0]!.text).not.toContain("ColumnRef");
    const unrelated=join(dir,"worker.ts");await writeFile(unrelated,'export default {fetch:()=>new Response("ok")};');const bare=await build({entryPoints:[unrelated],bundle:true,write:false,metafile:true,platform:"neutral",format:"esm"});expect(Object.keys(bare.metafile!.inputs)).toHaveLength(1);expect(bare.outputFiles![0]!.text).not.toContain("tasks");
  }finally{await rm(dir,{recursive:true,force:true});}
});


test("normalized publishing tool collisions are refused instead of overwriting a catalogue",async()=>{
  const input=[manifest("Schema","article-parts",schema({title:{type:"string"}},["title"],{lifecycle:"publishing"})),manifest("Procedure","publish-article-parts",{description:"A custom publication action.",input:{type:"object",properties:{id:{type:"string"}},required:["id"]},output:{type:"object"},handler:{ref:"customPublish"},target:{schema:"article-parts",id:"id"}}),manifest("Trigger","custom-publish-mcp",{source:{kind:"mcp",surface:"staff"},target:{procedure:"publish-article-parts"}})];
  const plan=await planOf(input),diagnostics:GenerateDiagnostic[]=[];emitAdminDescriptors({plan},diagnostics);
  expect(diagnostics).toHaveLength(1);expect(diagnostics[0]).toMatchObject({code:"GENERATE_UNSUPPORTED",path:"schemas/article-parts",message:expect.stringContaining("publish_article_parts")});
});

test("Admin generation accepts Schema properties named like Object.prototype members", async () => {
  const { generateFromSources } = await import("../src/infrastructure/generate.js");
  for (const field of ["__proto__", "constructor", "toString"]) {
    const text = `apiVersion: cms.mantle.aotter.net/v2\nkind: Schema\nmetadata: {name: notes}\nspec:\n  title: Notes\n  lifecycle: operational\n  indexes: [[title]]\n  schema: {type: object, required: [title], properties: {title: {type: string}, ${field}: {type: string}}}\n`;
    const result = await generateFromSources({ target: "bun-sqlite", admin: true, sources: { sources: [{ sourceId: "n.yaml", text }] } });
    expect(result.ok ? [] : result.diagnostics).toEqual([]);
  }
});
