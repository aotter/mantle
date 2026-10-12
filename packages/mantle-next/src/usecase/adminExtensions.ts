/** Full extension declarations are checked at generation; settings checks become straight-line code. */
import { DiagnosticError, type JsonSchema } from "@aotter/mantle/spec";
import { validateAdminExtensions, adminExtensionsFor, type AdminExtension } from "@aotter/mantle/admin";
import type { GenerateInput, GenerateDiagnostic } from "../domain/model.js";
const q=JSON.stringify;
function form(schema:JsonSchema):string {
  const properties=Object.entries(schema.properties??{}),lines:string[]=[];
  for(const [name,p] of properties){
    const value="object["+q(name)+"]",type=String(p.type),label=type==="integer"?"an integer":"a "+type;
    const test=type==="integer"?`Number.isInteger(${value})`:type==="number"?`typeof ${value} === "number" && Number.isFinite(${value})`:`typeof ${value} === ${q(type)}`;
    const problems=[`!(${test}) ? ${q("expected "+label)}`];
    if(p.enum)problems.push(`!${q(p.enum)}.includes(${value} as never) ? "expected one of the listed values"`);
    const choices=p.oneOf as readonly{const:unknown}[]|undefined;
    if(choices)problems.push(`!${q(choices.map(c=>c.const))}.includes(${value} as never) ? "expected one of the listed values"`);
    for(const [bound,operator] of [["minimum","<"],["maximum",">"],["minLength","<"],["maxLength",">"]] as const)if(p[bound]!==undefined){const length=bound.endsWith("Length");if(length?type!=="string":type!=="number"&&type!=="integer")continue;const measure=length?`[...(${value} as string)].length`:`(${value} as number)`,message="expected "+(operator==="<"?"at least ":"at most ")+p[bound]+(length?" characters":"");problems.push(`${measure} ${operator} ${p[bound]} ? ${q(message)}`);}
    lines.push(`if (Object.hasOwn(object,${q(name)}) && ${value} !== undefined && !Object.hasOwn(errors,${q(name)})) { const problem = ${problems.join(" : ")} : null; if (problem) errors[${q(name)}] = problem; }`);
  }
  return `if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {"":"an object"};\nconst object=raw as Record<string,unknown>,errors:Record<string,string>=Object.create(null);\nfor(const key of Object.keys(object))if(!${q(properties.map(([name])=>name))}.includes(key))errors[key]="no such field";\n${(schema.required??[]).map(name=>`if(!Object.hasOwn(object,${q(name)})||object[${q(name)}]===undefined)errors[${q(name)}]="required";`).join("\n")}\n${lines.join("\n")}\nreturn errors;`;
}
export function emitAdminExtensions(input:Pick<GenerateInput,"adminExtensions">,diagnostics:GenerateDiagnostic[]):Record<string,string> {
  const definitions=input.adminExtensions??[];
  // Existing programmatic binding-only metadata remains supported; a server surface needs full declarations.
  if(!definitions.length||definitions.every(e=>!("apiVersion" in e)))return{};
  try{
    validateAdminExtensions(definitions as readonly AdminExtension[]);
    for(const e of definitions)for(const items of Object.values(e.contributes))for(const c of items??[])if(c.role!==undefined&&c.role!=="staff")throw new Error(`Extension '${e.id}/${c.id}' needs role 'staff'; OSS has one staff role.`);
  }catch(error){if(error instanceof DiagnosticError){const{code,path,message}=error.diagnostic;diagnostics.push({code,path,message});}else diagnostics.push({code:"GENERATE_UNSUPPORTED",path:"admin-extensions",message:error instanceof Error?error.message:"Invalid Admin extensions."});return{};}
  const checks:string[]=[],names:string[]=[],metadata=(definitions as readonly AdminExtension[]).map(e=>{
    const {handlers:_handlers,source,...declaration}=e,contributes={...e.contributes,fields:(e.contributes.fields??[]).map(f=>({...f,role:f.role??"staff"}))},publicExtension=adminExtensionsFor([{...e,contributes}],"staff")[0]!;
    for(const s of e.contributes.settings??[]){const id=checks.length;checks.push(`function check${id}(raw:unknown):Readonly<Record<string,string>>{\n${form(s.schema)}\n}`);names.push(`[${q(e.id+"/"+s.id)}]:check${id}`);}
    return{id:e.id,declaration:q(declaration),public:publicExtension,module:e.module,integrity:e.integrity,source:source!==undefined,settings:(e.contributes.settings??[]).map(s=>s.id),actions:(e.contributes.actions??[]).filter(a=>a.presentation!=="dialog").map(a=>({id:a.id,target:a.target,schema:a.when?.schema}))};
  });
  return{"admin-extensions.ts":`import { extensionOptions, type AdminExtension } from "@aotter/mantle-next/admin/extensions";\nimport type { Options } from "@aotter/mantle-next/admin";\n${checks.join("\n")}\nconst metadata=${q(metadata).replace(/"__proto__":/g,'["__proto__"]:')} as const;\nexport function adminExtensions<Env,Database>(definitions:readonly AdminExtension<Env,Database>[],options:Pick<Options<Env,Database>,"caller"|"assets">){return extensionOptions(metadata,{${names.join(",")}},definitions,options);}\n`};
}
