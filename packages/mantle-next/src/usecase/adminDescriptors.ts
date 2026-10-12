/** Build-time projections only; generated exports are static, independently tree-shakable data. */
import { DiagnosticError, mcpTools, mcpToolNameSegment } from "@aotter/mantle/spec";
import { STAFF_ROLES } from "../domain/visibility.js";
import { collectionOf, developerConsole, requiredEnumStates, checkPlanUiExtensions, planUiExtensionRefs } from "@aotter/mantle/admin";
import { appCatalog, entrySchema, type AppRowAction } from "@aotter/mantle/mcp";
import type { GenerateDiagnostic, GenerateInput } from "../domain/model.js";
import { publishingInput, publishingTransitions } from "./publishing.js";

export function emitAdminDescriptors({plan,adminExtensions=[]}:Pick<GenerateInput,"plan"|"adminExtensions">,diagnostics:GenerateDiagnostic[]):Record<string,string> {
  try {checkPlanUiExtensions(plan,adminExtensions);} catch(error) {
    if(!(error instanceof DiagnosticError))throw error;
    const {code,path,message}=error.diagnostic;diagnostics.push({code,path,message});return {};
  }
  if(diagnostics.length)return {};
  const schemas=Object.values(plan.schemas);
  const allCollections=Object.fromEntries(schemas.map(s=>[s.name,collectionOf(s,schemas)]));
  const viewNames:Record<string,Record<string,string>>={};
  const views=Object.entries(plan.views).filter(([,v])=>v.surface==="staff").map(([name,v])=>{
    const columns=Object.fromEntries(Object.entries(v.columns??{}).map(([key,column])=>{
      const schema=plan.schemas[column.schema]!,field=schema.names[column.field]??column.field;
      const output=key===column.field?field:key;(viewNames[name]??={})[key]=output;
      return [output,{schema:schema.name,field}];
    }));
    const list=(v.uiSchema?.list??{}) as {columns?:string[];searchFields?:string[];filterFields?:string[];cells?:Record<string,string>};
    return {name,title:v.title??null,description:v.description??null,input:v.input??null,list:{columns:list.columns??[],searchFields:list.searchFields??[],filterFields:list.filterFields??[],cells:list.cells??{}},columns};
  });
  const staffTools=mcpTools(plan,"staff"),toolNames=new Set(staffTools.map(t=>t.name));
  const operations=staffTools.filter(t=>t.kind==="procedure").map(t=>{
    const p=plan.procedures[t.source]!,requiredStates=p.target&&"sql" in p.handler?requiredEnumStates(p.handler.sql.stmts,p.target.schema,plan.schemas[p.target.schema.toLowerCase()]?.schema??{}):[];
    return {...(requiredStates.length?{requiredStates}:{}),name:t.source,title:p.title??null,description:p.description??null,input:p.input,uiSchema:p.uiSchema??null,interactions:p.target?[{collection:p.target.schema,bind:[{input:p.target.id,field:"id"}],...(p.target.version?{version:p.target.version}:{}),mutates:true}]:[]};
  });
  const authorizations={views:Object.fromEntries(views.map(v=>[v.name,plan.views[v.name]!.requires??null])),procedures:Object.fromEntries(Object.entries(plan.procedures).map(([name,p])=>[name,p.requires??null]))};
  const staffCatalogue=appCatalog(plan,"staff");
  const catalogues={public:appCatalog(plan,"public"),staff:{views:Object.fromEntries(Object.entries(staffCatalogue.views).map(([name,v])=>[name,{...v,actions:[...v.actions]}])),actions:{...staffCatalogue.actions}}};
  const snapshot=developerConsole(plan);
  const webmcp={tools:staffTools.map(({name,title,description,inputSchema,outputSchema,annotations})=>({name,...(title?{title}:{}),description,inputSchema,...(outputSchema?{outputSchema}:{}),...(annotations?{annotations}:{})})),routes:Object.fromEntries(staffTools.flatMap(t=>{
    if(t.kind==="view")return [[t.name,{path:"/admin/views/"+encodeURIComponent(t.source)}]];
    const target=plan.procedures[t.source]!.target;return target?[[t.name,{path:"/admin/c/"+encodeURIComponent(plan.schemas[target.schema.toLowerCase()]?.name??target.schema),entry:true}]]:[];
  })) as Record<string,{path:string;entry?:boolean}>};
  // These are the actual generated transitions, not authored ref handlers or SQL IR.
  for(const schema of schemas.filter(s=>s.publishing))for(const [verb] of publishingTransitions){
    const name=schema.name+"."+verb,tool=mcpToolNameSegment(verb+"_"+schema.name);
    if(toolNames.has(tool)){diagnostics.push({code:"GENERATE_UNSUPPORTED",path:"schemas/"+schema.name,message:"Generated publishing tool '"+tool+"' conflicts with a staff tool."});continue;}
    toolNames.add(tool);
    const action:AppRowAction={capability:tool,inputSchema:publishingInput,bind:[{input:"id",field:"id"}],version:"expectedVersion",mutates:true};
    catalogues.staff.actions[tool]=action;
    for(const t of staffTools.filter(t=>t.kind==="view"))if(entrySchema(plan,plan.views[t.source]!)===schema.name.toLowerCase())catalogues.staff.views[t.name]!.actions.push(tool);

    authorizations.procedures[name]={auth:{all:[{"ctx.staff":[...STAFF_ROLES]}]}};
    const description=verb+" an entry in "+schema.name+".";
    snapshot.interfaces.callable.push({kind:"procedure",name:tool,target:name,surface:"staff",audience:"staff",title:null,description,input:publishingInput,output:null,trigger:null});
  }
  const data={allCollections,views,operations,fieldNames:Object.fromEntries(schemas.map(s=>[s.name,s.names])),viewNames,authorizations,developerConsole:snapshot,mcpAppCatalogues:catalogues,webmcp,extensionBindings:planUiExtensionRefs(plan)};
  return {"admin-descriptors.ts":"// Generated static Admin metadata. Import only the exports the application uses.\n"+Object.entries(data).map(([name,value])=>"export const "+name+" = "+JSON.stringify(value)+" as const;").join("\n")+"\nexport const collections = ["+schemas.filter(s=>!s.translates).map(s=>"allCollections["+JSON.stringify(s.name)+"]").join(",")+"] as const;\nexport const bootstrap = {collections, operations, views, webmcp} as const;\n"};
}
