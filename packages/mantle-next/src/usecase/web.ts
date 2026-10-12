/** Optional web output calls public generated Views; SQL owns visibility. Rendering is the kernel's. */
import type { RuntimePlan, PlanLowered } from "@aotter/mantle/spec";
import type { Target } from "../domain/model.js";
import {databaseImport} from "../domain/entry.js";
import { conversions } from "../domain/input.js";
export function emitWeb(plan: RuntimePlan, lowered: PlanLowered, target: Target): Record<string,string> {
  const views=Object.entries(plan.views).filter(([,v])=>v.surface==="public"), q=JSON.stringify;
  const table=views.map(([name,v],i)=>{
    const binds=lowered.views[name]?.public?.binds??[], convert=conversions(v.input?.properties,binds,target);
    const booleans=Object.keys(v.input?.properties??{}).filter(field=>binds.some(b=>b.k==="input"&&String(b.name).toLowerCase()===field.toLowerCase()&&String(b.type)==="bool"));
    return `[${q(name)}, { query: input${i}, page: page${i}${convert?`, convert: ${convert}`:""}${booleans.length?`, booleans: ${q(booleans)}`:""} }]`;
  });
  return {"web.ts": [
    ...views.flatMap(([n],i)=>[`import page${i} from "./paged/views/${encodeURIComponent(n)}.js";`,`import { query as input${i} } from "./validation/views/${encodeURIComponent(n)}.js";`,`import type { Row as Row${i} } from "./views/${encodeURIComponent(n)}.js";`]),
    'import { web as site, type Options, type Page } from "@aotter/mantle-next/web";',
    databaseImport(target),
    `type App = { Rows: {${views.map(([n],i)=>`${q(n)}:Row${i}`).join(";")}}; Inputs: {${views.map(([n,v])=>`${q(n)}:${Object.keys(v.input?.properties??{}).map(k=>q(k)).join(" | ")||"never"}`).join(";")}}; List: ${views.filter(([,v])=>!v.input?.required?.length).map(([n])=>q(n)).join(" | ")||"never"} };`,
    "export function web<const P extends Record<string, Page<App>>, E = unknown>(options: Options<App, Database, P, E>) {",
    `  return site<Database, E>(options, [${table.join(", ")}]);`,
    "}"].join("\n")+"\n"};
}
