import {test, expect} from "bun:test";
import {Database} from "bun:sqlite";
import {mkdtemp, rm} from "node:fs/promises";
import {join} from "node:path";
import {sdkFixtureCaller} from "../../../mantle/tests/apps/fixtures.js";
import {generateFromSources} from "../../../mantle/src/infrastructure/generate.js";
import {admin, type Options} from "../../src/server/index.js";
import {siteRoutes} from "../../src/server/site.js";
import {writeAdminFixture} from "./generated-fixture.js";
import type {MediaStorage} from "@aotter/mantle/site";

test("Admin media routes refuse another server's upload and asset ids distinctly, naming nothing of it; legacy ids still resolve (#1952)", async () => {
  const result = await generateFromSources({target:"bun-sqlite", sources:{sources:[{sourceId:"notes.yaml",text:`apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: {name: notes}
spec:
  title: Notes
  lifecycle: operational
  schema: {type: object, properties: {title: {type: string}}, required: [title]}
`}]}, site:{media:{purposes:[{name:"card",required:["png"],maxBytes:{"image/png":1000}}]}}});
  if(!result.ok) throw Error(JSON.stringify(result.diagnostics));
  const directory=await mkdtemp(join(import.meta.dir,".media-ownership-")), dbs=[new Database(":memory:"), new Database(":memory:")];
  try {
    await writeAdminFixture(directory,result.files);
    for (const db of dbs) db.exec(result.files["schema.sql"]!);
    const {site}=await import(join(directory,"site.ts"));
    const storage:MediaStorage={async createUpload(a){return {capabilities:a.variants.map(v=>({...v,method:"PUT" as const,storageKey:"uploads/"+a.uploadGroupId,uploadUrl:"https://upload.test/"+a.uploadGroupId}))};},
      async commitUpload(a){return {id:a.uploadGroupId,createdAt:a.now,variants:a.variants.map(v=>({...v,storageKey:"committed/"+a.uploadGroupId,publicUrl:"https://media.test/"+a.uploadGroupId,byteSize:5}))};},async deleteObject(){}};
    const caller=sdkFixtureCaller({kind:"user",subject:"a",role:"admin",admin:true,scopes:[],credential:"session",credentialId:null,clientId:null});
    const [a, b]=dbs.map(db=>{
      const options:Options<{},Database>={db:()=>db,caller:()=>caller,site,media:storage};
      const fetch=admin({collections:[],views:[],operations:[],webmcp:{tools:[],routes:{}}},[],[],{...options,routes:siteRoutes(options)});
      return async (method:string,path:string,body?:unknown)=>{
        const response=(await fetch(new Request("https://app.test/admin/api"+path,{method,headers:{origin:"https://app.test","content-type":"application/json"},...(body?{body:JSON.stringify(body)}:{})}),{}))!;
        return {status:response.status,text:await response.text()};
      };
    });
    const upload={filename:"card.png",purpose:"card",variants:[{mimeType:"image/png",byteSize:90,role:"primary"}]};
    const pending=JSON.parse((await a!("POST","/media/uploads",upload)).text).uploadGroupId as string;
    const committed=JSON.parse((await a!("POST","/media/uploads",upload)).text).uploadGroupId as string;
    expect((await a!("POST",`/media/uploads/${committed}/commit`,{})).status).toBe(200);
    const tag=committed.split("_")[0]!;
    const refused=async (call:Promise<{status:number;text:string}>,what:string)=>{
      const {status,text}=await call;
      expect(status).toBe(404);
      expect(JSON.parse(text).error).toMatchObject({code:"MEDIA_NOT_OWNED",message:`not ${what} of this server; use the server that created it`});
      expect(text).not.toContain(tag);
    };
    await refused(b!("POST",`/media/uploads/${pending}/commit`,{}),"an upload");
    await refused(b!("GET",`/media/${committed}`),"a media asset");
    await refused(b!("PATCH",`/media/${committed}`,{alt:"x"}),"a media asset");
    await refused(b!("DELETE",`/media/${committed}`),"a media asset");
    expect((await a!("GET",`/media/${committed}`)).status).toBe(200);

    const legacy=crypto.randomUUID();
    dbs[1]!.query("INSERT INTO media_assets (id, created_at, variants) VALUES (?, 1, '[]')").run(legacy);
    expect(JSON.parse((await b!("GET",`/media/${legacy}`)).text).id).toBe(legacy);
    expect(JSON.parse((await b!("GET",`/media/${crypto.randomUUID()}`)).text).error.code).toBe("MEDIA_ASSET_NOT_FOUND");
    expect(JSON.parse((await b!("POST",`/media/uploads/${crypto.randomUUID()}/commit`,{})).text).error.code).toBe("MEDIA_UPLOAD_EXPIRED");
    expect(JSON.parse((await b!("GET","/site-settings")).text)).not.toHaveProperty("media_id_tag");
  } finally {for (const db of dbs) db.close();await rm(directory,{recursive:true,force:true});}
});
