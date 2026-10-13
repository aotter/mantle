import {mkdir,writeFile} from "node:fs/promises";
import {dirname,join,resolve} from "node:path";
/** During isolated author work, select the generation dependency without changing any production import. */
const sdk=process.env.MANTLE_ADMIN_GENERATOR_ROOT??resolve(import.meta.dir,"../../../mantle");
export async function generateAdmin(target:"bun-sqlite"|"cloudflare-d1"|"bun-postgres"|"cloudflare-postgres",text:string){
 const {generateFromSources}=await import(join(sdk,"src/infrastructure/generate.ts"));
 const result=await generateFromSources({target,admin:true,sources:{sources:[{sourceId:"admin.yaml",text}]}});
 if(!result.ok)throw Error(JSON.stringify(result.diagnostics));
 return result.files as Readonly<Record<string,string>>;
}
export async function writeAdminFixture(directory:string,files:Readonly<Record<string,string>>){
 const helper=resolve(import.meta.dir,"../../src/server/native.ts");
 for(const [file,source]of Object.entries(files)){
  await mkdir(dirname(join(directory,file)),{recursive:true});
  const code=source.replaceAll("'@aotter/mantle-admin/server/extensions'",JSON.stringify(resolve(import.meta.dir,"../../src/server/extensions.ts"))).replaceAll('"@aotter/mantle-admin/server/native"',JSON.stringify(helper));
  await writeFile(join(directory,file),code);
 }
}
