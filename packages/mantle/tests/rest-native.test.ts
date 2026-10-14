import {test,expect} from "bun:test";
import {SQL} from "bun";
import {mkdtemp,readFile,writeFile,rm,open} from "node:fs/promises";
import {resolve,join} from "node:path";
import {tmpdir} from "node:os";
import {spawn,execFileSync} from "node:child_process";
import {once} from "node:events";
import {generateOrThrow,writeGenerated,loadFixtureSources} from "./apps/link.js";
import {verifyRest} from "./rest-scenarios.js";
const base=resolve(import.meta.dir,".."),caller=`async(request:Request)=>request.headers.get("x-role")?userCaller({id:"s",role:request.headers.get("x-role")==="none"?null:request.headers.get("x-role")},{adminRoles:["admin"],credential:(request.headers.get("x-credential")||"api-key") as "api-key"}):{kind:"anonymous" as const}`;
const composition=`import {userCaller} from '${resolve(base,'src/kernel/user-fields.ts')}';import {rest} from './rest.js';import type {Handlers} from './generated.js';
const handlers:Handlers={echo:async(ctx,input)=>({reply:input.message,title:(await ctx.store.collection("notes").findById("a"))!.title})};
export const app=rest({db:(env:{DB:any})=>env.DB,caller:${caller},handlers});`;
function seed(pg:boolean):string {
 return `INSERT INTO notes(id,version,created_at,updated_at,title) VALUES ('a',1,${pg?"now(),now()":"0,0"},'a'),('b',1,${pg?"now(),now()":"0,0"},'b'),('c',1,${pg?"now(),now()":"0,0"},'c'); INSERT INTO posts(id,version,created_at,updated_at,title,status) VALUES ('draft',1,${pg?"now(),now()":"0,0"},'private','draft'),('published',1,${pg?"now(),now()":"0,0"},'public','published');`;
}
async function fixture(target:"bun-sqlite"|"bun-postgres"|"cloudflare-d1") {
 const dir=await mkdtemp(join(base,"tests/apps/.rest-native-"));
 try {const sources=await loadFixtureSources("rest.yaml");
 const files=await generateOrThrow(target,target==="bun-postgres"?sources:sources.map(source=>({...source,text:source.text.replace("CAST(input.payload AS jsonb)","input.payload")})));await writeGenerated(dir,files);await writeFile(join(dir,"app.ts"),composition);return {dir,files};} catch(error){await rm(dir,{recursive:true,force:true});throw error;}
}
(process.env.MANTLE_NEXT_BUN_PG_URL ? test : test.skip)("REST real Bun.SQL PostgreSQL runs the same transport and state oracle",async()=>{
 const {dir,files}=await fixture("bun-postgres"),sql=new SQL(process.env.MANTLE_NEXT_BUN_PG_URL!,{max:1}),schema="rest_"+crypto.randomUUID().replaceAll("-","");
 try {await sql.unsafe(`CREATE SCHEMA ${schema}`);await sql.unsafe(`SET search_path TO ${schema}`);await sql.unsafe(files["schema.sql"]!);await sql.unsafe(seed(true));const {app}=await import(join(dir,"app.ts"));await verifyRest(request=>app(request,{DB:sql}));expect(true).toBe(true);} finally {await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await sql.close();await rm(dir,{recursive:true,force:true});}
},30000);
test("REST Handlers are type-required and reject mismatched implementations",async()=>{
 const {dir}=await fixture("bun-sqlite");
 try {
  await writeFile(join(dir,"types.ts"),`import {rest} from './rest.js';import {Database} from 'bun:sqlite';import type {Handlers} from './generated.js';const db=new Database(':memory:');const caller=async()=>({kind:'anonymous'} as const);
// @ts-expect-error manifest declares refs: handlers required
rest({db:()=>db,caller});
// @ts-expect-error handler input/output mismatch
rest({db:()=>db,caller,handlers:{echo:async()=>({reply:1,title:1})}});
const handlers:Handlers={echo:async(ctx,input)=>({reply:input.message,title:(await ctx.store.collection('notes').findById('a'))!.title})};rest({db:()=>db,caller,handlers});`);
  await writeFile(join(dir,"tsconfig.json"),JSON.stringify({compilerOptions:{noEmit:true,strict:true,skipLibCheck:true,target:"ES2022",module:"NodeNext",moduleResolution:"NodeNext",types:["bun-types"],allowImportingTsExtensions:true},include:["types.ts"]}));
  execFileSync("node",[join(base,"node_modules/typescript/bin/tsc"),"--project",join(dir,"tsconfig.json")],{cwd:base,stdio:"pipe"});expect(true).toBe(true);
 } finally {await rm(dir,{recursive:true,force:true});}
},30000);
(process.env.MANTLE_NEXT_REST_D1 ? test : test.skip)("REST real local D1 runs the same transport and state oracle",async()=>{
 const {unstable_splitSqlQuery}=await import("wrangler"),{dir,files}=await fixture("cloudflare-d1"),privateDir=await mkdtemp(join(tmpdir(),"mantle-rest-d1-"));
 let worker:ReturnType<typeof spawn>|undefined,log:Awaited<ReturnType<typeof open>>|undefined;
 try {
  await writeFile(join(dir,"worker.ts"),`${composition}\nimport {verifyRest} from ${JSON.stringify(resolve(import.meta.dir,"rest-scenarios.ts"))};export default{async fetch(request:Request,env:{DB:any}){if(new URL(request.url).pathname==='/health')return new Response('ready');try{for(const sql of ${JSON.stringify(unstable_splitSqlQuery(files["schema.sql"]!+seed(false)))})await env.DB.prepare(sql).run();await verifyRest(request=>app(request,env));return Response.json({ok:true});}catch(error){return Response.json({error:String(error),stack:(error as Error).stack},{status:500});}}};`);
  const config=join(privateDir,"wrangler.json");await writeFile(config,JSON.stringify({name:"mantle-rest-local",main:join(dir,"worker.ts"),compatibility_date:"2026-09-28",compatibility_flags:["nodejs_compat"],d1_databases:[{binding:"DB",database_name:"mantle-rest-local",database_id:"00000000-0000-0000-0000-000000000001"}]}));
  log=await open(join(privateDir,"wrangler.log"),"w");worker=spawn("node",[join(base,"node_modules/wrangler/bin/wrangler.js"),"dev","--local","--config",config,"--ip","127.0.0.1","--port","8998","--inspector-port","0","--persist-to",join(privateDir,"state")],{cwd:base,detached:true,env:{...process.env,WRANGLER_SEND_METRICS:"false",NO_PROXY:"127.0.0.1,localhost",no_proxy:"127.0.0.1,localhost"},stdio:["ignore",log.fd,log.fd]});
  let ready=false;for(let i=0;i<60;i++){if(worker.exitCode!==null)throw Error(await readFile(join(privateDir,"wrangler.log"),"utf8"));try{ready=(await fetch("http://127.0.0.1:8998/health",{signal:AbortSignal.timeout(1000)})).ok;}catch{}if(ready)break;await new Promise(resolve=>setTimeout(resolve,1000));}
  expect(ready).toBe(true);const response=await fetch("http://127.0.0.1:8998/verify",{signal:AbortSignal.timeout(30000)});expect(await response.json()).toEqual({ok:true});expect(response.status).toBe(200);
 }finally {if(worker&&worker.exitCode===null){const ended=once(worker,"exit");try{process.kill(-worker.pid!,"SIGTERM");}catch{}await ended;}await log?.close();await rm(dir,{recursive:true,force:true});await rm(privateDir,{recursive:true,force:true});}
},90000);
