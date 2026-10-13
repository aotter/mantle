import {test,expect} from "bun:test";
import {mkdtemp,rm,writeFile,readFile,open} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {spawn} from "node:child_process";
import {once} from "node:events";
import {generateFromSources} from "../src/infrastructure/generate.js";
import {loadFixtureSources,writeGenerated} from "./apps/link.js";
(process.env.MANTLE_NEXT_SITE_D1?test:test.skip)("optional site/media performs durable native local D1 writes",async()=>{
 const dir=await mkdtemp(join(import.meta.dir,"apps/.site-d1-")),state=await mkdtemp(join(tmpdir(),"mantle-site-d1-"));
 let worker:ReturnType<typeof spawn>|undefined,log:Awaited<ReturnType<typeof open>>|undefined;
 try{
 const generated=await generateFromSources({target:"cloudflare-d1",sources:{sources:await loadFixtureSources()},site:{brand:"D1",media:{purposes:[{name:"cover",required:["png"],maxBytes:{"image/png":100}}]}}});if(!generated.ok)throw Error(JSON.stringify(generated.diagnostics));await writeGenerated(dir,generated.files);
 const {unstable_splitSqlQuery}=await import("wrangler");
 const source=`import {site} from './site.js';
 const caller={kind:'user' as const,subject:'staff',role:'staff' as any,scopes:[],credential:'session' as const,credentialId:null,clientId:null};
 const storage={async createUpload(a:any){return {capabilities:a.variants.map((v:any)=>({...v,method:'PUT' as const,uploadUrl:'https://upload.test/'+a.uploadGroupId,storageKey:'uploads/'+a.uploadGroupId}))}},async commitUpload(a:any){return {id:a.uploadGroupId,createdAt:a.now,variants:a.variants.map((v:any)=>({mimeType:v.mimeType,role:v.role,storageKey:a.uploadGroupId,publicUrl:'https://media.test/'+a.uploadGroupId,byteSize:90}))}},async deleteObject(){}};
 export default {async fetch(request:Request,env:any){if(new URL(request.url).pathname==='/health')return new Response('ready');try{for(const sql of ${JSON.stringify(unstable_splitSqlQuery(generated.files["schema.sql"]!))})await env.DB.prepare(sql).run();
 const s=site(env.DB,caller);await s.updateSettings({title:'Durable D1'});const media=s.media(storage);const u=await media.createUpload({filename:'x.png',purpose:'cover',variants:[{mimeType:'image/png',byteSize:90,role:'primary'}]});const a=await media.commitUpload(u.uploadGroupId);const repeated=await media.commitUpload(u.uploadGroupId);const list=await media.list({search:a.id});await media.update(a.id,{alt:'D1 alt'});const changed=await media.get(a.id);const deleted=await media.delete(a.id);return Response.json({title:(await s.read()).title,id:a.id===repeated.id,pending:(await env.DB.prepare('SELECT count(*) AS n FROM pending_media_uploads').all()).results[0].n,rows:list.rows.length,alt:changed.alt,deleted,remaining:(await media.list({})).rows.length});}catch(error){return Response.json({error:String(error),stack:(error as Error).stack},{status:500});}}};`;
 await writeFile(join(dir,"worker.ts"),source);const config=join(state,"wrangler.json");await writeFile(config,JSON.stringify({name:"mantle-site-local",main:join(dir,"worker.ts"),compatibility_date:"2026-09-28",compatibility_flags:["nodejs_compat"],d1_databases:[{binding:"DB",database_name:"mantle-site-local",database_id:"00000000-0000-0000-0000-000000000001"}]}));
 log=await open(join(state,"wrangler.log"),"w");worker=spawn("node",[join(import.meta.dir,"../node_modules/wrangler/bin/wrangler.js"),"dev","--local","--config",config,"--ip","127.0.0.1","--port","9001","--inspector-port","0","--persist-to",join(state,"state")],{cwd:join(import.meta.dir,".."),detached:true,env:{...process.env,WRANGLER_SEND_METRICS:"false",NO_PROXY:"127.0.0.1,localhost",no_proxy:"127.0.0.1,localhost"},stdio:["ignore",log.fd,log.fd]});
 let ready=false;for(let i=0;i<60;i++){if(worker.exitCode!==null)throw Error(await readFile(join(state,"wrangler.log"),"utf8"));try{ready=(await fetch("http://127.0.0.1:9001/health",{signal:AbortSignal.timeout(1000)})).ok;}catch{}if(ready)break;await new Promise(resolve=>setTimeout(resolve,1000));}expect(ready).toBe(true);
 const response=await fetch("http://127.0.0.1:9001/verify");expect(await response.json()).toEqual({title:"Durable D1",id:true,pending:0,rows:1,alt:"D1 alt",deleted:{deleted:true,variantsRemoved:1},remaining:0});expect(response.status).toBe(200);
 }finally{if(worker&&worker.exitCode===null){const ended=once(worker,"exit");try{process.kill(-worker.pid!,"SIGTERM");}catch{}await ended;}await log?.close();await rm(dir,{recursive:true,force:true});await rm(state,{recursive:true,force:true});}
},90000);
