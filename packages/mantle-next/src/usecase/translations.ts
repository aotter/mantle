/** Translation helpers use generated SQL policy, never a request-time manifest. */
import { rowPolicy, type RuntimePlan, type PlanSchema } from "@aotter/mantle/spec";
import type { Target } from "../domain/model.js";
import type { Dialect } from "../kernel/dialect/common.js";
import { renderTerm } from "../kernel/store.js";
import {dialect as SQLITE} from "../kernel/dialect/sqlite.js";
import {dialect as POSTGRES} from "../kernel/dialect/postgres.js";
import {declaredType} from "../domain/columns.js";
import { nextMode, STAFF_ROLES } from "../domain/visibility.js";
const q=JSON.stringify;
/** The parent is checked by the same atomic UPDATE that publishes the child. */
export function publishedParent(plan: RuntimePlan, child: PlanSchema, d: Dialect, recipes: object[], trusted: boolean): string {
  const tr=child.translates!,parent=plan.schemas[tr.parent.toLowerCase()]!,on=tr.on.toLowerCase();
  const conditions=[`p.${d.ident(on)} = ${d.ident(child.name)}.${d.ident(on)}`];
  if(parent.scope) conditions.push(`p.${d.ident(parent.scope)} = ${d.ident(child.name)}.${d.ident(child.scope ?? parent.scope)}`);
  if(parent.publishing) conditions.push("p.status = 'published'");
  for(const term of rowPolicy(parent,trusted?"trusted":"caller",STAFF_ROLES,plan.schemas)) conditions.push(renderTerm(d,term,"p.",recipe=>(recipes.push(recipe),d.param(recipes.length))));
  return `EXISTS (SELECT 1 FROM ${d.ident(parent.name)} p WHERE ${conditions.join(" AND ")})`;
}
export function emitTranslations(plan:RuntimePlan,target:Target):Record<string,string> {
  const d=target.endsWith("postgres")?POSTGRES:SQLITE;
  const children=Object.values(plan.schemas).filter(s=>s.translates);
  if(!Object.values(plan.schemas).some(s=>s.localized))return {};
  if(!children.length)return {"translations.ts":'export {toCanonicalLocale} from "@aotter/mantle-next/translations";\n'};
  const parents=[...new Set(children.map(s=>s.translates!.parent.toLowerCase()))], declarations:string[]=[],descriptors:string[]=[];
  const driver=target==="bun-sqlite"?"bun-sqlite":target==="cloudflare-d1"?"d1":"postgres";
  for(const parent of parents) {
    const schema=plan.schemas[parent]!,types=children.filter(s=>s.translates!.parent.toLowerCase()===parent);
    const entries=types.map(child=>{
      const on=child.translates!.on.toLowerCase(),type=declaredType(child.fields,on);
      const key="t."+d.ident(on),projection=type==="timestamptz"?d.wireTimestamp(key).join(""):type==="date"?d.wireDate(key).join(""):key;
      const variants=[nextMode("caller"),"trusted" as const].map(mode=>{
        const terms=rowPolicy(child,mode,STAFF_ROLES,plan.schemas),recipes:object[]=[];
        const where=terms.map(term=>renderTerm(d,term,"t.",recipe=>(recipes.push(recipe),d.param(recipes.length)))).join(" AND ");
        return `{where:${q(where)},binds:${q(recipes)}}`;
      });
      return `{on:${q(on)},type:${q(type ?? "text")},sql:${q(`SELECT t.id AS _id, ${projection} AS _key, t.locale FROM ${d.ident(child.name)} t`)},caller:${variants[0]},trusted:${variants[1]}}`;
    });
    const columns=[...new Set(types.map(s=>s.translates!.on.toLowerCase()))];
    declarations.push(`${q(schema.name)}: Pick<Tables[${q(schema.name)}]["row"],${["id",...columns.filter(c=>c!==schema.scope)].map(value=>q(value)).join("|")}>${schema.scope&&columns.includes(schema.scope)?` & {readonly ${q(schema.scope)}?:string|null}`:""};`);
    descriptors.push(`${q(schema.name)}:[${entries.join(",")}]`);
  }
  return {"translations.ts":`import {ContractError,type Caller${driver==="postgres"?",type Postgres as Database":""}} from "@aotter/mantle-next/contracts";
${driver!=="postgres"?`import type {Handle as Database} from "@aotter/mantle-next/driver/${driver}";`:""}
import {read} from "@aotter/mantle-next/driver/${driver}";
import {binds,encode} from "@aotter/mantle-next/binds";
import {param,ident${driver==="postgres"?",cast":""},timestamp,date} from "@aotter/mantle-next/dialect/${driver==="postgres"?"postgres":"sqlite"}";
import type {Tables} from "./generated.js";
export {toCanonicalLocale} from "@aotter/mantle-next/translations";
export interface TranslationParents {${declarations.join("\n")}}
const descriptors={${descriptors.join(",")}} as const;
/** Only pass the current parent page (up to 500); reads are bounded to its keys. */
export async function translationLocales<P extends keyof TranslationParents>(db:Database,caller:Caller,parent:P,parents:readonly TranslationParents[P][]):Promise<Record<string,string[]>> {
 if(parents.length>500)throw new ContractError("INPUT_VALIDATION_FAILED","Pass one parent page, at most 500 rows.","translations");
 const out:Record<string,string[]>=Object.fromEntries(parents.map(row=>[row.id,[]]));
 for(const child of descriptors[parent]) {
  const rows=parents as readonly Record<string,unknown>[],keys=[...new Set(rows.map(row=>row[child.on]).filter(value=>value!==null&&value!==undefined&&value!==""))];
  const byKey=new Map<unknown,Set<string>>(),mode=caller.kind==="system"?child.trusted:child.caller;
  for(let i=0;i<keys.length;i+=50) {
   const base=binds({},mode.binds,caller),batch=keys.slice(i,i+50);let after:string|undefined;
   do {
    const values=[...base,...batch.map(value=>encode({timestamp,date},child.type,value))],where=[...(mode.where?[mode.where]:[]),"t."+ident(child.on)+" IN ("+batch.map((_,index)=>${driver==="postgres"?"cast(param(base.length+index+1),child.type)":"param(base.length+index+1)"}).join(",")+")"];
    if(after!==undefined){values.push(after);where.push("t.id > "+param(values.length));}
    const translations:Record<string,unknown>[]=await read(db,child.sql+" WHERE "+where.join(" AND ")+" ORDER BY t.id LIMIT 500",values);
    for(const row of translations)if(typeof row.locale==="string")byKey.set(row._key,(byKey.get(row._key)??new Set()).add(row.locale));
    after=translations.length===500?String(translations.at(-1)!._id):undefined;
   }while(after!==undefined);
  }
  for(const row of rows)for(const locale of byKey.get(row[child.on])??[])if(!out[String(row.id)]!.includes(locale))out[String(row.id)]!.push(locale);
 }
 return out;
}
`};
}
