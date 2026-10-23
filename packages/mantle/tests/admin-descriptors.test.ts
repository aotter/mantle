import {expect,test} from "bun:test";
import {mkdtemp,rm,writeFile} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {compilePlan,type RuntimePlan} from "../src/build/compiler.js";
import * as compiler from "../src/build/d1/compile/index.js";
import {collectionOf,developerConsole,lookupLocalRef,rowPreconditions} from "../src/build/compiler.js";
import {appCatalog} from "../src/build/compiler.js";
import {emitAdminDescriptors} from "../src/usecase/adminDescriptors.js";
import {describeApp} from "../src/domain/describe/index.js";
import {generateFromSources} from "../src/infrastructure/generateAuth.js";
import type {GenerateDiagnostic} from "../src/domain/model.js";
import {loadGenerated,writeGenerated} from "./apps/link.js";
const manifest=(kind:string,name:string,spec:object)=>({sourceId:name+".json",text:JSON.stringify({apiVersion:"cms.mantle.aotter.net/v2",kind,metadata:{name},spec})});
const schema=(properties:object,required:string[],extras:object={})=>({title:"Records",lifecycle:"operational",schema:{type:"object",properties,required},...extras});
const sources=[
  manifest("Schema","projects",schema({title:{type:"string"},code:{type:"string"},cover:{type:"string","x-mcp-hint":"media-image"}},["title","code"],{uniqueIndexes:[["code"]]})),
  manifest("Schema","tasks",schema({projectId:{type:"string","x-mantle-ref":"projects"},projectCode:{type:"string","x-mantle-ref":{schema:"projects",field:"code"}},title:{type:"string"},expiresAt:{type:"string",format:"date-time"},priority:{type:"integer"},state:{type:"string",enum:["todo","done"]}},["projectId","projectCode","priority","state"],{indexes:[["priority"],["state"]],searchableFields:["projectCode"],ttl:{field:"expiresAt",expireAfterSeconds:3600},uiSchema:{list:{primaryField:"title",columns:["projectCode","state"],filterField:"state"},nav:{standalone:true,parentField:"projectId"},fields:{title:{widget:"textarea"}}}})),
  manifest("View","tasks-board",{surface:"admin",sql:"SELECT t.id,t.title,t.projectCode,t.priority,t.state,t.created_at FROM tasks t ORDER BY t.id",uiSchema:{list:{columns:["projectCode","state"],searchFields:["title"],filterFields:["state"]}}}),
  manifest("View","joined-board",{surface:"admin",sql:"SELECT t.id,p.title FROM tasks t JOIN projects p ON p.id=t.projectId ORDER BY t.id"}),
  manifest("View","alias-board",{surface:"admin",sql:"SELECT title AS id FROM tasks ORDER BY id"}),
  manifest("View","cte-board",{surface:"admin",sql:"WITH board AS (SELECT id,projectCode FROM tasks) SELECT id,projectCode FROM board ORDER BY id"}),
  manifest("View","totals",{surface:"admin",sql:"SELECT sum(priority) AS total FROM tasks"}),
  manifest("View","public-tasks",{surface:"public",sql:"SELECT id,title FROM tasks ORDER BY id"}),
  manifest("View","internal-tasks",{surface:"internal",sql:"SELECT id,title FROM tasks ORDER BY id"}),
  manifest("Procedure","mark-done",{title:"Complete",description:"Complete a task.",requires:{auth:{all:["ctx.admin"]}},input:{type:"object",properties:{entryId:{type:"string"},expectedVersion:{type:"integer"}},required:["entryId","expectedVersion"]},output:{type:"object"},target:{schema:"tasks",id:"entryId",version:"expectedVersion"},handler:{sql:"UPDATE tasks SET state='done',priority=CASE WHEN priority>1 THEN priority-1 ELSE priority END WHERE id=input.entryId AND version=input.expectedVersion AND state='todo' RETURNING id,state"}}),
  manifest("Procedure","notify-task",{input:{type:"object",properties:{entryId:{type:"string"},message:{type:"string"}},required:["entryId"]},output:{type:"object"},target:{schema:"tasks",id:"entryId"},handler:{ref:"notify"}}),
  manifest("Trigger","notify-http",{source:{kind:"http",method:"POST",path:"/api/notify"},target:{procedure:"notify-task"}}),
  manifest("Trigger","complete-mcp",{source:{kind:"mcp",surface:"admin"},target:{procedure:"mark-done"}}),
];
async function planOf(input=sources):Promise<RuntimePlan>{const result=await compilePlan({sources:input},compiler,"operational");if(!result.ok)throw Error(JSON.stringify(result.diagnostics));return result.plan;}
async function metadata(plan:RuntimePlan){const diagnostics:GenerateDiagnostic[]=[];const files=emitAdminDescriptors({plan},diagnostics);expect(diagnostics).toEqual([]);return {files,loaded:await loadGenerated(files["admin-descriptors.ts"]!)};}

test("Admin projections match 0.2 collections, operations, SQL graph and MCP catalogue",async()=>{
  const plan=await planOf(),{loaded:m,files}=await metadata(plan),schemas=Object.values(plan.schemas);
  expect(m.collections).toEqual(schemas.map(s=>collectionOf(s,schemas)));
  expect(m.collections.find((x:any)=>x.name==="tasks")).toMatchObject({parent:{collection:"projects",parentField:"id",childField:"projectId"},nav:{standalone:true,parentField:"projectId",parentCollection:"projects"},sortableFields:["priority","state"],searchableFields:["projectCode"],filter:{field:"state",values:["todo","done"]},list:{primaryField:"title",columns:["projectCode","state"]}});
  expect(m.collections.find((x:any)=>x.name==="projects").searchableFields).toEqual([]);
  expect(m.operations).toHaveLength(1);expect(m.operations[0]).toMatchObject({name:"mark-done",preconditions:[{field:"state",values:["todo"]}],interactions:[{collection:"tasks",bind:[{input:"entryId",field:"id"}],version:"expectedVersion",mutates:true}]});
  const p=plan.procedures["mark-done"]!;if("sql" in p.handler)expect(m.operations[0].preconditions).toEqual(rowPreconditions(p.handler.sql.stmts,"tasks","entryId",plan.schemas.tasks!.schema));
  expect(m.views.map((v:any)=>v.name)).not.toContain("public-tasks");expect(m.views.map((v:any)=>v.name)).not.toContain("internal-tasks");expect(Object.keys(m.authorizations.views)).toEqual(m.views.map((v:any)=>v.name));
  expect(m.views.find((v:any)=>v.name==="tasks-board").columns.projectCode).toEqual({schema:"tasks",field:"projectCode"});expect(m.viewNames["tasks-board"].projectcode).toBe("projectCode");expect(m.fieldNames.tasks.projectid).toBe("projectId");expect(m.views.find((v:any)=>v.name==="cte-board").columns.projectCode).toEqual({schema:"tasks",field:"projectCode"});expect(m.views.find((v:any)=>v.name==="totals").columns.total).toEqual({schema:"tasks",field:"priority"});
  expect(m.developerConsole.dataModel.views.find((v:any)=>v.name==="internal-tasks").surface).toBe("internal");expect(m.developerConsole.interfaces.callable.some((v:any)=>v.target==="internal-tasks")).toBe(false);expect(m.developerConsole).toEqual(developerConsole(plan));expect(m.developerConsole.logic.procedures[0].handler.flow[0].cases).toHaveLength(1);
  expect(m.developerConsole.graph.relations).toEqual(expect.arrayContaining([expect.objectContaining({kind:"schema-reference",pointer:"/spec/schema/properties/projectId/x-mantle-ref"}),expect.objectContaining({kind:"trigger-target",targetId:"Procedure:mark-done"})]));
  expect(m.developerConsole.operations).toMatchObject({schedules:[],ttlPolicies:[{schema:"tasks",field:"expiresAt",expireAfterSeconds:3600,sweepObservation:"unavailable"}],observationAvailability:"unavailable",runs:[],latestRuns:[]});
  expect(m.mcpAppCatalogues).toEqual({public:appCatalog(plan,"public"),admin:appCatalog(plan,"admin")});expect(m.mcpAppCatalogues.admin.views.tasks_board.actions).toEqual(["mark_done"]);expect(m.mcpAppCatalogues.admin.views.joined_board.actions).toEqual([]);expect(m.mcpAppCatalogues.admin.views.alias_board.actions).toEqual([]);
  expect(m.webmcp.routes.mark_done).toEqual({path:"/admin/c/tasks",entry:true});for(const tool of m.webmcp.tools)expect(tool.description).toEndWith(` (tool version ${tool.version})`);expect(m.bootstrap).toEqual({collections:m.collections,allCollections:m.allCollections,operations:m.operations,views:m.views,webmcp:m.webmcp,developerConsole:expect.any(Function)});
  expect((await loadGenerated(files["admin-developer-console.ts"]!)).developerConsole).toEqual(m.developerConsole);expect(files["admin-developer-console.ts"]).not.toMatch(/^import\b/m);
  for(const removed of ["extensionBindings","extensionMetadata","navGroups"])expect(Object.keys(m)).not.toContain(removed);expect(Object.keys(m)).toContain("bootstrap");
  expect(files["admin-descriptors.ts"]).not.toMatch(/^import\b/m);expect(files["admin-descriptors.ts"]).not.toContain('"stmts":');expect(files["admin-descriptors.ts"]).not.toContain('"ColumnRef":');
});

test("translation projection folds children, inherits media and retains composition",async()=>{
  const plan=await planOf([sources[0]!,manifest("Schema","project-translations",schema({code:{type:"string"},locale:{type:"string"},title:{type:"string"},photo:{type:"string","x-mcp-hint":"media-image"}},["code","locale","title"],{localized:true,translates:{parent:"projects",on:"code"}}))]),{loaded:m}=await metadata(plan);
  expect(m.collections.map((s:any)=>s.name)).toEqual(["projects"]);expect(m.collections[0]).toMatchObject({hasTranslations:true,mediaFields:[{name:"cover",hint:"media-image"},{name:"photo",hint:"media-image"}]});
  expect(m.collections[0]).toBe(m.allCollections.projects);
  expect(m.allCollections["project-translations"]).toMatchObject({localized:true,parent:{collection:"projects",parentField:"code",childField:"code"},translates:{parent:"projects",on:"code"}});
  expect(m.developerConsole.graph.relations).toEqual(expect.arrayContaining([expect.objectContaining({kind:"translation-parent",sourceId:"Schema:project-translations",targetId:"Schema:projects"})]));
});

test("publishing descriptors use generated Procedure and canonical admin MCP names",async()=>{
  const plan=await planOf([manifest("Schema","articles",schema({title:{type:"string"}},["title"],{lifecycle:"publishing"})),manifest("View","articles-list",{surface:"admin",sql:"SELECT id,title FROM articles ORDER BY id"}),manifest("View","articles-second",{surface:"admin",sql:"SELECT id,title FROM articles ORDER BY id"})]),{loaded:m}=await metadata(plan);
  expect(m.operations).toEqual([]);expect(m.webmcp.tools.map((t:any)=>t.name)).toEqual(["articles_list","articles_second","publish_articles","unpublish_articles","archive_articles"]);expect(m.webmcp.routes.publish_articles).toEqual({path:"/admin/c/articles",entry:true});expect(m.webmcp.tools.map((t:any)=>[t.title,t.annotations])).toEqual([["Articles list",{readOnlyHint:true,destructiveHint:false}],["Articles second",{readOnlyHint:true,destructiveHint:false}],["Publish articles",{readOnlyHint:false,destructiveHint:false}],["Unpublish articles",{readOnlyHint:false,destructiveHint:false}],["Archive articles",{readOnlyHint:false,destructiveHint:true}]]);
  expect(m.mcpAppCatalogues.admin.views.articles_list.actions).toEqual(["publish_articles","unpublish_articles","archive_articles"]);expect(m.mcpAppCatalogues.admin.views.articles_second.actions).toEqual(["publish_articles","unpublish_articles","archive_articles"]);expect(m.mcpAppCatalogues.public.actions).toEqual({});expect(m.authorizations.procedures["articles.publish"].auth.all).toEqual(["ctx.admin"]);
  expect(m.developerConsole.interfaces.callable.find((t:any)=>t.name==="publish_articles")).toMatchObject({target:"articles.publish",surface:"admin",audience:"admin"});
});

test("generation refuses the removed extension references: widget, list.cells and panels",async()=>{
  const supported=sources.filter(s=>!s.sourceId.startsWith("complete-mcp")&&!s.sourceId.startsWith("joined-board")&&!s.sourceId.startsWith("alias-board"));
  const ok=await generateFromSources({target:"bun-sqlite",sources:{sources:supported}});expect(ok.ok).toBe(true);if(ok.ok)expect(ok.files["admin-descriptors.ts"]).toContain("export const collections");
  const swap=(name:string,edit:(spec:any)=>void)=>supported.map(s=>{if(s.sourceId!==name+".json")return s;const doc=JSON.parse(s.text);edit(doc.spec);return {...s,text:JSON.stringify(doc)};});
  const refused=async(input:typeof supported)=>{const r=await generateFromSources({target:"bun-sqlite",sources:{sources:input}});expect(r.ok).toBe(false);return r.ok?"":JSON.stringify(r.diagnostics);};
  expect(await refused(swap("tasks",spec=>{spec.uiSchema.fields.title={widget:"audit/color"};}))).toContain("widget must be 'textarea'");
  expect(await refused(swap("tasks",spec=>{spec.uiSchema.fields.title={widget:"audit/color",options:{palette:"brand"}};}))).toContain("options");
  expect(await refused(swap("tasks",spec=>{spec.uiSchema.fields.title={widget:"textarea",options:{}};}))).toContain("options");
  expect(await refused(swap("tasks",spec=>{spec.uiSchema.list.cells={state:"audit/state"};}))).toContain("SCHEMA_UI_INVALID");
  expect(await refused(swap("tasks",spec=>{spec.uiSchema.panels=["audit/history"];}))).toContain("panels");
  expect(await refused(swap("tasks-board",spec=>{spec.uiSchema.list.cells={state:"audit/state"};}))).toContain("VIEW_UI_INVALID");
});

test("descriptors have no runtime Core imports and unrelated Workers bundle none",async()=>{
  const {build}=await import("esbuild"),plan=await planOf(),{files}=await metadata(plan),dir=await mkdtemp(join(tmpdir(),"mantle-admin-metadata-"));
  try{
    await writeGenerated(dir,files);const entry=join(dir,"selected.ts");await writeFile(entry,'export {collections} from "./admin-descriptors.js";');
    const selected=await build({entryPoints:[entry],bundle:true,write:false,metafile:true,platform:"neutral",format:"esm"});expect(Object.keys(selected.metafile!.inputs)).toHaveLength(3);expect(selected.outputFiles![0]!.text).not.toContain("observationAvailability");expect(selected.outputFiles![0]!.text).not.toContain("ColumnRef");
    const unrelated=join(dir,"worker.ts");await writeFile(unrelated,'export default {fetch:()=>new Response("ok")};');const bare=await build({entryPoints:[unrelated],bundle:true,write:false,metafile:true,platform:"neutral",format:"esm"});expect(Object.keys(bare.metafile!.inputs)).toHaveLength(1);expect(bare.outputFiles![0]!.text).not.toContain("tasks");
  }finally{await rm(dir,{recursive:true,force:true});}
});

test("row preconditions derive AND equality/IN literals only from the declared target-row write",async()=>{
  const check=async(sql:string)=>{
    const plan=await planOf([sources[0]!,sources[1]!,manifest("Procedure","act",{input:{type:"object",properties:{id:{type:"string"}},required:["id"]},output:{type:"object"},target:{schema:"tasks",id:"id"},handler:{sql}})]);
    const p=plan.procedures.act!; if(!("sql" in p.handler))throw Error("SQL required");
    return rowPreconditions(p.handler.sql.stmts,"tasks","id",plan.schemas.tasks!.schema);
  };
  expect(await check("UPDATE tasks SET state='done' WHERE id=input.id AND state='todo' AND priority=1 RETURNING id")).toEqual([{field:"state",values:["todo"]}]);
  expect(await check("UPDATE tasks SET state='done' WHERE id=input.id AND priority=1 RETURNING id")).toEqual([]);
  expect(await check("DELETE FROM tasks AS t WHERE t.id=input.id AND t.state IN ('todo','done') RETURNING id")).toEqual([{field:"state",values:["todo","done"]}]);
  expect(await check("UPDATE tasks SET state='done' WHERE id=input.id AND 'todo'=state RETURNING id")).toEqual([{field:"state",values:["todo"]}]);
  expect(await check("UPDATE tasks SET state='done' WHERE id=input.id AND (state='todo' OR priority=1) RETURNING id")).toEqual([]);
  expect(await check("UPDATE tasks SET state='done' WHERE id=input.id AND priority>1 RETURNING id")).toEqual([]);
  const plan=await planOf(),{loaded:m}=await metadata(plan);
  expect(m.operations[0].preconditions).toEqual([{field:"state",values:["todo"]}]);
});

test("WebMCP advertises View and Procedure input rules as description sentences; Admin operations and describe keep them",async()=>{
  const input={type:"object",properties:{entryId:{type:"string"},expectedVersion:{type:"integer"},note:{type:"string"}},required:["entryId","expectedVersion"],dependentRequired:{note:["expectedVersion"]}};
  const plan=await planOf([...sources.map(s=>s.sourceId==="mark-done.json"?manifest("Procedure","mark-done",{...JSON.parse(s.text).spec,input}):s),
    manifest("View","titled",{surface:"admin",description:"Find tasks.",input:{type:"object",properties:{a:{type:"string"},b:{type:"string"}},anyOf:[{required:["a"]},{required:["b"]}]},sql:"SELECT id,title FROM tasks WHERE title = input.a OR title = input.b ORDER BY id"}),
    manifest("View","referred",{surface:"admin",description:"Find by reference.",input:{type:"object",properties:{a:{type:"string"},b:{type:"string"}},$ref:"#/$defs/t",$defs:{t:{type:"object",properties:{a:{},b:{}},anyOf:[{required:["a"]},{required:["b"]}]}}},sql:"SELECT id,title FROM tasks ORDER BY id"})]);
  const {loaded:m}=await metadata(plan);
  const tool=m.webmcp.tools.find((t:any)=>t.name==="mark_done");
  expect(tool.description).toBe(`Complete a task. 'expectedVersion' is required when 'note' is present. (tool version ${tool.version})`);
  expect(tool.inputSchema).not.toHaveProperty("dependentRequired");
  expect(m.operations[0].input).toEqual(input);
  const view=m.webmcp.tools.find((t:any)=>t.name==="titled");
  expect(view.description).toBe(`Find tasks. At least one of 'a', 'b' is required. (tool version ${view.version})`);
  expect(view.inputSchema).not.toHaveProperty("anyOf");
  const referred=m.webmcp.tools.find((t:any)=>t.name==="referred");
  expect(referred.description).toBe(`Find by reference. At least one of 'a', 'b' is required. (tool version ${referred.version})`);
  expect(referred.inputSchema).toMatchObject({properties:{a:{type:"string"},b:{type:"string"}}});
  expect(referred.inputSchema).not.toHaveProperty("anyOf");
  const described=(await describeApp(plan)).targets.find(t=>t._meta.id==="view:titled")!;
  expect(described.inputSchema).toMatchObject({anyOf:[{required:["a"]},{required:["b"]}]});
});

test("a View tool keeps every rule of its root $ref chain",async()=>{
  // Validation applies both dependentRequired rules: an 'a' needs 'b' and 'c'.
  const properties={a:{type:"string"},b:{type:"string"},c:{type:"string"}};
  const plan=await planOf([...sources,manifest("View","chained",{surface:"admin",description:"Find tasks.",input:{type:"object",properties,dependentRequired:{a:["b"]},$ref:"#/$defs/t",
    $defs:{t:{type:"object",properties,dependentRequired:{a:["c"]}}}},sql:"SELECT id,title FROM tasks ORDER BY id"})]);
  const {loaded:m}=await metadata(plan);
  const tool=m.webmcp.tools.find((t:any)=>t.name==="chained");
  expect(tool.description).toBe(`Find tasks. 'c' is required when 'a' is present. 'b' is required when 'a' is present. (tool version ${tool.version})`);
  expect(tool.inputSchema).not.toHaveProperty("allOf");
  const described=(await describeApp(plan)).targets.find(t=>t._meta.id==="view:chained")!;
  expect(described.inputSchema).toMatchObject({allOf:[{dependentRequired:{a:["c"]}},{dependentRequired:{a:["b"]}}]});
});

test("a View tool keeps the definitions its lifted fields reference",async()=>{
  const plan=await planOf([...sources,manifest("View","counted",{surface:"admin",input:{type:"object",properties:{},$ref:"#/$defs/t",
    $defs:{count:{type:"integer",minimum:1},unused:{type:"string"},t:{type:"object",properties:{count:{$ref:"#/$defs/count"}}}}},sql:"SELECT id,title FROM tasks ORDER BY id"})]);
  const {loaded:m}=await metadata(plan);
  const tool=m.webmcp.tools.find((t:any)=>t.name==="counted");
  expect(tool.inputSchema.$defs).toEqual({count:{type:"integer",minimum:1}});
  expect(lookupLocalRef(tool.inputSchema,tool.inputSchema.properties.count.$ref)).toEqual({type:"integer",minimum:1});
});
