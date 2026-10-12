import {test,expect} from "bun:test";
import {mkdtemp,rm,writeFile,readFile,open} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {spawn} from "node:child_process";
import {once} from "node:events";
import {generateFromSources} from "../src/infrastructure/generate.js";
import {loadFixtureSources,writeGenerated} from "./apps/link.js";
import {adminSiteDefaults} from "./admin-site-scenarios.js";
(process.env.MANTLE_NEXT_ADMIN_SITE_D1?test:test.skip)("Admin site/media/identity same scenario on actual local D1",async()=>{
  const dir=await mkdtemp(join(import.meta.dir,"apps/.admin-site-d1-")),state=await mkdtemp(join(tmpdir(),"mantle-admin-site-d1-"));
  let worker:ReturnType<typeof spawn>|undefined,log:Awaited<ReturnType<typeof open>>|undefined;
  try{
    const generated=await generateFromSources({target:"cloudflare-d1",sources:{sources:await loadFixtureSources()},site:adminSiteDefaults});if(!generated.ok)throw Error(JSON.stringify(generated.diagnostics));await writeGenerated(dir,generated.files);
    const {unstable_splitSqlQuery}=await import("wrangler");
    await writeFile(join(dir,"worker.ts"),`import {admin} from './admin.js';
import {identityFixture} from '${join(import.meta.dir,"admin-site-identity.ts")}';
import {adminSiteStaff,adminSiteStorage,verifyAdminSite} from '${join(import.meta.dir,"admin-site-scenarios.ts")}';
export default {async fetch(request:Request,env:any){if(new URL(request.url).pathname==='/health')return new Response('ready');try{
for(const sql of ${JSON.stringify(unstable_splitSqlQuery(generated.files["schema.sql"]!))})await env.DB.prepare(sql).run();
const identity=await identityFixture(env.DB,false,sql=>env.DB.prepare(sql).run());let sent=0;
const fetch=admin({db:()=>env.DB,caller:()=>adminSiteStaff,media:adminSiteStorage,identity:{directory:identity.directory,roles:{sendStaffInvitation:async()=>{sent++;}}}});
const result=await verifyAdminSite(r=>fetch(r,env),identity.cookie);return Response.json({...result,sent});
}catch(error){return Response.json({error:String(error),stack:(error as Error).stack},{status:500});}}};`);
    const config=join(state,"wrangler.json");await writeFile(config,JSON.stringify({name:"mantle-admin-site-local",main:join(dir,"worker.ts"),compatibility_date:"2026-09-28",compatibility_flags:["nodejs_compat"],d1_databases:[{binding:"DB",database_name:"mantle-admin-site-local",database_id:"00000000-0000-0000-0000-000000000001"}]}));
    log=await open(join(state,"wrangler.log"),"w");worker=spawn("node",[join(import.meta.dir,"../node_modules/wrangler/bin/wrangler.js"),"dev","--local","--config",config,"--ip","127.0.0.1","--port","8993","--inspector-port","0","--persist-to",join(state,"state")],{cwd:join(import.meta.dir,".."),detached:true,env:{...process.env,WRANGLER_SEND_METRICS:"false",NO_PROXY:"127.0.0.1,localhost",no_proxy:"127.0.0.1,localhost"},stdio:["ignore",log.fd,log.fd]});
    let ready=false;for(let i=0;i<60;i++){if(worker.exitCode!==null)throw Error(await readFile(join(state,"wrangler.log"),"utf8"));try{ready=(await fetch("http://127.0.0.1:8993/health",{signal:AbortSignal.timeout(1000)})).ok;}catch{}if(ready)break;await new Promise(resolve=>setTimeout(resolve,1000));}expect(ready).toBe(true);
    const response=await fetch("http://127.0.0.1:8993/verify"),result:any=await response.json();expect(result).toEqual({checks:34,sent:1});expect(response.status).toBe(200);
  }finally{if(worker&&worker.exitCode===null){const ended=once(worker,"exit");try{process.kill(-worker.pid!,"SIGTERM");}catch{}await ended;}await log?.close();await rm(dir,{recursive:true,force:true});await rm(state,{recursive:true,force:true});}
},90000);
