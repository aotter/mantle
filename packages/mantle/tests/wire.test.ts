import {test,expect,spyOn} from 'bun:test';
import {Database} from 'bun:sqlite';
import {SQL} from 'bun';
import {mkdtemp,rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {generateOrThrow,writeGenerated} from './apps/link.js';
import {source,seed,verifyWire,integerCases} from './wire-scenarios.js';
const caller={kind:'anonymous'} as const;
async function fixture(target:'bun-sqlite'|'bun-postgres') {
 const files=await generateOrThrow(target,[{sourceId:'wire.yaml',text:source}]);const dir=await mkdtemp(resolve(import.meta.dir,'.wire-'));
 await writeGenerated(dir,files);return {files,dir};
}
async function mount(dir:string,db:any){
 const {rest}=await import(resolve(dir,'rest.ts')),{mcp}=await import(resolve(dir,'mcp.ts')),{default:bare}=await import(resolve(dir,'views/wire-records.ts'));
 const options={db:()=>db,caller:async()=>caller,handlers:{'echo-native':async()=>({flag:0,payload:'[1]'})}},http=rest(options),tools=mcp(options);
 return {fetch:async(request:Request)=>(await http(request,{}))??(await tools(request,{})),bare:(id:string)=>bare(db,caller,{id})};
}
test('selected REST/MCP wire preserves aliases, JSON primitives/nulls and booleans; native queries/ref outputs stay native',async()=>{
 const {files,dir}=await fixture('bun-sqlite'),raw=new Database(':memory:');let queries=0;const logging=spyOn(console,'error').mockImplementation(()=>{});
 try{
  raw.exec(files['schema.sql']!);raw.exec(seed(false));raw.exec("INSERT INTO wire_records(id,version,created_at,updated_at,payload,flag) VALUES('z',1,0,0,'private-invalid-json',1)");
  const db={query:(sql:string)=>{queries++;return raw.query(sql);},transaction:raw.transaction.bind(raw)};const app=await mount(dir,db);
  await verifyWire(app.fetch,app.bare,()=>queries,true,true);expect(logging.mock.calls).toHaveLength(2);expect(JSON.stringify(logging.mock.calls)).not.toContain("private-invalid-json");
 }finally{logging.mockRestore();raw.close();await rm(dir,{recursive:true,force:true});}
});
(process.env.MANTLE_NEXT_BUN_PG_URL?test:test.skip)('native PostgreSQL REST/MCP wire leaves already-native JSON primitive strings and booleans intact',async()=>{
 const {files,dir}=await fixture('bun-postgres'),raw=new SQL(process.env.MANTLE_NEXT_BUN_PG_URL!,{max:1}),schema='wire_'+crypto.randomUUID().replaceAll('-','');let queries=0;
 try{
  await raw.unsafe(`CREATE SCHEMA ${schema}`);await raw.unsafe(`SET search_path TO ${schema}`);await raw.unsafe(files['schema.sql']!);await raw.unsafe(seed(true));
  const db={unsafe:(sql:string,values:any[])=>{queries++;return raw.unsafe(sql,values);},begin:raw.begin.bind(raw)};const app=await mount(dir,db);await verifyWire(app.fetch,app.bare,()=>queries,false);
  expect((await app.bare('a'))[0].quantityAlias).toBe('2');
  for(const [id,value] of [['safe','9007199254740991'],['unsafe','9007199254740993'],['negative','-9007199254740993']] as const){
   const native=(await app.bare(id))[0];expect(native.quantityAlias).toBe(value);const before=queries,response=(await app.fetch(new Request('https://app.test/api/views/wire-records?id='+id)))!;expect(queries-before).toBe(1);
   const wire=(await response.json()).rows[0];expect(wire.quantityAlias).toBe(id==='safe'?Number(value):value);expect(wire.versionAlias).toBe(id==='safe'?Number(value):value);
   const beforeMcp=queries,mcp=(await app.fetch(new Request('https://app.test/mcp',{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'wire_records',arguments:{id}}})})))!;const body=await mcp.text(),result=JSON.parse(body.startsWith('event:')?body.split('data: ')[1]!.split('\n')[0]!:body);expect(queries-beforeMcp).toBe(1);expect(result.result.structuredContent.rows[0]).toEqual(wire);
  }
 }finally{await raw.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await raw.close();await rm(dir,{recursive:true,force:true});}
},30000);
test('wireRows preserves native input rows, missing fields and null without generic scanning',async()=>{
 const {wireRows}=await import('../src/kernel/contracts.js');const rows=[{payload:'{"x":1}',flag:1,raw:'[2]',nil:null},{}];const result=wireRows(rows,[['payload','json'],['flag','bool'],['nil','json']]);
 expect(result).toEqual([{payload:{x:1},flag:true,raw:'[2]',nil:null},{}]);expect(rows[0]!.payload).toBe('{"x":1}');expect(rows[0]!.flag).toBe(1);expect(wireRows(rows)).toBe(rows);
});

(process.env.MANTLE_NEXT_D1_REST?test:test.skip)('local D1 uses the same exact REST/MCP wire and one-query oracle',async()=>{
 const {readFile,writeFile,open}=await import('node:fs/promises'),{join}=await import('node:path'),{tmpdir}=await import('node:os'),{spawn}=await import('node:child_process'),{once}=await import('node:events'),{unstable_splitSqlQuery}=await import('wrangler');
 const base=resolve(import.meta.dir,'..'),dir=await mkdtemp(join(base,'tests/apps/.wire-d1-')),privateDir=await mkdtemp(join(tmpdir(),'mantle-wire-d1-'));let worker:ReturnType<typeof spawn>|undefined,log:Awaited<ReturnType<typeof open>>|undefined;
 try{
  const files=await generateOrThrow('cloudflare-d1',[{sourceId:'wire.yaml',text:source}]);await writeGenerated(dir,files);
  await writeFile(join(dir,'worker.ts'),`import {rest} from './rest.js';import {mcp} from './mcp.js';import bare from './views/wire-records.js';import {verifyWire} from ${JSON.stringify(resolve(import.meta.dir,'wire-scenarios.ts'))};export default{async fetch(request:Request,env:any){if(new URL(request.url).pathname==='/health')return new Response('ready');try{for(const sql of ${JSON.stringify(unstable_splitSqlQuery(files['schema.sql']!+seed(false)+"INSERT INTO wire_records(id,version,created_at,updated_at,payload,flag) VALUES('z',1,0,0,'private-invalid-json',1);"))})await env.DB.prepare(sql).run();let queries=0;const db={prepare:(sql:string)=>{queries++;return env.DB.prepare(sql);},batch:env.DB.batch.bind(env.DB)},caller={kind:'anonymous'} as const,options={db:()=>db,caller:async()=>caller,handlers:{'echo-native':async()=>({flag:0,payload:'[1]'})}},http=rest(options),tools=mcp(options);await verifyWire(async request=>(await http(request,{}))??(await tools(request,{})),id=>bare(db as never,caller,{id}),()=>queries,true,true);return Response.json({ok:true});}catch(error){return Response.json({error:String(error),stack:(error as Error).stack},{status:500});}}};`);
  const config=join(privateDir,'wrangler.json');await writeFile(config,JSON.stringify({name:'mantle-wire-local',main:join(dir,'worker.ts'),compatibility_date:'2026-09-28',compatibility_flags:['nodejs_compat'],d1_databases:[{binding:'DB',database_name:'mantle-wire-local',database_id:'00000000-0000-0000-0000-000000000001'}]}));
  log=await open(join(privateDir,'wrangler.log'),'w');worker=spawn('node',[join(base,'node_modules/wrangler/bin/wrangler.js'),'dev','--local','--config',config,'--ip','127.0.0.1','--port','8998','--inspector-port','0','--persist-to',join(privateDir,'state')],{cwd:base,detached:true,env:{...process.env,WRANGLER_SEND_METRICS:'false',NO_PROXY:'127.0.0.1,localhost',no_proxy:'127.0.0.1,localhost'},stdio:['ignore',log.fd,log.fd]});
  let ready=false;for(let i=0;i<60;i++){if(worker.exitCode!==null)throw Error(await readFile(join(privateDir,'wrangler.log'),'utf8'));try{ready=(await fetch('http://127.0.0.1:8998/health',{signal:AbortSignal.timeout(1000)})).ok;}catch{}if(ready)break;await new Promise(resolve=>setTimeout(resolve,1000));}
  expect(ready).toBe(true);const response=await fetch('http://127.0.0.1:8998/verify',{signal:AbortSignal.timeout(30000)});expect(await response.json()).toEqual({ok:true});expect(response.status).toBe(200);
 }finally{if(worker&&worker.exitCode===null){const ended=once(worker,'exit');try{process.kill(-worker.pid!,'SIGTERM');}catch{}await ended;}await log?.close();await rm(dir,{recursive:true,force:true});await rm(privateDir,{recursive:true,force:true});}
},90000);

test('unselected View boundaries exclude wire conversion and the compiler from startup',async()=>{
 const {build}=await import('esbuild'),{writeFile}=await import('node:fs/promises'),{startupGraph}=await import('../src/infrastructure/bundle.js');
 const files=await generateOrThrow('cloudflare-d1',[{sourceId:'unselected-wire.yaml',text:source.replace('surface: public\n  input:','surface: internal\n  input:')}]),dir=await mkdtemp(resolve(import.meta.dir,'.wire-startup-'));
 try{
  expect(files['rest.ts']).not.toContain('wireRows');expect(files['mcp.ts']).not.toContain('wireRows');await writeGenerated(dir,files,false);
  for(const [name,code] of [['bare','export {default} from "./views/wire-records.js";'],['boundaries','export {rest} from "./rest.js";export {mcp} from "./mcp.js";']] as const){
   const entry=resolve(dir,name+'.ts');await writeFile(entry,code);const result=await build({entryPoints:[entry],outdir:resolve(dir,name),bundle:true,splitting:true,format:'esm',platform:'neutral',conditions:['workerd','worker','browser'],external:['node:*'],write:false,metafile:true});
   const startup=startupGraph(result.metafile!,entry),text=result.outputFiles.filter(file=>startup.some(path=>resolve(path)===file.path)).map(file=>file.text).join('\n');expect(text.length).toBeGreaterThan(0);expect(text).not.toContain('function wireRows');
   expect(startup.flatMap(path=>Object.keys(result.metafile!.outputs[path]!.inputs)).some(path=>/(?:mantle\/(?:src|dist)|jsonc-parser|@modelcontextprotocol)/.test(path))).toBe(false);
  }
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('SQLite selected boundaries read exact int64 text before native Number rounding, including version aliases', async()=>{
 const {files,dir}=await fixture('bun-sqlite'),db=new Database(':memory:');
 try {
  db.exec(files['schema.sql']!);const app=await mount(dir,db);
  for(const [id,sql,expected] of integerCases){
   db.exec(`INSERT INTO wire_records(id,version,created_at,updated_at,quantity) VALUES('${id}',${sql},0,0,${sql})`);
   const response=(await app.fetch(new Request('https://app.test/api/views/wire-records?id='+id)))!;
   expect(response.status).toBe(200);const row=(await response.json()).rows[0];
   expect(row.quantityAlias).toBe(expected);expect(row.versionAlias).toBe(expected);
   expect(typeof (await app.bare(id))[0].quantityAlias).toBe('number');
   const responseMcp=(await app.fetch(new Request('https://app.test/mcp',{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'wire_records',arguments:{id}}})})))!;
   const body=await responseMcp.text(),rpc=JSON.parse(body.startsWith('event:')?body.split('data: ')[1]!.split('\n')[0]!:body);
   expect(rpc.result.structuredContent.rows[0]).toEqual(row);
  }
 } finally {db.close();await rm(dir,{recursive:true,force:true});}
});
test('integer ORDER BY aliases and hidden cursor keys retain numeric order and exact int64 authority',async()=>{
 const text=source.split('---')[0]!.replace('quantity: {type: integer, nullable: true}', 'quantity: {type: integer}').replace('schema: {type: object,','indexes: [[quantity,id]]\n  schema: {type: object, required: [quantity],')+`---
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: {name: ordered}
spec:
  surface: public
  sql: 'SELECT id, quantity AS "amount" FROM wire_records ORDER BY "amount",id'
`;
 const files=await generateOrThrow('bun-sqlite',[{sourceId:'int-order.yaml',text}]),dir=await mkdtemp(resolve(import.meta.dir,'.wire-order-')),db=new Database(':memory:');
 try{
  await writeGenerated(dir,files);db.exec(files['schema.sql']!);
  for(const [i,n] of ['2','10','9007199254740993','9007199254740995'].entries())db.exec(`INSERT INTO wire_records(id,version,created_at,updated_at,quantity) VALUES('${i}',1,0,0,${n})`);
  const {rest}=await import(resolve(dir,'rest.ts'));const fetch=rest({db:()=>db,caller:()=>caller});const page=async(_db:any,_caller:any,_input:any,options:any)=>{const params=new URLSearchParams({limit:String(options.limit),...(options.cursor?{cursor:options.cursor}:{})});return (await fetch(new Request('https://app.test/api/views/ordered?'+params),{}))!.json();};let cursor:string|undefined;const values:unknown[]=[];
  do{const result=await page(db,caller,{}, {limit:1,...(cursor?{cursor}:{})});values.push(result.rows[0].amount);cursor=result.nextCursor;}while(cursor);
  expect(values).toEqual([2,10,'9007199254740993','9007199254740995']);
 }finally{db.close();await rm(dir,{recursive:true,force:true});}
});
test('boundary type and conversion recipes are target identical, without changing native types',async()=>{
 const {nativeType,wireType}=await import('../src/domain/columns.js');
 expect(nativeType('integer',false)).toBe('number | string | bigint | null');expect(nativeType('integer',true)).toBe('number | null');
 expect(wireType('integer')).toBe('number | string | null');expect(wireType('int4')).toBe('number | string | null');expect(wireType('bool')).toBe('boolean | null');
 const emitted=[];
 for(const target of ['cloudflare-d1','cloudflare-postgres'] as const){const files=await generateOrThrow(target,[{sourceId:'wire.yaml',text:source}]);emitted.push(files['generated.ts']!.match(/export type View0WireRow = .*;/)![0]);expect(files['paged/views/wire-records.ts']).toContain('Input, Row');expect(files['paged/views/wire-records.ts']).not.toContain('wireRows');}
 expect(emitted[0]).toBe(emitted[1]);
});

test('public and internal native pages retain JSON text, booleans and driver numbers',async()=>{
 for(const surface of ['public','internal']){
  const text=source.replace('surface: public\n  input:',`surface: ${surface}\n  input:`),files=await generateOrThrow('bun-sqlite',[{sourceId:'native.yaml',text}]),dir=await mkdtemp(resolve(import.meta.dir,'.wire-native-')),db=new Database(':memory:');
  try{await writeGenerated(dir,files);db.exec(files['schema.sql']!);db.exec(seed(false));const {default:page}=await import(resolve(dir,'paged/views/wire-records.ts'));const row=(await page(db,caller,{id:'a'})).rows[0];expect(row.dataAlias).toBe('{"nested":[1,true]}');expect(row.enabledAlias).toBe(1);expect(row.quantityAlias).toBe(2);expect(files['paged/views/wire-records.ts']).not.toContain('CAST(_p.');}
  finally{db.close();await rm(dir,{recursive:true,force:true});}
 }
});

test('computed WireRow fields keep their native Row types',async()=>{
 const text=source.split('---')[0]+`---\napiVersion: cms.mantle.aotter.net/v2\nkind: View\nmetadata: {name: maximum}\nspec: {surface: internal, sql: 'SELECT max(quantity) AS units FROM wire_records'}\n`;
 for(const target of ['bun-sqlite','bun-postgres'] as const){const files=await generateOrThrow(target,[{sourceId:'computed.yaml',text}]);expect(files['generated.ts']).toContain('readonly "units": View0Row["units"];');}
});
