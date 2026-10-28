import {test, expect} from "bun:test";
import {Database} from "bun:sqlite";
import {mkdtemp, rm} from "node:fs/promises";
import {join} from "node:path";
import {sdkFixtureCaller} from "../../../mantle/tests/apps/fixtures.js";
import {generateFromSources} from "../../../mantle/src/infrastructure/generate.js";
import {admin, type Options} from "../../src/server/index.js";
import {siteRoutes} from "../../src/server/site.js";
import {writeAdminFixture} from "./generated-fixture.js";
import {r2MediaStorage, type R2Bucket} from "@aotter/mantle/media/r2";
import type {Caller} from "@aotter/mantle/contracts";

test("picker's existing Admin media routes retain caller, origin and exact upload policy gates", async () => {
  const result = await generateFromSources({target:"bun-sqlite", sources:{sources:[{sourceId:"notes.yaml",text:`apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: {name: notes}
spec:
  title: Notes
  lifecycle: operational
  schema: {type: object, properties: {title: {type: string}}, required: [title]}
`}]}, site:{media:{purposes:[{name:"card",required:["png"],maxBytes:{"image/png":1000}}]}}});
  if(!result.ok) throw Error(JSON.stringify(result.diagnostics));
  const directory=await mkdtemp(join(import.meta.dir,".media-picker-")), db=new Database(":memory:");
  try {
    await writeAdminFixture(directory,result.files); db.exec(result.files["schema.sql"]!);
    const {site}=await import(join(directory,"site.ts"));
    const objects=new Map<string,{size:number;httpMetadata:{contentType:string}}>(); let signs=0;
    const bucket:R2Bucket={async head(key){return objects.get(key)??null;},async get(key){const value=objects.get(key);return value?{...value,body:new Blob([new Uint8Array(value.size)]).stream()}:null;},async put(key,body,options){objects.set(key,{size:(await new Response(body).arrayBuffer()).byteLength,httpMetadata:options.httpMetadata});},async delete(keys){for(const key of typeof keys==="string"?[keys]:keys)objects.delete(key);}};
    const storage=r2MediaStorage({bucket,signer:{async sign(url){signs++;return {url};}},endpoint:"https://r2.test",publicBase:"https://media.test"});
    const session=sdkFixtureCaller({kind:"user",subject:"a",role:"admin",admin:true,scopes:[],credential:"session",credentialId:null,clientId:null});
    let caller:Caller=session;
    const options:Options<{},Database>={db:()=>db,caller:()=>caller,site,media:storage};
    const fetch=admin({collections:[],views:[],operations:[],webmcp:{tools:[],routes:{}}},[],[],{...options,routes:siteRoutes(options)});
    const ask=(path:string,body?:unknown,origin="https://app.test")=>fetch(new Request("https://app.test/admin/api"+path,{method:body?"POST":"GET",headers:{origin,"content-type":"application/json"},...(body?{body:JSON.stringify(body)}:{})}),{});
    const upload={filename:"card.png",purpose:"card",variants:[{mimeType:"image/png",byteSize:90,role:"primary"}]};
    caller={kind:"anonymous"}; expect((await ask("/media"))?.status).toBe(401);
    caller=sdkFixtureCaller({...session,kind:"user",role:"member",admin:false}); expect((await ask("/media"))?.status).toBe(403); expect((await ask("/media/uploads",upload))?.status).toBe(403);
    caller=sdkFixtureCaller({...session,kind:"user",credential:"api-key"}); expect((await ask("/media/uploads",upload))?.status).toBe(403);
    caller=session; expect((await ask("/media/uploads",upload,"https://evil.test"))?.status).toBe(403); expect(signs).toBe(0);
    const invalid=await ask("/media/uploads",{...upload,purpose:"unknown"}); expect(invalid?.status).toBe(400); expect((await invalid?.json()).error.code).toBe("MEDIA_PURPOSE_REJECTED"); expect(signs).toBe(0);
    const createdResponse=await ask("/media/uploads",upload); expect(createdResponse?.status).toBe(200);
    const created=await createdResponse!.json(); expect(signs).toBe(1);
    for(const capability of created.capabilities) objects.set(new URL(capability.uploadUrl).pathname.slice(1),{size:90,httpMetadata:{contentType:"image/png"}});
    const committed=await ask(`/media/uploads/${created.uploadGroupId}/commit`,{}); expect(committed?.status).toBe(200);
    const selected=await committed!.json(), list=await(await ask("/media"))!.json();
    expect(list.items).toHaveLength(1); expect(list.items[0]).toMatchObject({id:selected.id,primaryUrl:expect.stringContaining("https://media.test/")});
    expect(db.query("SELECT COUNT(*) AS n FROM media_assets").get()).toEqual({n:1});
  } finally {db.close();await rm(directory,{recursive:true,force:true});}
});
