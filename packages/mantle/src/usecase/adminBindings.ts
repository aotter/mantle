import { userReferences } from "../domain/userReferences.js";
/** Selected application bindings: compiled checks/native SQL; only the app depends on Admin adapters. */
import {isPrimaryCollection} from "../build/compiler.js";
import { enumOptions, type JsonSchema } from "../build/compiler.js";
import type { GenerateInput } from "../domain/model.js";
import { databaseImport, isSqlite, literal as q } from "../domain/entry.js";
import { conversions, authLines } from "../domain/input.js";
import { recipesOf } from "../domain/recipes.js";
import { boundaryType, conversion, serverOwned } from "../domain/columns.js";
import { adminOrder } from "../domain/adminOrder.js";
import { emitValidation } from "./validation.js";

type Schema = GenerateInput["plan"]["schemas"][string];
const scalar = (type: string | undefined) => ["text","integer","int4","int8","real","float8","bool","date","timestamptz"].includes(type ?? "");
const wire = (fields: readonly (readonly [string,string|undefined])[], sqlite: boolean): string => {
  const columns=fields.flatMap(([name,type])=>conversion(name,type,sqlite));
  const geo=fields.filter(([,type])=>type==="geo").map(([field])=>`row[${q(field)}]=row[${q(field+"_lat")}] == null || row[${q(field+"_lng")}] == null ? null : {lat:row[${q(field+"_lat")}],lng:row[${q(field+"_lng")}]};delete row[${q(field+"_lat")}];delete row[${q(field+"_lng")}];`);
  return `(raw:Row):Row=>{const row=${columns.length?`wireRows([raw],${q(columns)})[0]!`:geo.length?"{...raw}":"raw"};${geo.join("")}return row;}`;
};
/** Core's titled string choices are enum checks; constrained or general oneOf remains refused. */
function adminProperty(property:JsonSchema):JsonSchema {
  const choices=enumOptions(property);
  if(!property.oneOf||property.enum||!choices||!property.oneOf.every(branch=>Object.entries(branch).every(([key,value])=>key==="const"||key==="title"||key==="type"&&value==="string"))||new Set(choices.map(c=>c.value)).size!==choices.length)return property;
  const {oneOf,...base}=property;
  return {...base,enum:choices.map(c=>c.value)};
}
function checks(s: Schema, full: boolean): JsonSchema {
  const properties = Object.fromEntries(Object.entries(s.schema.properties ?? {}).filter(([name]) => name.toLowerCase() !== s.scope&&s.fields[name.toLowerCase()]!=="geo").map(([name,property])=>[name,adminProperty(property)]));
  return {...s.schema,properties,required:full ? (s.schema.required ?? []).filter(name=>Object.hasOwn(properties,name) && !(s.userScopes ?? []).some(u => u.column === name.toLowerCase())) : [],additionalProperties:false};
}
const allowed = (requires: Parameters<typeof authLines>[0], path: string) => {
  const lines = authLines(requires,path);
  return lines.length ? `(caller:Caller)=>{try{${lines.join("")}return true;}catch{return false;}}` : "(_caller:Caller)=>true";
};

/**
 * Share repeated compiler data: a SQL string or a subtree (equal caller and trusted modes, refs, page specs) printed over 80
 * characters more than once is printed once, longest first, as a module constant; the runtime only reads these specs.
 * Generated modules evaluate no decoder or kernel at import.
 */
function sqlConstants(values:readonly unknown[]):{code:string[];constants:string[]} {
  const counts=new Map<string,number>(), seen=new Map<string,unknown>(), pool=new Map<string,string>(), constants:string[]=[];
  let named=0;
  const key=(v:unknown)=>typeof v==="string"?v.length>80?q(v):undefined:v&&typeof v==="object"?(text=>text.length>80?text:undefined)(q(v)):undefined;
  const children=(v:unknown)=>v&&typeof v==="object"?Object.values(v):[];
  const tally=(v:unknown,by=1):void=>{const k=key(v);if(k){counts.set(k,(counts.get(k)??0)+by);seen.set(k,v);}children(v).forEach(child=>tally(child,by));};
  values.forEach(value=>children(value).forEach(child=>tally(child)));
  // once a subtree is printed once, what it contains occurs (copies - 1) times fewer
  for(const [k,v] of [...seen].sort(([a],[b])=>b.length-a.length)){const copies=counts.get(k)!;if(copies>1){pool.set(k,"");children(v).forEach(child=>tally(child,1-copies));}}
  const print=(v:unknown):string=>Array.isArray(v)?"["+v.map(reference).join(",")+"]":v&&typeof v==="object"?"{"+Object.entries(v).map(([name,child])=>`${name==="__proto__"?`[${q(name)}]`:q(name)}:${reference(child)}`).join(",")+"}":q(v);
  const reference=(v:unknown):string=>{const k=key(v);if(!k||pool.get(k)===undefined)return print(v);if(pool.get(k)===""){const name=`sql${named++}`;pool.set(k,name);constants.push(`const ${name}=${print(v)}${typeof v==="string"?"":" as const"};`);}return pool.get(k)!;};
  return {code:values.map(print),constants};
}

export function emitAdminBindings(input: GenerateInput, refuse: (path:string,message:string)=>void): Record<string,string> {
  if (!input.admin) return {};
  const {plan,lowered,target}=input, sqlite=isSqlite(target), refs=Object.values(plan.procedures).some(p=>"ref" in p.handler), files:Record<string,string>={};
  const user = userReferences(plan, sqlite);
  const imports=[...(user.used ? [user.code,'import {userBinds} from "@aotter/mantle/user-fields";'] : []), databaseImport(target),'import {wireRows,type Caller,type Row} from "@aotter/mantle/contracts";','import {deny,isAdmin,isUser} from "@aotter/mantle/contracts";','import {invalid} from "@aotter/mantle/surface";','import type {Handlers} from "./generated.js";','import {bootstrap,allCollections} from "./admin-descriptors.js";','import type {View,Operation} from "@aotter/mantle-admin/server";','import type {EntrySchema} from "@aotter/mantle-admin/server/entries";'];
  imports.push('import {nativePage,nativeStatistics,nativeText} from "@aotter/mantle-admin/server/native";',`import * as D from "@aotter/mantle/dialect/${sqlite?"sqlite":"postgres"}";`,`import {read,procedure} from "@aotter/mantle/driver/${target==="bun-sqlite"?"bun-sqlite":target==="cloudflare-d1"?"d1":"postgres"}";`,`const adapter={read,procedure,values:${sqlite ? (user.used ? "{...D,...USER_VALUES}" : "D") :`{...D,${user.used ? "...USER_VALUES," : ""}timestamp:(v:Parameters<typeof D.timestamp>[0])=>{if(typeof v==="string"&&/^0000-/.test(v.trim()))invalid("PostgreSQL timestamps require a nonzero year.","admin/input");return D.timestamp(v);},date:(v:string)=>{if(/^0000-/.test(v.trim()))invalid("PostgreSQL dates require a nonzero year.","admin/input");return D.date(v);}}`},param:D.param,escapeLike:D.escapeLike,sqlite:${sqlite}} as const;`);
  const schemas:string[]=[], views:string[]=[], adminViews:string[]=[], operations:string[]=[], pageSpecs:unknown[]=[];
  for (const [n,s] of Object.values(plan.schemas).entries()) {
    const schemaPath=`schemas/${s.name}/admin`, declared=Object.keys(s.fields).filter(f=>f!==s.scope), writable=declared.filter(f=>scalar(s.fields[f])||s.fields[f]==="json");
    // readOnly properties are server-maintained: values() pins them to their default, and they have no Admin UPDATE.
    const server=Object.fromEntries(writable.filter(f=>serverOwned(s.schema,f)).map(f=>[f,(Object.entries(s.schema.properties??{}).find(([k])=>k.toLowerCase()===f)?.[1] as {default?:unknown}|undefined)?.default??null]));
    // Experimental geo collections remain readable; edits require a declared Procedure.
    const validators=emitValidation({views:{},procedures:{full:{input:checks(s,true)},partial:{input:checks(s,false)}}},(path,message)=>refuse(schemaPath+"/"+path,message));
    for(const mode of ["full","partial"]){const name=`validation/admin/${encodeURIComponent(s.name)}-${mode}.ts`;files[name]=validators[`validation/procedures/${mode}.ts`]!.replaceAll(`procedures/${mode}/input`,schemaPath+"/input");imports.push(`import {validate as ${mode}${n}} from "./${name.replace(/\.ts$/,".js")}";`);}
    const names=Object.fromEntries(writable.map(f=>[s.names[f]??f,f])), allNames={...names,id:"id",version:"version",createdAt:"created_at",updatedAt:"updated_at",authorId:"author_id",...(s.publishing?{status:"status",publishedAt:"published_at"}:{})};
    const temporal=writable.filter(f=>["date","timestamptz"].includes(s.fields[f]!)).map(f=>s.names[f]??f);
    const yearZero=sqlite?"":`for(const key of ${q(temporal)})if(typeof data[key]==="string"&&/^0000-/.test(data[key].trim()))invalid("PostgreSQL dates require a nonzero year.",${q(schemaPath)});`;
    const coercers=Object.entries(allNames).filter(([,f])=>scalar(s.fields[f]??(f==="version"?"integer":"text"))).map(([name,f])=>{
      const type=s.fields[f]??(f==="version"?"integer":"text");
      const value=type==="bool"?`raw === "true" ? true : raw === "false" ? false : fail("Expected true or false.")`:["integer","int4","int8","real","float8"].includes(type)?`number(raw,${["integer","int4","int8"].includes(type)})`:`raw`;
      return `case ${q(name)}:return {column:${q(f)},value:${value}};`;
    });
    const order=adminOrder(s), orderNames=Object.fromEntries(Object.keys(order).map(f=>[f==="updated_at"?"updatedAt":s.names[f]??f,f]));
    const parent=s.translates&&plan.schemas[s.translates.parent.toLowerCase()];
    const inherited=parent?Object.keys(parent.fields).filter(f=>f!==parent.scope&&!Object.hasOwn(s.fields,f)):[];
    const rowNames={...(parent?parent.names:{}),...s.names};
    const rowFields=[...declared.map(f=>[f,s.fields[f]] as const),...inherited.map(f=>[f,parent&&parent.fields[f]] as const),...["version"].map(f=>[f,"integer"] as const)];
    const named=`(raw:Row):Row=>{const row=row${n}(raw);return Object.fromEntries(Object.entries(row).map(([key,value])=>[Object.hasOwn(fieldNames${n},key)?fieldNames${n}[key as keyof typeof fieldNames${n}]:key,value]));}`;
    const entrySpec=`entrySpecs[${q(s.name)}]`;
    if(!input.adminEntries?.[s.name]){refuse(schemaPath,"Missing compiler-authorized entry queries and Procedures.");continue;}
    const defaults=Object.fromEntries(Object.entries(checks(s,true).properties??{}).flatMap(([key,p])=>p.default!==undefined?[[key,p.default]]:[]));
    const primary=isPrimaryCollection(s,Object.values(plan.schemas));
    const schemaCode=`{
      name:${q(s.name)},primary:${primary},descriptor:allCollections[${q(s.name)}],publishing:${!!s.publishing},${s.liveEdits?"liveEdits:true,":""}readOnly:${s.schema.readOnly===true||declared.some(f=>s.fields[f]==="geo")},fields:names${n},defaults:${q(defaults)},
      binding:${entrySpec},
      query:query${n},validate:(data,full)=>{const checked=Object.fromEntries(Object.entries(data).filter(([key,v])=>v!==null||${s.publishing?"full&&":""}${q(s.schema.required??[])}.includes(key)));(full?full${n}:partial${n})(checked);${sqlite?"":"nativeText(data);"}${yearZero}return data;},
      values:values${n},row:${named},
      ${sqlite?"":"native:nativeText,"}
      ${s.publishing?`transition:async(db,caller,verb,id,expectedVersion)=>{const run=await ({publish:()=>import("./procedures/${encodeURIComponent(s.name+".publish")}.js"),unpublish:()=>import("./procedures/${encodeURIComponent(s.name+".unpublish")}.js"),archive:()=>import("./procedures/${encodeURIComponent(s.name+".archive")}.js")})[verb]();const version=wireRows([{version:expectedVersion}],[["version","int"]])[0]!.version;return run.default(db,caller,{id,expectedVersion:version} as Parameters<typeof run.default>[2]);},`:""}
    }`;
    schemas.push(schemaCode);
    files[`admin/entries-${encodeURIComponent(s.name)}.ts`]=`import {invalid} from "@aotter/mantle/surface";\nimport {wireRows,type Row} from "@aotter/mantle/contracts";\nimport type {EntryPageQuery} from "@aotter/mantle-admin/server/entries";\nimport {entriesQuery,scalarNumber,nativeText} from "@aotter/mantle-admin/server/native";\nconst fail=(message:string):never=>invalid(message,${q(schemaPath)});\nconst number=(raw:string,integer:boolean)=>scalarNumber(raw,integer,${q(schemaPath)});\nimport * as D from "@aotter/mantle/dialect/${sqlite?"sqlite":"postgres"}";\nexport const names=${q(names)} as const;\nfunction encode(column:string,value:unknown):unknown{if(value==null)return value;switch(column){${[...writable,...["created_at","updated_at",...(s.publishing?["published_at"]:[])]].map(f=>{const type=s.fields[f]??"timestamptz";return type==="date"||type==="timestamptz"?`case ${q(f)}:return D.${type==="date"?"date":"timestamp"}(value as string);`:type==="json"?`case ${q(f)}:return JSON.stringify(value);`:sqlite&&type==="bool"?`case ${q(f)}:return Number(value);`:"";}).join("")}default:return value;}}\nconst server:Row=${q(server)};\n// Server-maintained (readOnly) fields: create stores their default, an edit drops them (the console echoes whole records).\nexport const values=(data:Row,patch=false):Row=>Object.fromEntries(Object.entries(data).flatMap(([key,value])=>{const column=names[key as keyof typeof names];return Object.hasOwn(server,column)?patch?[]:[[column,encode(column,server[column])]]:[[column,encode(column,value)]];}));\nexport const row=${wire(rowFields,sqlite)};\nfunction coerce(name:string,raw:string):{column:string;value:string|number|boolean}{${sqlite?"":"nativeText(raw);"+(temporal.length?"if("+q(temporal)+".includes(name)&&/^0000-/.test(raw.trim()))fail(\"PostgreSQL dates require a nonzero year.\");":"")}switch(name){${coercers.join("")}default:return fail("Unknown scalar filter field.");}}\nimport {validate as checkFilter} from "../validation/admin/${encodeURIComponent(s.name)}-partial.js";\nfunction field(name:string,raw:string){const f=coerce(name,raw);if(Object.hasOwn(names,name))checkFilter({[name]:f.value});return {...f,value:encode(f.column,f.value) as string|number|boolean};}\nexport const query=(params:URLSearchParams):EntryPageQuery|null=>entriesQuery(params,{path:${q(schemaPath)},orderFields:${q(orderNames)},publishing:${!!s.publishing},sqlite:${sqlite},field});\n`;
    imports.push(`const fieldNames${n}=${q(rowNames)} as const;`);
    imports.push(`import {names as names${n},row as row${n},query as query${n},values as values${n}} from "./admin/entries-${encodeURIComponent(s.name)}.js";`);
  }
  for (const [name,v] of Object.entries(plan.views).filter(([,v])=>v.surface!=="internal")){
    const n=views.length,encoded=encodeURIComponent(name),converted=conversions(v.input?.properties,(lowered.views[name]?.public??lowered.views[name]?.caller)?.binds??[],target);
    imports.push(`import {query as queryView${n}} from "./validation/views/${encoded}.js";`);
    const rename=Object.fromEntries(Object.entries(v.columns??{}).map(([key,col])=>[key,key===col.field?plan.schemas[col.schema]!.names[col.field]??key:key]));
    imports.push(`const viewNames${n}=${q(rename)} as const;`);
    const pageData=input.adminPages?.[name];
    // A supplied page map omits only Views its producer already refused (at `views/<name>` or `views/<name>/admin`).
    if(!pageData){if(!input.adminPages)refuse(`views/${name}/admin`,"Admin list was not generated: no compiler-authorized matching pages were supplied for this View.");continue;}
    const kinds=(v.uiSchema?.list??{})as {filterFields?:string[];searchFields?:string[]};
    const filters=Object.fromEntries((kinds.filterFields??[]).map(field=>{
      const lineage=v.columns?.[field]??v.columns?.[field.toLowerCase()],schema=lineage&&plan.schemas[lineage.schema];
      return [field,adminProperty(schema?.schema.properties?.[schema.names[lineage!.field]??lineage!.field]??{type:"string"})];
    }));
    const filterChecks=emitValidation({procedures:{filters:{input:{type:"object",properties:filters,additionalProperties:false}}},views:{}},(path,msg)=>refuse(`views/${name}/admin/`+path,msg));
    files[`validation/admin/view-${encoded}.ts`]=filterChecks["validation/procedures/filters.ts"]!;
    imports.push(`import {validate as filters${n}} from "./validation/admin/view-${encoded}.js";`);
    const filterTransforms=Object.keys(filters).flatMap(field=>{const col=v.columns?.[field]??v.columns?.[field.toLowerCase()],type=col&&plan.schemas[col.schema]?.fields[col.field];const convert=type==="date"&&sqlite?"encodeDate":type==="timestamptz"&&sqlite?"encodeTimestamptz":type==="bool"&&sqlite?"Number":undefined;return convert?[`if(Object.hasOwn(filters,${q(field)}))filters[${q(field)}]=${convert}(filters[${q(field)}] as ${type==="bool"?"boolean":"string"});`]:[];});
    if(filterTransforms.some(t=>t.includes("encode")))imports.push('import {encodeDate,encodeTimestamptz} from "@aotter/mantle/scalars";');
    const filterReads=Object.entries(filters).map(([field,s])=>{const type=[s.type].flat().find(t=>t&&t!=="null");return `if(params.has(${q("filter."+field)})&&params.get(${q("filter."+field)})!=="")filters[${q(field)}]=${type==="boolean"?`params.get(${q("filter."+field)})==="true"?true:params.get(${q("filter."+field)})==="false"?false:invalid("Expected true or false.",${q("views/"+name)})`:["number","integer"].includes(type??"")?`Number(params.get(${q("filter."+field)}))`:`params.get(${q("filter."+field)})!`};`;});
    const cursorKinds=(input.paging?.[name]?.types??[]).map(type=>type==="bool"?"bool":type==="integer"||type==="int8"?"int":type==="int4"?"int4":type.startsWith("numeric(")?"numeric":type==="real"||type==="float8"?"float":type==="date"?"date":type==="timestamptz"?"timestamp":"text");
    const modes=Object.fromEntries(Object.entries({caller:pageData.caller,trusted:pageData.trusted}).map(([mode,p])=>[mode,{...p,binds:recipesOf(p, Object.keys(v.input?.properties??{}),message=>refuse(`views/${name}/admin`,message))}]));
    pageSpecs.push({path:"views/"+name,cap:v.stmts[0]?.SelectStmt.limitCount?.A_Const?.ival?.ival??500,cursorKinds,...modes});
    imports.push(`const allowsView${n}=${allowed(v.requires,`views/${name}`)};`);
    if(v.surface==="admin")adminViews.push(`view${n}`);
    views.push(`{${user.used ? `check:(caller)=>{${authLines(undefined, `views/${name}`, pageData.caller.binds, sqlite).join("")}},` : ""}name:${q(name)},allows:allowsView${n},query:(params)=>{const result=queryView${n}(params),filters:Record<string,unknown>=Object.create(null);${filterReads.join("")}filters${n}(filters);${filterTransforms.join("")}${sqlite?"":"nativeText(result.input);nativeText(filters);"}${kinds.searchFields?.length?`const search=params.get("search")?.trim();`:""}return {...result,match:{filters${kinds.searchFields?.length?",...(search?{search}:{})":""}}};},page:(db,caller,input,paging)=>{deny(caller,allowsView${n}(caller),${q("views/"+name)});return nativePage(viewPage${n},adapter,db,caller,input,paging);},${converted?`convert:${converted},`:""}row:(raw)=>{const row=(${wire((input.viewKeys[name]??[]).map(key=>[key,boundaryType(plan,name,key)] as const),sqlite)})(raw);return Object.fromEntries(Object.entries(row).map(([key,value])=>[Object.hasOwn(viewNames${n},key)?viewNames${n}[key as keyof typeof viewNames${n}]:key,value]));}}`);
  }
  for(const [name,p]of Object.entries(plan.procedures).filter(([name])=>Object.values(plan.triggers).some(t=>t.procedure===name&&t.source.kind==="mcp"&&t.source.surface==="admin"))){
    const n=operations.length,ref="ref"in p.handler,encoded=encodeURIComponent(name),converted=conversions(p.input?.properties,lowered.procedures[name]?.caller?.flatMap(s=>s.binds)??[],target);
    imports.push(`import {validate as operation${n}} from "./validation/procedures/${encoded}.js";`);
    operations.push(`{${input.description.targets.find(t => t._meta.id === `procedure:${name}`)?._meta.readOnly ? "readOnly:true," : ""}${user.used || p.trustedOnly ? `check:(caller)=>{${authLines(undefined, `procedures/${name}`, lowered.procedures[name]?.caller?.flatMap(s=>s.binds), sqlite, p.trustedOnly).join("")}},` : ""}name:${q(name)},allows:${allowed(p.requires,`procedures/${name}`)},validate:operation${n},${converted?`convert:${converted},`:""}run:${ref?`async(db,caller,input)=>(await import("./generated.js")).store(db,caller,{handlers:options.handlers}).procedures[${q(name)}](input)`:`async(db,caller,input)=>(await import("./procedures/${encoded}.js")).default(db,caller,input)`}}`);
  }
  const {code:[entrySpecs,...pages],constants}=sqlConstants([input.adminEntries,...pageSpecs]);
  imports.push(...views.map((view,n)=>`const view${n}=${view} satisfies View<Database>;`),...constants,...pages.map((page,n)=>`const viewPage${n}=${page} as const;`),`const entrySpecs=${entrySpecs} as const;`);
  imports.push(`export const statisticsView=(db:Database,caller:Caller,collection:keyof typeof entrySpecs,args:{from:number;to:number;bucketMs:number})=>nativeStatistics(entrySpecs,adapter,db,caller,collection,args);`);
  const metadataGuards = [...Object.entries(plan.views).map(([name,v]) => `case ${q("view:"+name)}: return (${allowed(v.requires,`views/${name}`)})(caller);`), ...Object.entries(plan.procedures).map(([name,p]) => `case ${q("procedure:"+name)}: return (${allowed(p.requires,`procedures/${name}`)})(caller);`), ...Object.values(plan.schemas).filter(s=>s.publishing).flatMap(s=>["publish","unpublish","archive"].map(verb=>`case ${q("procedure:"+s.name+"."+verb)}: return isAdmin(caller);`))];
  files["admin-bindings.ts"]=`${imports.filter(Boolean).join("\n")}\nexport function adminBindings${refs?"<const H extends Handlers>(options:{handlers:H & Record<Exclude<keyof H,keyof Handlers>,never>})":"(_options?:{handlers?:Handlers})"}{\nreturn {metadata:{...bootstrap,accessTargets:()=>import("./access-targets.js").then(m=>m.targets),${plan.access ? `userFields:${q(plan.access.userFields)} as const,` : ""}allows:(target:import("@aotter/mantle/contracts").Target,caller:Caller)=>{switch(target.kind+":"+target.name){${metadataGuards.join("")}default:return target.kind==="schema";}}},adapter,schemas:[${schemas.join(",\n")}] satisfies readonly EntrySchema<Database>[],views:[${adminViews.join(",")}],developerViews:[${views.map((_,n)=>`view${n}`).join(",")}],operations:[${operations.join(",\n")}] satisfies readonly Operation<Database,${refs?"Handlers":"never"}>[]};\n}\n`;
  return files;
}
