/** Static route wiring over the generated descriptor, validation and native query modules. */
import type { JsonSchema, RuntimePlan } from "@aotter/mantle/compiler";
import type { GenerateInput } from "../domain/model.js";
import { databaseImport } from "../domain/entry.js";
import { authPredicate, conversions } from "../domain/input.js";
import { emitPaging } from "./paging.js";
import { boundaryPage, declaredType, outputConversions } from "../domain/columns.js";
const q=JSON.stringify;
const allows=(requires:RuntimePlan["views"][string]["requires"])=>"(caller: Caller) => "+((requires?.auth?.all??[]).map(authPredicate).join(" && ")||"true");
export function emitAdmin({plan,lowered,target,site,adminPages,paging}:GenerateInput,refuse:(path:string,message:string)=>void):Record<string,string> {
  const refs=Object.values(plan.procedures).some(p=>"ref" in p.handler), imports=[`import { admin as serve, type Options } from "@aotter/mantle-next/admin";`,`import type { Caller } from "@aotter/mantle-next/contracts";`,databaseImport(target),`import { bootstrap } from "./admin-descriptors.js";`,...(refs?[`import { store, type Handlers } from "./generated.js";`]:[]),...(site?[`import { site } from "./site.js";`]:[])];
  const webmcp=Object.values(plan.views).some(view=>view.surface==="staff")||Object.values(plan.triggers).some(trigger=>trigger.source.kind==="mcp"&&trigger.source.surface==="staff");
  if(webmcp)imports.push('import { webmcpRoutes } from "@aotter/mantle-next/admin-webmcp";','import { staffTools } from "./mcp-tools.js";');
  imports.push('import { siteRoutes } from "@aotter/mantle-next/admin-site";');
  imports.push('import {adminEntries} from "./admin-entries.js";');
  const views:string[]=[],operations:string[]=[],files:Record<string,string>={};let hasWire=false;
  const staffPlan={...plan,views:Object.fromEntries(Object.entries(plan.views).filter(([,view])=>view.surface==="staff"))};
  for(const [path,source] of Object.entries(emitPaging(staffPlan,lowered,target,refuse,paging,adminPages)))files[path.replace("paged/","admin-paged/")]=source;
  const conversion=(input:JsonSchema|undefined,binds:Parameters<typeof conversions>[1])=>{const code=conversions(input?.properties,binds,target);return code?`, convert: ${code}`:"";};
  for(const [name,view] of Object.entries(plan.views).filter(([,v])=>v.surface==="staff")){
    const id=views.length,list=view.uiSchema?.list as {columns?:string[];searchFields?:string[];filterFields?:string[]}|undefined;
    imports.push(`import page${id} from "./admin-paged/views/${encodeURIComponent(name)}.js";`,`import { query as query${id} } from "./validation/views/${encodeURIComponent(name)}.js";`);
    const names=Object.entries(view.columns??{}).flatMap(([key,c])=>{const name=key===c.field?plan.schemas[c.schema]?.names[c.field]??key:key;return name===key?[]:[`[${q(key)}]:${q(name)}`];});
    const filterValues:string[]=[],helpers=new Set<string>();
    const filters=(list?.filterFields??[]).map(field=>{const c=view.columns?.[field]??view.columns?.[field.toLowerCase()],s=c&&plan.schemas[c.schema],native=s&&declaredType(s.fields,c!.field);
      if(native==="date"||native==="timestamptz"){const helper=native==="date"?"date":"timestamp";helpers.add(helper);filterValues.push(`[${q(field)}]:${helper}`);}
      return[field,[s?.schema.properties?.[s.names[c!.field]??c!.field]?.type].flat().find(t=>t&&t!=="null")??"string"];
    });
    if(helpers.size)imports.push(`import {${[...helpers].map(h=>h+" as "+h+id).join(",")}} from "@aotter/mantle-next/dialect/${target.endsWith("postgres")?"postgres":"sqlite"}";`);
    const wire=outputConversions(plan,name,target);hasWire ||= !!wire.length;
    views.push(`{ name:${q(name)}, allows:${allows(view.requires)}, query:query${id}, page:${boundaryPage(`page${id}`,wire)}${conversion(view.input,lowered.views[name]?.caller?.binds??[])}${names.length?`, names:{${names.join(",")}}`:""}, columns:${q(list?.columns??[])}, search:${!!list?.searchFields?.length}, filters:${q(filters)}${filterValues.length?`, filterValues:{${filterValues.map(v=>v+id).join(",")}}`:""}, sqlite:${!target.endsWith("postgres")} }`);
  }
  const procedures=[...new Set(Object.values(plan.triggers).filter(t=>t.source.kind==="mcp"&&t.source.surface==="staff").map(t=>t.procedure))];
  for(const name of procedures){
    const p=plan.procedures[name]!,id=operations.length,ref="ref" in p.handler;
    imports.push(`import { validate as validate${id} } from "./validation/procedures/${encodeURIComponent(name)}.js";`);
    if(!ref)imports.push(`import operation${id} from "./procedures/${encodeURIComponent(name)}.js";`);
    operations.push(`{ name:${q(name)}, allows:${allows(p.requires)}, validate:validate${id}${conversion(p.input,lowered.procedures[name]?.caller?.flatMap(s=>s.binds)??[])}, run:${ref?`(db,caller,input,handlers) => store(db,caller,{handlers}).procedures[${q(name)}](input)`:`operation${id}`} }`);
  }
  if(hasWire)imports.push('import {wireRows} from "@aotter/mantle-next/contracts";');
  files["admin.ts"]=`${imports.join("\n")}\nexport function admin<Env>(options: Options<Env,Database>${refs?" & {handlers:Handlers}":""}) {\n  return serve<Env,Database${refs?",Handlers":""}>({...bootstrap,collectionNames:${q(Object.values(plan.schemas).map(s=>s.name))}},[${views.join(",\n")}],[${operations.join(",\n")}],{...${site?"{site,...options}":"options"},routes:[...adminEntries<Env>(${refs?"options":""}),...siteRoutes(${site?"{site,...options}":"options"}),${webmcp?`...webmcpRoutes<Env,Database${refs?",Handlers":",never"}>(bootstrap.webmcp,staffTools(),${refs?"options.handlers":"undefined as never"}),`:""}...(options.routes??[])]});\n}\n`;
  return files;
}
