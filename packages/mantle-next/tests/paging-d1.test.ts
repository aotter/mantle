import {test,expect} from "bun:test";
import {mkdtemp,writeFile,readFile,rm,open} from "node:fs/promises";
import {resolve,join} from "node:path";
import {tmpdir} from "node:os";
import {spawn} from "node:child_process";
import {once} from "node:events";
import {generateOrThrow,writeGenerated,loadFixtureSources} from "./apps/link.js";
import {verifyPaging,pagingSeed} from "./paging-scenarios.js";
(process.env.MANTLE_NEXT_PAGING_D1?test:test.skip)("actual local D1 pages use one query per request and match the native oracle",async()=>{
 const {unstable_splitSqlQuery}=await import("wrangler"),base=resolve(import.meta.dir,".."),dir=await mkdtemp(join(base,"tests/apps/.paging-d1-")),state=await mkdtemp(join(tmpdir(),"mantle-paging-d1-")),port=process.env.MANTLE_NEXT_PAGING_PORT??"8995";
 let worker:ReturnType<typeof spawn>|undefined,log:Awaited<ReturnType<typeof open>>|undefined;
 try{
  const files=await generateOrThrow("cloudflare-d1",await loadFixtureSources("paging.yaml"));await writeGenerated(dir,files,false);
  const names=["ordered","mixed","grouped","grouped-time","window-groups","joined","lookup","singleton"];
  await writeFile(join(dir,"worker.ts"),`${names.map((name,i)=>`import p${i} from './paged/views/${name}.js';`).join('\n')}
const pages={${names.map((name,i)=>`${JSON.stringify(name)}:p${i}`).join(',')}};
export default{async fetch(request:Request,env:{DB:any}){const path=new URL(request.url).pathname;if(path==='/health')return new Response('ready');try{if(path==='/seed'){for(const sql of ${JSON.stringify(unstable_splitSqlQuery(files['schema.sql']!+';'+pagingSeed(false)))})await env.DB.prepare(sql).run();return Response.json({ok:true});}const args:any=await request.json();if(path==='/native')return Response.json((await env.DB.prepare(args.sql).all()).results);let calls=0;const db={prepare(sql:string){calls++;return env.DB.prepare(sql)}};const rows=await pages[args.name](db,args.caller,args.input,args.options);return Response.json({rows,calls});}catch(error){return Response.json({error:{code:(error as any).code,message:String(error)}},{status:400});}}};`);
  const config=join(state,"wrangler.json");await writeFile(config,JSON.stringify({name:"mantle-paging-local",main:join(dir,"worker.ts"),compatibility_date:"2026-09-28",compatibility_flags:["nodejs_compat"],d1_databases:[{binding:"DB",database_name:"mantle-paging-local",database_id:"00000000-0000-0000-0000-000000000001"}]}));
  log=await open(join(state,"wrangler.log"),"w");worker=spawn("node",[join(base,"node_modules/wrangler/bin/wrangler.js"),"dev","--local","--config",config,"--ip","127.0.0.1","--port",port,"--inspector-port","0","--persist-to",join(state,"state")],{cwd:base,detached:true,env:{...process.env,WRANGLER_SEND_METRICS:"false",NO_PROXY:"127.0.0.1,localhost",no_proxy:"127.0.0.1,localhost"},stdio:["ignore",log.fd,log.fd]});
  let ready=false;for(let i=0;i<60;i++){if(worker.exitCode!==null)throw Error(await readFile(join(state,"wrangler.log"),"utf8"));try{ready=(await fetch(`http://127.0.0.1:${port}/health`,{signal:AbortSignal.timeout(1000)})).ok;}catch{}if(ready)break;await new Promise(resolve=>setTimeout(resolve,1000));}expect(ready).toBe(true);
  const origin=`http://127.0.0.1:${port}`;expect(await (await fetch(origin+"/seed")).json()).toEqual({ok:true});let calls=0;
  const post=async(path:string,body:unknown)=>{const result:any=await(await fetch(origin+path,{method:"POST",body:JSON.stringify(body)})).json();if(result.error)throw Object.assign(Error(result.error.message),{code:result.error.code});return result;};
  const pages:Record<string,Function>={};for(const name of names)pages[name]=async(_:unknown,caller:unknown,input:unknown,options:unknown)=>{const result=await post("/page",{name,caller,input,options});calls+=result.calls;return result.rows;};
  await verifyPaging(pages,null,sql=>post("/native",{sql}),()=>calls,false);expect(calls).toBeGreaterThan(500);
 }finally{if(worker&&worker.exitCode===null){const ended=once(worker,"exit");try{process.kill(-worker.pid!,"SIGTERM");}catch{}await ended;}await log?.close();await rm(dir,{recursive:true,force:true});await rm(state,{recursive:true,force:true});}
},120000);
