/** Build-time projections only; generated exports are static, independently tree-shakable data. */
import { DiagnosticError, BUILT_IN_NAV_GROUPS, navGroupProblems, navPlacementProblems, isPrimaryCollection, formSchemaProblem, type JsonSchema, mcpTools, mcpToolNameSegment, toolTitle, collectionOf, developerConsole, rowPreconditions, checkPlanUiExtensions, planUiExtensionRefs, appCatalog, entrySchema, type AppRowAction } from "../build/compiler.js";
import type { GenerateDiagnostic, GenerateInput } from "../domain/model.js";
import { q } from "../domain/entry.js";
import { advertised, emitValidation } from "./validation.js";
import { publishingAnnotations, publishingInput, publishingTransitions } from "./publishing.js";
import { versioned } from "./tool-version.js";

const adminEnum = (p: JsonSchema): JsonSchema => { if(!p.oneOf) return p; const {oneOf,...rest}=p; return {...rest,enum:oneOf.map(c=>c.const)}; };

export function emitAdminDescriptors({plan,adminExtensions=[],navGroups=[],admin=false}:Pick<GenerateInput,"plan"|"adminExtensions"|"navGroups"|"admin">,diagnostics:GenerateDiagnostic[]):Record<string,string> {
  // Sidebar placement: every nav.group names a built-in group or a declared navGroups id (presentation only).
  for(const [path,message] of navGroupProblems(navGroups))diagnostics.push({code:"SCHEMA_UI_INVALID",path,message});
  const groupIds=new Set<string>([...BUILT_IN_NAV_GROUPS,...(Array.isArray(navGroups)?navGroups.map(g=>g?.id):[])]);
  const schemaList=Object.values(plan.schemas);
  const placed=[...schemaList.map(s=>["schemas/"+s.name,s.uiSchema,s] as const),...Object.entries(plan.views).map(([name,v])=>["views/"+name,v.uiSchema,null] as const)];
  for(const [path,ui,s] of placed){
    const nav=(ui?.["nav"]??{}) as Record<string,unknown>,group=nav["group"];
    if(typeof group==="string"&&!groupIds.has(group))diagnostics.push({code:"SCHEMA_UI_INVALID",path:path+"/uiSchema/nav/group",message:`Unknown nav group '${group}': use content, operations, reports or more, or declare it in navGroups of the --admin-extensions module.`});
    // a child folded under its parent, or a translation on its parent's language tabs, has no sidebar entry to place
    if(s&&!isPrimaryCollection(s,schemaList))for(const key of ["group","order","hidden"])if(nav[key]!==undefined)diagnostics.push({code:"SCHEMA_UI_INVALID",path:`${path}/uiSchema/nav/${key}`,message:s.translates?`Schema '${s.name}' has no sidebar entry to place: it is a translation, shown on its parent's language tabs.`:`Schema '${s.name}' has no sidebar entry to place: it is folded under its parent${collectionOf(s,schemaList).parent?.parentField==="id"?"; nav.standalone: true lists it in the sidebar.":" and opens from its parent's workbench (standalone needs a required id reference)."}`});
  }
  for(const e of adminExtensions)for(const p of e.contributes.pages??[]){
    if(p.nav===undefined)continue; // without nav a page keeps its own route and stays out of the sidebar
    const path=`admin/extensions/${e.id}/pages/${p.id}/nav`,nav=p.nav as unknown;
    if(!nav||typeof nav!=="object"||Array.isArray(nav)||typeof p.nav.group!=="string"){diagnostics.push({code:"UI_EXTENSION_INVALID",path,message:"A page nav is an object { group, order? }."});continue;}
    const group=p.nav.group,bad=p.nav.order===undefined?null:navPlacementProblems({order:p.nav.order});
    if(group!=="settings"&&!groupIds.has(group))diagnostics.push({code:"UI_EXTENSION_INVALID",path:path+"/group",message:`Unknown nav group '${group}'.`});
    if(bad)diagnostics.push({code:"UI_EXTENSION_INVALID",path:path+"/order",message:`nav.order must be ${bad[1]}.`});
  }
  try {checkPlanUiExtensions(plan,adminExtensions);} catch(error) {
    if(!(error instanceof DiagnosticError))throw error;
    const {code,path,message}=error.diagnostic;diagnostics.push({code,path,message});return {};
  }
  if(diagnostics.length)return {};
  const schemas=Object.values(plan.schemas);
  const allCollections=Object.fromEntries(schemas.map(s=>[s.name,{...collectionOf(s,schemas),...(admin ? {scopeField:s.scope ? s.names[s.scope] ?? s.scope : null,exportFields:Object.keys(s.fields).filter(f=>f!==s.scope&&s.fields[f]!=="geo").map(f=>s.names[f]??f)} : {})}]));
  const viewNames:Record<string,Record<string,string>>=Object.create(null);
  const views=Object.entries(plan.views).filter(([,v])=>v.surface==="admin").map(([name,v])=>{
    const columns=Object.fromEntries(Object.entries(v.columns??{}).map(([key,column])=>{
      const schema=plan.schemas[column.schema]!,field=schema.names[column.field]??column.field;
      const output=key===column.field?field:key;(viewNames[name]??=Object.create(null))[key]=output;
      return [output,{schema:schema.name,field}];
    }));
    const list=(v.uiSchema?.list??{}) as {columns?:string[];searchFields?:string[];filterFields?:string[];cells?:Record<string,string>};
    return {name,title:v.title??null,description:v.description??null,input:v.input??null,list:{columns:list.columns??[],searchFields:list.searchFields??[],filterFields:list.filterFields??[],cells:list.cells??{}},columns,...(v.uiSchema?.nav?{nav:v.uiSchema.nav}:{})};
  });
  const adminTools=mcpTools(plan,"admin"),toolNames=new Set(adminTools.map(t=>t.name));
  const operations=adminTools.filter(t=>t.kind==="procedure").map(t=>{
    const p=plan.procedures[t.source]!;
    const preconditions=p.target&&"sql" in p.handler?rowPreconditions(p.handler.sql.stmts,p.target.schema,p.target.id,plan.schemas[p.target.schema.toLowerCase()]?.schema??{}):[];
    return {...(preconditions.length?{preconditions}:{}),name:t.source,title:p.title??null,description:p.description??null,input:p.input,uiSchema:p.uiSchema??null,interactions:p.target?[{collection:p.target.schema,bind:[{input:p.target.id,field:"id"}],...(p.target.version?{version:p.target.version}:{}),mutates:true}]:[]};
  });
  const authorizations={views:Object.fromEntries(views.map(v=>[v.name,plan.views[v.name]!.requires??null])),procedures:Object.fromEntries(Object.entries(plan.procedures).map(([name,p])=>[name,p.requires??null]))};
  const adminCatalogue=appCatalog(plan,"admin");
  const catalogues={public:appCatalog(plan,"public"),admin:{views:Object.fromEntries(Object.entries(adminCatalogue.views).map(([name,v])=>[name,{...v,actions:[...v.actions]}])),actions:{...adminCatalogue.actions}}};
  const snapshot=developerConsole(plan);
  const webmcp={tools:adminTools.map(({name,source,kind,title,description,inputSchema,outputSchema,annotations})=>({target:{kind,name:source},...versioned({name,...(title?{title:(kind==="view"?plan.views[source]:plan.procedures[source])!.title??title}:{}),...advertised(inputSchema,(kind==="view"?plan.views[source]:plan.procedures[source])!.description??description),...(outputSchema?{outputSchema}:{}),...(annotations?{annotations}:{})})})),routes:Object.fromEntries(adminTools.flatMap(t=>{
    if(t.kind==="view")return [[t.name,{path:"/admin/views/"+encodeURIComponent(t.source)}]];
    const target=plan.procedures[t.source]!.target;return target?[[t.name,{path:"/admin/c/"+encodeURIComponent(plan.schemas[target.schema.toLowerCase()]?.name??target.schema),entry:true}]]:[];
  })) as Record<string,{path:string;entry?:boolean}>};
  // These are the actual generated transitions, not authored ref handlers or SQL IR.
  for(const schema of schemas.filter(s=>s.publishing))for(const [verb] of publishingTransitions){
    const name=schema.name+"."+verb,tool=mcpToolNameSegment(verb+"_"+schema.name);
    if(toolNames.has(tool)){diagnostics.push({code:"GENERATE_UNSUPPORTED",path:"schemas/"+schema.name,message:"Generated publishing tool '"+tool+"' conflicts with an admin tool."});continue;}
    toolNames.add(tool);
    const action:AppRowAction={capability:tool,inputSchema:publishingInput,bind:[{input:"id",field:"id"}],version:"expectedVersion",mutates:true};
    catalogues.admin.actions[tool]=action;
    for(const t of adminTools.filter(t=>t.kind==="view"))if(entrySchema(plan,plan.views[t.source]!)===schema.name.toLowerCase())catalogues.admin.views[t.name]!.actions.push(tool);

    authorizations.procedures[name]={auth:{all:["ctx.admin"]}};
    const description=verb+" an entry in "+schema.name+".";
    webmcp.tools.push({target:{kind:"procedure",name},...versioned({name:tool,title:toolTitle(verb+"_"+schema.name),description,inputSchema:publishingInput,annotations:publishingAnnotations(verb)})});
    webmcp.routes[tool]={path:"/admin/c/"+encodeURIComponent(schema.name),entry:true};
    snapshot.interfaces.callable.push({kind:"procedure",name:tool,target:name,surface:"admin",audience:"admin",title:null,description,input:publishingInput,output:null,trigger:null});
  }
  const extensionIds = new Set<string>();
  const extensionMetadata = adminExtensions.map(extension => {
    if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(extension.id) || extensionIds.has(extension.id) || extension.apiVersion !== undefined && extension.apiVersion !== 1) diagnostics.push({code:"UI_EXTENSION_INVALID",path:"admin/extensions/"+extension.id,message:"Extensions need unique kebab-case ids and apiVersion 1."});
    extensionIds.add(extension.id);
    const {source, handlers: _handlers, bodyLimit: _bodyLimit, ...declaration} = extension as typeof extension & {handlers?: unknown; bodyLimit?: number};
    if (source !== undefined) diagnostics.push({code:"GENERATE_UNSUPPORTED",path:"admin/extensions/"+extension.id,message:"Native Admin uses host-served module paths; source modules are not served. Set module and install its integrity in the host shell import map."});
    if (extension.module && (!extension.module.startsWith("/") || extension.module.startsWith("//") || /[\\?#]/.test(extension.module))) diagnostics.push({code:"UI_EXTENSION_INVALID",path:"admin/extensions/"+extension.id,message:"module must be a same-origin absolute path."});
    return {id:extension.id,declaration:JSON.stringify(declaration),public:declaration,...(extension.module?{module:extension.module}:{}),...(extension.integrity?{integrity:extension.integrity}:{}),source:false,settings:(extension.contributes.settings??[]).map(s=>s.id),actions:(extension.contributes.actions??[]).map(a=>({id:a.id,target:a.target,...(a.when?.schema?{schema:a.when.schema}:{})}))};
  });
  const checks: string[] = [], validationFiles: Record<string,string> = {};
  for (const extension of adminExtensions) for (const settings of extension.contributes.settings ?? []) {
    const key=extension.id+"/"+settings.id, problem=formSchemaProblem(settings.schema);
    if(problem){diagnostics.push({code:"UI_EXTENSION_INVALID",path:"admin/extensions/"+key,message:problem});continue;}
    const input={...settings.schema,additionalProperties:false,properties:Object.fromEntries(Object.entries(settings.schema.properties??{}).map(([name,p])=>[name,adminEnum(p)]))};
    const file=extension.id+"__"+settings.id; // ponytail: no "/" so Node ESM can import the emitted module
    const generated=emitValidation({views:{},procedures:{[file]:{input}}},(path,message)=>diagnostics.push({code:"GENERATE_UNSUPPORTED",path,message}));
    Object.assign(validationFiles,generated);
    const alias="check"+checks.length;
    checks.push(`import {validate as ${alias}} from "./validation/procedures/${encodeURIComponent(file)}.js";`);
  }
  const settingsKeys=adminExtensions.flatMap(e=>(e.contributes.settings??[]).map(s=>e.id+"/"+s.id));
  const bindings = "import {extensionOptions} from '@aotter/mantle-admin/server/extensions';\nimport type {AdminExtension} from '@aotter/mantle-admin/server/extensions';\nimport {extensionMetadata} from './admin-descriptors.js';\nimport {ContractError} from '@aotter/mantle/contracts';\n"+checks.join("\n")+"\nconst checks={"+settingsKeys.map((key,n)=>`${q(key)}:(value:unknown)=>{try{check${n}(value);return {};}catch(error){if(!(error instanceof ContractError))throw error;return {[(error.path.split('/input/')[1]??'').replace(/~1/g,'/').replace(/~0/g,'~')]:error.message};}}`).join(",")+"};\nexport const extensionBindings=<Env,DB>(definitions:readonly AdminExtension<Env,DB>[])=>extensionOptions<Env,DB>(extensionMetadata,checks,definitions);\n";
  const data={allCollections,views,operations,navGroups,fieldNames:Object.fromEntries(schemas.map(s=>[s.name,s.names])),viewNames,authorizations,developerConsole:snapshot,mcpAppCatalogues:catalogues,webmcp,extensionBindings:planUiExtensionRefs(plan),extensionMetadata};
  return {...validationFiles,...(adminExtensions.length && admin ? {"admin-extensions.ts":bindings} : {}),"admin-descriptors.ts":"// Generated static Admin metadata. Import only the exports the application uses.\n"+literals(data)+"\nexport const collections = ["+schemas.filter(s=>!s.translates).map(s=>"allCollections["+q(s.name)+"]").join(",")+"] as const;\nexport const bootstrap = {collections, allCollections, operations, views, navGroups, webmcp, developerConsole} as const;\n"};
}

/**
 * Each export as a JSON literal; a subtree of 40 or more bytes that would be printed more than once is printed once, as a
 * module-private constant the exports reference (a bundler keeps only those an imported export reaches).
 */
function literals(exports: Record<string, unknown>): string {
  const data = JSON.parse(q(exports)) as Record<string, unknown>, count = new Map<string, number>(), hoisted = new Map<string, string>(), constants: string[] = [];
  const each = (value: unknown, visit: (json: string, value: object) => void) => { if (value && typeof value === "object") for (const child of Object.values(value)) if (child && typeof child === "object") visit(q(child), child); };
  const tally = (json: string, value: object, by = 1): void => { if (json.length >= 40) count.set(json, (count.get(json) ?? 0) + by); each(value, (json, child) => tally(json, child, by)); };
  for (const value of Object.values(data)) each(value, tally);
  // Longest first: once a subtree is printed once, what it contains occurs (copies - 1) times fewer per occurrence in it.
  for (const json of [...count.keys()].sort((a, b) => b.length - a.length)) {
    const copies = count.get(json)!;
    if (copies > 1) { hoisted.set(json, ""); each(JSON.parse(json), (inner, child) => tally(inner, child, 1 - copies)); }
  }
  let named = 0;
  const print = (value: unknown): string => !value || typeof value !== "object" ? q(value) : Array.isArray(value) ? "[" + value.map(reference).join(",") + "]" : "{" + Object.entries(value).map(([key, child]) => (key === "__proto__" ? "["+q(key)+"]" : q(key)) + ":" + reference(child)).join(",") + "}";
  const reference = (value: unknown): string => {
    const json = q(value);
    if (hoisted.get(json) === "") { const name = "$" + named++; hoisted.set(json, name); constants.push("const " + name + " = " + print(value) + " as const;"); }
    return hoisted.get(json) ?? print(value);
  };
  const lines = Object.entries(data).map(([name, value]) => "export const " + name + " = " + print(value) + " as const;");
  return [...constants, ...lines].join("\n");
}
