/** Selected Admin queries/procedures: Core checks, rewrites and prints every native fragment at generation. */
import {enumOptions,protectedColumns,type RuntimePlan,type SqlNode} from "../build/compiler.js";
import type { MantleDialect } from "../build/compiler.js";
import { parsePgSql } from "../build/compiler.js";
import { compileProgram } from "../build/compiler.js";
import { adminOrder } from "../domain/adminOrder.js";
import { declaredType, serverOwned } from "../domain/columns.js";
import { wireScalars, wireReturning } from "../domain/wireScalars.js";
import { recipesOf } from "../domain/recipes.js";
import type { Dialect } from "../kernel/dialect/common.js";
import type { GenerateDiagnostic } from "../domain/model.js";

type Schema=RuntimePlan["schemas"][string];
const ref=(...names:string[]):SqlNode=>({ColumnRef:{fields:names.map(sval=>({String:{sval}}))}});
const op=(lexpr:SqlNode,rexpr:SqlNode):SqlNode=>({A_Expr:{kind:"AEXPR_OP",name:[{String:{sval:"="}}],lexpr,rexpr}});
const and=(...args:SqlNode[])=>args.length===1?args[0]:{BoolExpr:{boolop:"AND_EXPR",args}};
const system=(s:Schema)=>["id","version","created_at","updated_at","author_id",...(s.publishing?["status","published_at"]:[])];
const fields=(s:Schema)=>Object.keys(s.fields).filter(f=>f!==s.scope).flatMap(f=>s.fields[f]==="geo"?[f+"_lat",f+"_lng"]:[f]);
export async function adminEntries(plan:RuntimePlan,dialect:MantleDialect,wire:Dialect,refusals:GenerateDiagnostic[]){
  const result:Record<string,unknown>=Object.create(null),postgres=!!dialect.nativeOrder;
  const tableNames=new Set(Object.keys(plan.schemas).map(name=>name.toLowerCase()));let rowsName="_mantle_admin_rows";while(tableNames.has(rowsName.toLowerCase()))rowsName+="_";const rowsAlias={name:rowsName,sql:wire.ident(rowsName)};
  const parse=async(sql:string)=>{const {stmts}=await parsePgSql(sql);const visit=(n:SqlNode)=>{if(n.RangeVar)n.RangeVar.mantle="table";for(const value of Object.values(n))if(value&&typeof value==="object")Array.isArray(value)?value.forEach(visit):visit(value);};stmts.forEach(visit);return stmts;};
  const print=(ast:SqlNode)=>dialect.print!(ast,plan.schemas);
  const expr=(value:SqlNode)=>print({SelectStmt:{targetList:[{ResTarget:{val:value}}],op:"SETOP_NONE",limitOption:"LIMIT_OPTION_DEFAULT"}}).replace(/^SELECT /,"");
  for(const s of Object.values(plan.schemas))try{
    const columns=[...system(s),...fields(s)],writable=Object.keys(s.fields).filter(f=>f!==s.scope&&s.fields[f]!=="geo");
    const parent=s.translates&&plan.schemas[s.translates.parent.toLowerCase()];
    const types=columns.map(f=>declaredType(s.fields,f)??(f==="version"?"integer":f.endsWith("_lat")||f.endsWith("_lng")?"real":"text"));
    // Compiler scope names belong only to relations this generated query can reference.
    const schemas:Record<string,Schema>=Object.create(null);let relation:Schema|undefined=s;
    while(relation&&!Object.hasOwn(schemas,relation.name)){schemas[relation.name]=relation;relation=relation.translates?plan.schemas[relation.translates.parent.toLowerCase()]:undefined;}
    const ctx=(kind:"view"|"procedure",trusted:boolean,inputs:Record<string,string>)=>({dialect,schemas,inputs,kind,mode:trusted?"trusted" as const:"admin" as const});
    const select=`SELECT ${columns.map(c=>`${wire.ident(s.name)}.${wire.ident(c)}`).join(",")} FROM ${wire.ident(s.name)}`;
    const base=await parse(select);
    const project=(ast:SqlNode,names:readonly string[],keys:readonly string[])=>{
      const projected=wireScalars(ast,[...names,...keys.map((_,i)=>`_k${i}`)],[...names.map(n=>types[columns.indexOf(n)]??(parent?declaredType(parent.fields,n):undefined)),...keys],wire,true);
      if(typeof projected==="string")throw Error(projected);return projected;
    };
    let marker=32767;const authored=JSON.stringify([plan.schemas,s]);while(authored.includes(String(marker)))marker++;
    const markerText=wire.param(marker);
    const usedNames=new Set([...columns,...(parent?fields(parent):[])].map(name=>name.toLowerCase()));
    const cursorAliases=[0,1].map(i=>{let name="_mantle_admin_key"+i;while(usedNames.has(name.toLowerCase()))name+="_";usedNames.add(name.toLowerCase());return {name,sql:wire.ident(name)};});
    const ordered=adminOrder(s),fieldFacts:Record<string,unknown>=Object.create(null);
    for(const column of [...system(s),...writable]){
      const type=declaredType(s.fields,column)??(column==="version"?"integer":"text");
      if(!["text","integer","int4","int8","real","float8","bool","date","timestamptz"].includes(type))continue;
      const expression=wire.ident(s.name)+"."+wire.ident(column),[kind,nullable]=(Object.hasOwn(ordered,column)?ordered[column]:undefined)??[];
      fieldFacts[column]={expression,value:wire.cast(markerText,type),wire:kind&&["integer","int8","int4"].includes(type)?`CAST(${expression} AS text)`:kind&&type==="date"?wire.wireDate(expression).join(""):kind&&type==="timestamptz"?wire.wireTimestamp(expression).join(""):expression,nullable:nullable??true,...(kind?{kind}:{})};
    }
    const filter=(s.uiSchema?.list as {filterField?:string}|undefined)?.filterField,enums=enumOptions(filter?s.schema.properties?.[filter]:undefined)?.map(choice=>choice.value);
    const literal=(v:string)=>"'"+v.replaceAll("'","''")+"'";let subtype="NULL",option=0;
    if(filter&&enums?.length){const type=s.fields[filter.toLowerCase()],temporal=type==="date"||type==="timestamptz";
      try{subtype="CASE "+enums.map((value,index)=>{option=index;if(postgres&&temporal&&/^0000-/.test(value.trim()))throw Error("PostgreSQL requires a nonzero year.");const native=type==="date"?wire.date(value):type==="timestamptz"?wire.timestamp(value):value;
        return `WHEN ${wire.ident(s.name)}.${wire.ident(filter.toLowerCase())} = ${typeof native==="number"?String(native):wire.cast(literal(String(native)),type??"")} THEN ${literal(value)}`;
      }).join(" ")+" ELSE NULL END";}catch{throw Object.assign(Error(`Statistics filter option must be a valid ${type??"string"}${postgres&&temporal?" with a nonzero PostgreSQL year":""}.`),{path:`schemas/${s.name}/admin/statistics/${filter}/${option}`});}
    }
    const modes=await Promise.all([false,true].map(async trusted=>{
      const [compiled]=compileProgram(base,ctx("view",trusted,{}));if(!compiled)throw Error("Missing compiled collection View.");
      // Keep the compiler's verified policy, but share the physical SELECT template at requests.
      const baseInner=compiled.ast.SelectStmt.fromClause[0].RangeSubselect.subquery.SelectStmt,policy=baseInner.whereClause;
      compiled.ast.SelectStmt.fromClause=[baseInner.fromClause[0]];
      // The native merge is a scalar-id lookup, never a fanning join. Core owns both sides' visibility.
      if(parent){
        const own=new Set(Object.keys(s.fields).flatMap(f=>s.fields[f]==="geo"?[f+"_lat",f+"_lng"]:[f]));
        const inherited=fields(parent).filter(f=>!own.has(f)),on=s.translates!.on.toLowerCase(),alias="_mantle_merge";
        const [pc]=compileProgram(await parse(`SELECT id FROM ${wire.ident(parent.name)} ORDER BY created_at DESC,id DESC LIMIT 1`),ctx("view",trusted,{}));
        if(!pc)throw Error("Missing compiled parent View.");
        const renumber=(n:SqlNode)=>{if(n.ParamRef)n.ParamRef.number+=compiled.binds.length;for(const v of Object.values(n))if(v&&typeof v==="object")Array.isArray(v)?v.forEach(renumber):renumber(v);};renumber(pc.ast);
        const inner=pc.ast.SelectStmt.fromClause[0].RangeSubselect.subquery.SelectStmt;
        pc.ast.SelectStmt.fromClause=inner.fromClause;
        pc.ast.SelectStmt.whereClause=and(...(inner.whereClause?[inner.whereClause]:[]),op(ref(parent.name,on),ref(s.name,on)),...(parent.scope?[op(ref(parent.name,parent.scope),ref(s.name,s.scope!))]:[]));
        compiled.binds.push(...pc.binds);
        const relation={RangeVar:{relname:parent.name,alias:{aliasname:alias},mantle:"system",inh:true,relpersistence:"p"}};
        compiled.ast.SelectStmt.fromClause=[{JoinExpr:{jointype:"JOIN_LEFT",larg:compiled.ast.SelectStmt.fromClause[0],rarg:relation,quals:op(ref(alias,"id"),{SubLink:{subLinkType:"EXPR_SUBLINK",subselect:pc.ast}})}}];
        compiled.ast.SelectStmt.targetList.push(...inherited.map(f=>({ResTarget:{name:f,val:ref(alias,f)}})));
      }
      const names=compiled.ast.SelectStmt.targetList.map((t:SqlNode)=>t.ResTarget.name??t.ResTarget.val.ColumnRef.fields.at(-1).String.sval);
      const projection=print(project({SelectStmt:{targetList:compiled.ast.SelectStmt.targetList,op:"SETOP_NONE",limitOption:"LIMIT_OPTION_DEFAULT"}},names,[])).replace(/^SELECT /,"");
      const from=print({SelectStmt:{...compiled.ast.SelectStmt,targetList:[{ResTarget:{val:{A_Const:{ival:{ival:1}}}}}]}}).replace(/^SELECT 1/,"");
      // Core compiles all writable fields once; request-time work selects only generated fragments.
      const inputs={...Object.fromEntries(writable.map(f=>[f,s.fields[f]!])),id:"text"};
      const returning=columns.map(wire.ident).join(",");
      const insertAst=writable.length?(await parse(`INSERT INTO ${wire.ident(s.name)} (${writable.map(wire.ident).join(",")}) VALUES (${writable.map(f=>`input.${wire.ident(f)}`).join(",")}) RETURNING ${returning}`))[0]!:{InsertStmt:{relation:{RangeVar:{relname:s.name,mantle:"table",inh:true,relpersistence:"p"}}.RangeVar,cols:[],selectStmt:{SelectStmt:{valuesLists:[{List:{items:[]}}]}},returningClause:{exprs:columns.map(f=>({ResTarget:{val:ref(f)}}))}}};
      const updateFields = writable.filter(field => !protectedColumns(s).includes(field));
      const updateAst=(await parse(`UPDATE ${wire.ident(s.name)} SET ${updateFields.length?updateFields.map(f=>`${wire.ident(f)}=input.${wire.ident(f)}`).join(","):"id=input.id"} WHERE id=input.id RETURNING ${returning}`))[0]!;
      if(!updateFields.length)updateAst.UpdateStmt.targetList=[];
      const deleteAst=(await parse(`DELETE FROM ${wire.ident(s.name)} WHERE id=input.id RETURNING id`))[0]!;
      const write=(ast:SqlNode)=>{const [c]=compileProgram([ast],{...ctx("procedure",trusted || !!(s.userScopes?.length && ast.InsertStmt),inputs),lockVersion:true});if(!c||c.kind!=="row")throw Error("Admin writes must affect exactly one row.");
        const fixed=c.binds.filter(b=>!(b.k==="input"&&writable.includes(String(b.name)))),rewritten=wireReturning(c.ast,plan.schemas,wire,true);
        const rewrite=(n:SqlNode)=>{if(n.ParamRef){const b=c.binds[n.ParamRef.number-1]!;if(b.k==="input"&&writable.includes(String(b.name))){delete n.ParamRef;n.Raw={parts:[wire.cast(markerText,String(b.type))]};return;}n.ParamRef.number=fixed.indexOf(b)+1;}for(const v of Object.values(n))if(v&&typeof v==="object")Array.isArray(v)?v.forEach(rewrite):rewrite(v);};rewrite(rewritten);return {ast:rewritten,binds:recipesOf({binds:fixed},["id"],message=>{throw Error(message);})};};
      const create=write(insertAst),patch=write(updateAst),remove=write(deleteAst),entryFields:Record<string,unknown>=Object.create(null);
      const insert=create.ast.InsertStmt,update=patch.ast.UpdateStmt;
      for(const [i,field]of writable.entries())entryFields[field]={column:wire.ident(field),insert:expr(insert.selectStmt.SelectStmt.fromClause[0].RangeSubselect.subquery.SelectStmt.valuesLists[0].List.items[i]),...(!protectedColumns(s).includes(field)&&!serverOwned(s.schema,field) ? {update:wire.ident(field)+" = "+expr(update.targetList[updateFields.indexOf(field)].ResTarget.val)} : {})};
      const returnSQL=(ast:SqlNode)=>" RETURNING "+ast.returningClause.exprs.map((t:SqlNode)=>expr(t.ResTarget.val)+(t.ResTarget.name?" AS "+wire.ident(t.ResTarget.name):"")).join(",");
      return {projection,from,policy:policy?expr(policy):"",binds:recipesOf(compiled,[],message=>{throw Error(message);}),fields:entryFields,create:{prefix:print(create.ast).slice(0,print(create.ast).indexOf(" ("))+" (",between:") VALUES (",suffix:")",binds:create.binds,columns:insert.cols.slice(writable.length).map((t:SqlNode)=>wire.ident(t.ResTarget.name)),values:insert.selectStmt.SelectStmt.targetList.slice(writable.length?1:0).map((t:SqlNode)=>expr(t.ResTarget.val)),returning:returnSQL(insert)},patch:{prefix:print(patch.ast).slice(0,print(patch.ast).indexOf(" SET "))+" SET ",binds:patch.binds,sets:update.targetList.slice(updateFields.length).map((t:SqlNode)=>wire.ident(t.ResTarget.name)+" = "+expr(t.ResTarget.val)),where:" WHERE "+expr(update.whereClause),returning:returnSQL(update)},remove:{sql:print(remove.ast),binds:remove.binds,row:true}};
    }));
    result[s.name]={...(s.userScopes?.length ? {userScopes:s.userScopes} : {}),cursorAliases,scoped:!!s.scope,path:"schemas/"+s.name+"/admin",marker:markerText,id:wire.ident(s.name)+"."+wire.ident("id"),fields:fieldFacts,orderFields:Object.keys(ordered),search:`(${wire.ident(s.name)}.${wire.ident("id")} = ${markerText}${s.search?.length?` OR ${wire.search(s.name,s.search,wire.ident(s.name),markerText)}`:""})`,statistics:{rowsAlias,column:wire.ident(s.name)+"."+wire.ident("created_at"),time:postgres?`extract(epoch FROM ${wire.ident(s.name)}.${wire.ident("created_at")}) * 1000000`:wire.ident(s.name)+"."+wire.ident("created_at"),subtype},caller:modes[0],trusted:modes[1]};
  }catch(error){refusals.push({code:"GENERATE_UNSUPPORTED",path:error instanceof Error&&"path"in error&&typeof error.path==="string"?error.path:"schemas/"+s.name+"/admin",message:error instanceof Error?error.message:String(error)});}
  return result;
}
