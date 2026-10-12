import {test,expect} from "bun:test";
import {Database} from "bun:sqlite";
import {SQL} from "bun";
import {mkdtemp,rm} from "node:fs/promises";
import {join} from "node:path";
import {generateFromSources} from "../src/infrastructure/generate.js";
import {loadFixtureSources,writeGenerated} from "./apps/link.js";
import {d1Shim} from "./apps/d1-shim.js";
import {identityFixture} from "./admin-site-identity.js";
import {admin as serve} from "../src/kernel/admin.js";
import {siteRoutes} from "../src/kernel/admin-site.js";
import {adminSiteDefaults,adminSiteStaff,adminSiteStorage,verifyAdminSite} from "./admin-site-scenarios.js";
for(const target of ["bun-sqlite","bun-postgres"] as const)(target==="bun-postgres"&&!process.env.MANTLE_NEXT_BUN_PG_URL?test.skip:test)(`${target} Admin site/media/identity native routes preserve the SPA contract`,async()=>{
  const sqlite=target==="bun-sqlite",db:any=sqlite?new Database(":memory:"):new SQL(process.env.MANTLE_NEXT_BUN_PG_URL!,{max:1}),schema="admin_site_"+crypto.randomUUID().replaceAll("-",""),dir=await mkdtemp(join(import.meta.dir,"apps/.admin-site-"));
  try{
    const execute=async(sql:string)=>sqlite?db.exec(sql):db.unsafe(sql);
    if(!sqlite){await execute(`CREATE SCHEMA ${schema}`);await execute(`SET search_path TO ${schema}`);}
    const generated=await generateFromSources({target,sources:{sources:await loadFixtureSources()},site:adminSiteDefaults});if(!generated.ok)throw Error(JSON.stringify(generated.diagnostics));
    expect(generated.files["admin.ts"]).toContain("siteRoutes(");await execute(generated.files["schema.sql"]!);await writeGenerated(dir,generated.files);
    const identity=await identityFixture(sqlite?d1Shim(db):db,!sqlite,execute),{site}=await import(join(dir,"site.ts")),{admin}=await import(join(dir,"admin.ts"));let sent=0;
    const fetch=admin({db:()=>db,caller:()=>adminSiteStaff,site,media:adminSiteStorage,identity:{directory:identity.directory,roles:{sendStaffInvitation:async(email:string,role:string)=>{expect(email).toBe("invited@example.test");expect(role).toBe("staff");sent++;}}}});
    expect((await verifyAdminSite(r=>fetch(r,{}),identity.cookie)).checks).toBeGreaterThan(30);expect(sent).toBe(1);
  }finally{if(sqlite)db.close();else{await db.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await db.close();}await rm(dir,{recursive:true,force:true});}
},30000);
test("Admin site routes refuse before body/DB, preserve 501 and never expose identity secrets",async()=>{
  let calls=0,caller:any=adminSiteStaff;
  const options={db:()=>{calls++;return{};},caller:()=>caller};
  const routes=siteRoutes(options),fetch=serve({collections:[],views:[],operations:[],webmcp:{}},[],[],{...options,routes});
  const req=(path:string,method="GET",body?:string,headers:Record<string,string>={origin:"https://app.test"})=>fetch(new Request("https://app.test/admin/api"+path,{method,body,headers}),{});
  for(const path of ["/site-settings","/media","/staff","/members"]){const response=(await req(path))!;expect(response.status).toBe(501);expect(response.headers.get("cache-control")).toContain("no-store");}
  const unwired=new Request("https://app.test/admin/api/media/uploads",{method:"POST",body:"bad",headers:{origin:"https://app.test"}});expect((await fetch(unwired,{}))!.status).toBe(501);expect(unwired.bodyUsed).toBe(false);
  calls=0;
  for(const denied of [{kind:"anonymous"},{...adminSiteStaff,credential:"oauth"},{...adminSiteStaff,role:"owner"},{...adminSiteStaff,role:null},{kind:"system",reason:"test"}]){caller=denied;const response=(await req("/staff"))!;expect(response.status).toBe(denied.kind==="anonymous"?401:403);}expect(calls).toBe(0);caller=adminSiteStaff;
  for(const origin of ["https://evil.test",""]){expect((await req("/site-settings","PATCH","{}",origin?{origin}:{}))!.status).toBe(403);}expect(calls).toBe(0);
  for(const path of ["/media/%2Fprivate","/media/%00","/staff/%00/role"]){expect((await req(path))!.status).toBe(400);}expect(calls).toBe(0);
  const row:any={id:"member",email:"m@example.test",name:"Member",role:"staff",githubLogin:null,emailVerified:true,createdAt:new Date(0),password:"SECRET",token:"SECRET",banReason:"SECRET"};
  const withIdentity={...options,identity:{directory:()=>({listUsers:async()=>[row],listMembers:async()=>({items:[row],previousCursor:null,nextCursor:null})})}};
  const wired=serve({collections:[],views:[],operations:[],webmcp:{}},[],[],{...withIdentity,routes:siteRoutes(withIdentity)});
  for(const path of ["/staff","/members"]){const response=(await wired(new Request("https://app.test/admin/api"+path),{}))!,json=await response.text();expect(response.status).toBe(200);expect(json).not.toContain("SECRET");expect(json).not.toContain("banReason");if(path==="/members")expect(json).not.toContain('"role"');}
  let read=false;
  const configured={...options,site:()=>({read:async()=>({} as any),updateSettings:async()=>{read=true;return{} as any;},media:()=>({} as any)})};
  const bounded=serve({collections:[],views:[],operations:[],webmcp:{}},[],[],{...configured,routes:siteRoutes(configured)}),oversized=new Request("https://app.test/admin/api/site-settings",{method:"PATCH",body:"{}",headers:{origin:"https://app.test","content-length":"1000001"}});
  expect((await bounded(oversized,{}))!.status).toBe(400);expect(oversized.bodyUsed).toBe(false);expect(read).toBe(false);
});
