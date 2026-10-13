/** Print native Admin matching fragments once. No compiler, AST or authored schema reaches requests. */
import type {RuntimePlan,SqlNode} from "../build/compiler.js";
import {adminEntries} from "./adminEntries.js";
import {wireScalars} from "../domain/wireScalars.js";
import {boundaryType} from "../domain/columns.js";
import type {Dialect} from "../kernel/dialect/common.js";
import type {GenerateDiagnostic} from "../domain/model.js";
import { viewOutputs, compileProgram } from "../build/compiler.js";
import { pagedOf } from "../build/compiler.js";
import type { MantleDialect } from "../build/compiler.js";
import {castCursor,type PagingProof} from "../domain/paging.js";
import { nextMode } from "../domain/visibility.js";
import type {AdminPage} from "../domain/model.js";
export function adminPaging(plan:RuntimePlan,dialect:MantleDialect,proofs:Readonly<Record<string,PagingProof|undefined>>,project:(ast:SqlNode,names:readonly string[],keys:number,name:string)=>SqlNode):Record<string,{caller:AdminPage;trusted:AdminPage}>{
  const all:Record<string,{caller:AdminPage;trusted:AdminPage}>=Object.create(null);
  for(const [name,v]of Object.entries(plan.views).filter(([,v])=>v.surface!=="internal")){
    const proof=proofs[name];if(!proof || proof.reason)throw Error(proof?.reason ?? `Unproved Admin paging: ${name}`);
    const list=(v.uiSchema?.list??{}) as {filterFields?:string[];searchFields?:string[]};
    const modes=v.surface==="public" ? ["public","public"] as const : [nextMode("caller"),"trusted"] as const;
    const pages=modes.map(mode=>{
      const [c]=compileProgram(v.stmts,{dialect,schemas:plan.schemas,inputs:v.inputs,kind:"view",mode});
      if(!c)throw Error(`No compiled Admin View: ${name}`);
      const keys=c.ast.SelectStmt.sortClause?.length??0;
      if(keys!==proof.types.length)throw Error(`Incomplete Admin cursor proof: ${name}`);
      const first=pagedOf({schemas:plan.schemas,dialect},c,undefined,!keys&&(list.filterFields?.length||list.searchFields?.length)?{eq:[{column:(list.filterFields??list.searchFields)![0]!,value:""}]}:undefined), next=keys?pagedOf({schemas:plan.schemas,dialect},c,Array(keys).fill(0),undefined):undefined;
      if(!keys&&!first.flat)first.ast.SelectStmt.whereClause=undefined;
      const reserved=JSON.stringify([c.ast,v.source,list,Object.values(plan.schemas).map(s=>s.fields)]);
      let marker=32767;while(reserved.includes(String(marker)))marker++;
      const print=(ast:SqlNode)=>dialect.print!(ast,plan.schemas);
      const read=(p:typeof first)=>{const typed=castCursor(p.ast,p.sources,proof.types,!!dialect.nativeOrder);return {prefix:print(project({SelectStmt:{...typed.SelectStmt,whereClause:undefined,sortClause:undefined,limitCount:undefined,limitOption:"LIMIT_OPTION_DEFAULT"}},p.flat?viewOutputs(v,plan.schemas).keys??[]:p.names,keys,name))+(typed.SelectStmt.whereClause?` WHERE (${expression(typed.SelectStmt.whereClause)})`:""),extra:p.sources.filter(x=>"cursor"in x).map(x=>(x as {cursor:number}).cursor)};};
      const suffixAst={SelectStmt:{targetList:[{ResTarget:{val:{A_Const:{ival:{ival:1}}}}}],sortClause:keys?first.ast.SelectStmt.sortClause:undefined,limitCount:{ParamRef:{number:marker}},limitOption:"LIMIT_OPTION_COUNT",op:"SETOP_NONE"}};
      const tail=print(suffixAst).replace(/^SELECT 1/,"");
      const expression=(ast:SqlNode)=>print({SelectStmt:{targetList:[{ResTarget:{val:ast}}],limitOption:"LIMIT_OPTION_DEFAULT",op:"SETOP_NONE"}}).replace(/^SELECT /,"");
      const fragment=(match:Parameters<typeof pagedOf>[3],type?:string)=>{
        const p=pagedOf({schemas:plan.schemas,dialect},c,undefined,match);
        const ast=structuredClone(p.ast.SelectStmt.whereClause);
        const renumber=(node:SqlNode)=>{if(node.ParamRef){node.ParamRef.number=marker;if(dialect.nativeOrder&&(type==="date"||type==="timestamptz")){delete node.ParamRef;node.Raw={parts:["CAST(CAST(",{ParamRef:{number:marker}},` AS text) AS ${type})`]};return;}}for(const child of Object.values(node))if(child&&typeof child==="object")Array.isArray(child)?child.forEach(renumber):renumber(child);};
        renumber(ast);return expression(ast);
      };
      return {marker:dialect.nativeOrder?`$${marker}`:`?${marker}`,binds:c.binds,keys,first:read(first),...(next?{next:read(next)}:{}),tail,eq:Object.fromEntries((list.filterFields??[]).map(field=>{const col=v.columns?.[field]??v.columns?.[field.toLowerCase()],type=col&&plan.schemas[col.schema]?.fields[col.field];return [field,fragment({eq:[{column:field,value:""}]},type)];})),...(list.searchFields?.length?{search:fragment({search:{columns:list.searchFields,text:"x"}})}:{})};
    });
    all[name]={caller:pages[0]!,trusted:pages[1]!};
  }
  return all;
}

/** Only selected build-time Admin work; the ordinary generator remains unchanged. */
export async function adminBindingsOf(plan:RuntimePlan,dialect:MantleDialect,paging:Readonly<Record<string,PagingProof|undefined>>,wire:Dialect,refusals:GenerateDiagnostic[]){
  let adminPages:ReturnType<typeof adminPaging>|undefined;
  try{adminPages=adminPaging(plan,dialect,paging,(ast,names,nkeys,name)=>{
    const keys=[...names,...Array.from({length:nkeys},(_,i)=>`_k${i}`)];
    const projected=wireScalars(ast,keys,[...names.map(key=>boundaryType(plan,name,key)),...(paging[name]?.types??[])],wire,true);
    if(typeof projected==="string")throw Error(projected);return projected;
  });}catch(error){refusals.push({code:"GENERATE_UNSUPPORTED",path:"admin/views",message:error instanceof Error?error.message:String(error)});}
  return {ok:true as const,adminPages,adminEntries:await adminEntries(plan,dialect,wire as Dialect,refusals)};
}
