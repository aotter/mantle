/** Routes reference selected generated boundaries, never a runtime manifest; request handling is the kernel's. */
import type { RuntimePlan, PlanLowered } from "@aotter/mantle/spec";
import type { Target } from "../domain/model.js";
import {databaseImport} from "../domain/entry.js";
import { conversions } from "../domain/input.js";
const q = JSON.stringify;
export function emitRest(plan: RuntimePlan, lowered: PlanLowered, target: Target): Record<string,string> {
  const refs = Object.values(plan.procedures).some(p=>"ref" in p.handler);
  const imports = ['import { rest as serve, type Options } from "@aotter/mantle-next/rest";', databaseImport(target), ...(refs ? ['import { store, type Handlers } from "./generated.js";'] : [])];
  const views:string[]=[], procedures:string[]=[];
  const convert = (code:string) => code ? `, convert: ${code}` : "";
  for (const [name,view] of Object.entries(plan.views)) {
    if(view.surface!=="public") continue;
    const id=views.length,encoded=encodeURIComponent(name);
    imports.push(`import page${id} from "./paged/views/${encoded}.js";`,`import { query as query${id} } from "./validation/views/${encoded}.js";`);
    views.push(`{ view: ${q(name)}, query: query${id}, page: page${id}${convert(conversions(view.input?.properties,(lowered.views[name]?.public ?? lowered.views[name]?.caller)?.binds ?? [],target))} }`);
  }
  const triggers=Object.values(plan.triggers).filter(t=>t.source.kind==="http").sort((a,b)=>a.source.kind==="http"&&b.source.kind==="http"?(a.source.path.match(/\{/g)?.length??0)-(b.source.path.match(/\{/g)?.length??0):0);
  for(const trigger of triggers) {
    if(trigger.source.kind!=="http") continue;
    const {method,path}=trigger.source,name=trigger.procedure,procedure=plan.procedures[name]!,id=procedures.length,ref="ref" in procedure.handler;
    if(!ref) imports.push(`import procedure${id} from "./procedures/${encodeURIComponent(name)}.js";`);
    imports.push(`import { validate as validate${id} } from "./validation/procedures/${encodeURIComponent(name)}.js";`);
    const params=Object.fromEntries([...path.matchAll(/\{([^}]+)\}/g)].flatMap(([,key])=>{
      const type=[procedure.input?.properties?.[key!]?.type].flat().find(t=>t&&t!=="null");
      return type==="integer"||type==="number"?[[key,"number"]]:type==="boolean"?[[key,"boolean"]]:[];
    }));
    procedures.push(`{ method: ${q(method)}, path: ${q(path)}${Object.keys(params).length?`, params: ${q(params)}`:""}, validate: validate${id}${convert(conversions(procedure.input?.properties,lowered.procedures[name]?.caller?.flatMap(s=>s.binds) ?? [],target))}, run: ${ref?`(db, caller, input, handlers) => store(db, caller, { handlers }).procedures[${q(name)}](input)`:`procedure${id}`} }`);
  }
  const list = (items:string[]) => items.length ? `[\n${items.map(item=>"    "+item+",\n").join("")}  ]` : "[]";
  return {"rest.ts":`${imports.join("\n")}
export function rest<Env>(options: Options<Env, Database>${refs?" & { handlers: Handlers }":""}): (request: Request, env: Env) => Promise<Response | undefined> {
  return serve<Env, Database${refs?", Handlers":""}>(${list(views)}, ${list(procedures)}, options);
}
`};
}
