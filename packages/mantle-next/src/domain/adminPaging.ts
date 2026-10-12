/** Build-time predicates on the Core page's outputs, before its keyset LIMIT. */
import type { RuntimePlan, SqlNode as N } from "@aotter/mantle/spec";
import { declaredType } from "./columns.js";
const col = (name: string): N => ({ColumnRef:{fields:[{String:{sval:"_p"}},{String:{sval:name}}]}});
const cast = (arg: N, type: string): N => ({TypeCast:{arg,typeName:{names:[{String:{sval:type}}],typemod:-1}}});
const bool = (boolop: string, args: N[]): N => ({BoolExpr:{boolop,args}});
const op = (name: string, lexpr: N, rexpr: N): N => ({A_Expr:{kind:"AEXPR_OP",name:[{String:{sval:name}}],lexpr,rexpr}});
export function adminPage(ast: N, view: RuntimePlan["views"][string], schemas: RuntimePlan["schemas"], sqlite: boolean): {ast:N;matches:string[]} {
  const list = view.uiSchema?.list as {searchFields?:string[];filterFields?:string[]} | undefined;
  const matches:string[]=[], conditions:N[]=[], result=structuredClone(ast), sel=result.SelectStmt;
  if (!sel.fromClause?.[0]?.RangeSubselect || !sel.targetList.some((t:N)=>t.ResTarget.name==="_k0")) return {ast:result,matches};
  let index=0;
  const scan=(node:unknown):void=>{if(!node||typeof node!=="object")return;const n=node as N;if(n.ParamRef)index=Math.max(index,n.ParamRef.number);for(const v of Object.values(n))scan(v);};scan(result);
  const output=(name:string)=>sel.targetList.find((t:N)=>t.ResTarget.name===name)?.ResTarget.name ?? name.toLowerCase();
  const param=(key:string,type:string)=>{matches.push(key);return cast({ParamRef:{number:++index}},type);};
  const optional=(value:N,condition:N)=>bool("OR_EXPR",[{NullTest:{arg:value,nulltesttype:"IS_NULL"}},condition]);
  if(list?.searchFields?.length){
    const value=param("search","text"), lower=(arg:N):N=>({FuncCall:{funcname:[{String:{sval:"lower"}}],args:[arg],funcformat:"COERCE_EXPLICIT_CALL"}});
    conditions.push(optional(value,bool("OR_EXPR",list.searchFields.map(name=>({A_Expr:{kind:"AEXPR_LIKE",name:[{String:{sval:"~~"}}],lexpr:lower(cast(col(output(name)),"text")),rexpr:{FuncCall:{funcname:[{String:{sval:"like_escape"}}],args:[lower(value),{A_Const:{sval:{sval:"\\"}}}],funcformat:"COERCE_EXPLICIT_CALL"}}}})))));
  }
  for(const name of list?.filterFields??[]){
    const provenance=view.columns?.[name]??view.columns?.[name.toLowerCase()], schema=provenance&&schemas[provenance.schema];
    const property=schema?.schema.properties?.[schema.names[provenance!.field]??provenance!.field];
    const type=[property?.type].flat().find(t=>t&&t!=="null"), native=schema&&declaredType(schema.fields,provenance!.field);
    let value=param("filter."+name,type==="boolean"?(sqlite?"integer":"boolean"):type==="integer"?"bigint":type==="number"?"double precision":native==="date"||native==="timestamptz"?(sqlite?"bigint":"text"):"text");
    if(!sqlite&&(native==="date"||native==="timestamptz"))value=cast(value,native);
    conditions.push(optional(value,op("=",col(output(name)),value)));
  }
  if(conditions.length)sel.whereClause=bool("AND_EXPR",[...(sel.whereClause?[sel.whereClause]:[]),...conditions]);
  return {ast:result,matches};
}
