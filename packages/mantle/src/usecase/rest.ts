/** Routes reference selected generated boundaries, never a runtime manifest; request handling is the kernel's. */
import type { RuntimePlan, PlanLowered } from "../build/compiler.js";
import type { Target } from "../domain/model.js";
import { databaseImport, q, viewImports } from "../domain/entry.js";
import { authLines, conversions } from "../domain/input.js";
import { boundaryPage, outputConversions } from "../domain/columns.js";
export function emitRest(plan: RuntimePlan, lowered: PlanLowered, target: Target): Record<string,string> {
  const guard = (requires: RuntimePlan["views"][string]["requires"], path: string) => {
    const lines = authLines(requires, path);
    return lines.length ? `, check: (caller) => {${lines.join("")}}` : "";
  };
  const refs = Object.values(plan.procedures).some(p=>"ref" in p.handler);
  const imports = ['import { rest as serve, type Options } from "@aotter/mantle/rest";', databaseImport(target), ...(refs ? ['import { store, type Handlers } from "./generated.js";'] : [])];
  if ([...Object.values(plan.views), ...Object.values(plan.procedures)].some(p => p.requires?.auth?.all.length)) imports.push('import { deny, isAdmin, isUser } from "@aotter/mantle/contracts";');
  const views:string[]=[], procedures:string[]=[];
  let hasWire = false;
  const convert = (code:string) => code ? `, convert: ${code}` : "";
  // Each segment matches in its encoded form; `{name}` segments capture.
  const route = (method:string, path:string) => {
    const keys:string[] = [];
    const source = path.split("/").map(segment => segment.startsWith("{") && segment.endsWith("}") ? (keys.push(segment.slice(1,-1)), "([^/]+)") : encodeURIComponent(segment).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("/");
    return `method: ${q(method)}, pattern: new RegExp(${q("^"+source+"/?$")})${keys.length ? `, keys: ${q(keys)}` : ""}`;
  };
  for (const [name,view] of Object.entries(plan.views)) {
    if(view.surface!=="public") continue;
    const id=views.length,encoded=encodeURIComponent(name);
    const wire = outputConversions(plan, name, target);
    imports.push(...viewImports(name,id).map(line=>wire.some(([,type])=>type==="int") ? line.replaceAll("./paged/views/", "./paged/wire/views/") : line));
    hasWire ||= wire.length > 0;
    views.push(`{ ${route("GET",`/api/views/${name}`)}, target: ${q({kind:"view",name})}${guard(view.requires,`views/${name}`)}, query: query${id}, page: ${boundaryPage(`page${id}`, wire)}${convert(conversions(view.input?.properties,(lowered.views[name]?.public ?? lowered.views[name]?.caller)?.binds ?? [],target))} }`);
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
    procedures.push(`{ ${route(method,path)}, id: ${q(`rest:${method} ${path.replace(/\{([^}]+)\}/g, ":$1")}`)}, target: ${q({kind:"procedure",name})}${!ref && (lowered.procedures[name]?.caller?.length ?? 0) > 0 && lowered.procedures[name]?.caller?.every(s=>s.kind==="read") ? ", readOnly: true" : ""}${guard(procedure.requires,`procedures/${name}`)}${Object.keys(params).length?`, params: ${q(params)}`:""}, validate: validate${id}${convert(conversions(procedure.input?.properties,lowered.procedures[name]?.caller?.flatMap(s=>s.binds) ?? [],target))}, run: ${ref?`(db, caller, input, handlers) => store(db, caller, { handlers }).procedures[${q(name)}](input)`:`procedure${id}`} }`);
  }
  if (hasWire) imports.push('import { wireRows } from "@aotter/mantle/contracts";');
  const list = (items:string[]) => items.length ? `[\n${items.map(item=>"    "+item+",\n").join("")}  ]` : "[]";
  return {"rest.ts":`${imports.join("\n")}
export function rest<Env>(options: Options<Env, Database>${refs?" & { handlers: Handlers }":""}): (request: Request, env: Env, ctx?: import("@aotter/mantle/contracts").RequestContext) => Promise<Response | undefined> {
  return serve<Env, Database${refs?", Handlers":""}>(${list([...views, ...procedures])}, ${plan.access ? `{...options, fields: ${q(plan.access.userFields)}, accessTargets: () => import("./access-targets.js").then(m => m.targets)}` : '{...options, accessTargets: () => import("./access-targets.js").then(m => m.targets)}'});
}
`};
}
