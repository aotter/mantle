import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { SQL } from "bun";
import { resolve } from "node:path";
import { rm } from "node:fs/promises";
import { jwt } from "better-auth/plugins";
import { oauthProvider } from "@better-auth/oauth-provider";
import { generateFromSources } from "../src/infrastructure/generate.js";
import { encodeTimestamptz, encodeDate } from "../src/kernel/scalars.js";
import { writeGenerated } from "./apps/link.js";
import { d1Shim } from "./apps/d1-shim.js";

const atom = (kind: string, name: string, spec: object) => JSON.stringify({apiVersion:"cms.mantle.aotter.net/v2",kind,metadata:{name},spec});
const text = [atom("Schema","items",{title:"Portable items",lifecycle:"publishing",schema:{type:"object",properties:{owner:{type:"string"},title:{type:"string"},units:{type:"integer"},enabled:{type:"boolean"},payload:{type:"object"},at:{type:"string",format:"date-time"},day:{type:"string",format:"date"},expires:{type:["string","null"],format:"date-time"}},required:["owner","title","units","enabled","payload","at","day"]},scope:{owner:"auth.uid()"},indexes:[["owner"]],searchableFields:["title"],ttl:{field:"expires",expireAfterSeconds:0}}),atom("View","items",{surface:"public",requires:{auth:{all:["ctx.user"]}},sql:"SELECT id,title,at,day FROM items ORDER BY id"})].join("\n---\n");
const auth = () => ({plugins:[jwt(),oauthProvider({loginPage:"/login",consentPage:"/consent"})]});
const exactJSON = '{"int":9007199254740993,"negative":-9007199254740993,"decimal":1.234567890123456789,"scale":1.2300e2,"huge":1e400,"array":[null,true,"9007199254740993"],"nested":{"small":0.000000000000000000123}}';
const directory = resolve(import.meta.dir,"apps/.generated",`transfer-${crypto.randomUUID()}`);
afterAll(()=>rm(directory,{recursive:true,force:true}));
const stream = (text: string) => new ReadableStream<Uint8Array>({start(c){c.enqueue(new TextEncoder().encode(text));c.close();}});
async function fixture(target: "bun-sqlite"|"bun-postgres"|"cloudflare-d1", authOptions: object = {}, searchable = true) {
  const atoms=text.split("\n---\n").map(part=>JSON.parse(part));if(!searchable)delete atoms[0].spec.searchableFields;
  atoms[0].spec.schema.properties.optional_day={type:["string","null"],format:"date"};
  const result=await generateFromSources({target,sources:{sources:[{sourceId:"transfer.yaml",text:atoms.map(atom=>JSON.stringify(atom)).join("\n---\n")}]},site:{locales:["en"]},auth:{...auth(),...authOptions}});
  if(!result.ok) throw Error(JSON.stringify(result.diagnostics));
  const dir=resolve(directory,`${target}-${crypto.randomUUID()}`);await writeGenerated(dir,result.files);
  return {dir,ddl:result.files["schema.sql"]!,app:await import(resolve(dir,"transfer.ts")),query:await import(resolve(dir,"generated.ts")),files:result.files};
}
async function sqlite(target:"bun-sqlite"|"cloudflare-d1"="bun-sqlite",authOptions?:object){const f=await fixture(target,authOptions),db=new Database(":memory:");db.exec("PRAGMA foreign_keys=ON");db.exec(f.ddl);return {...f,db,handle:target==="cloudflare-d1"?d1Shim(db):db};}
async function postgres(authOptions?:object){const f=await fixture("bun-postgres",authOptions),db=new SQL({url:process.env.MANTLE_NEXT_BUN_PG_URL!,max:1}),schema=`transfer_${crypto.randomUUID().replaceAll("-","")}`;await db.unsafe(`CREATE SCHEMA "${schema}"`);await db.unsafe(`SET search_path TO "${schema}"`);await db.unsafe(f.ddl);return {...f,db,handle:db,close:async()=>{try{await db.unsafe(`DROP SCHEMA "${schema}" CASCADE`);}finally{await db.close();}}};}
async function seed(f:Awaited<ReturnType<typeof sqlite>>){
  for(let i=0;i<65;i++)f.db.query("INSERT INTO items(id,version,created_at,updated_at,author_id,status,published_at,owner,title,units,enabled,payload,at,day,expires) VALUES(?,CAST(? AS INTEGER),?,?,?,?,?,?,?,?,?,?,?,?,?)").run(`row-${String(i).padStart(3,"0")}`,i===0?"9007199254740993":"7",encodeTimestamptz("1969-12-31T23:59:59.123456Z"),encodeTimestamptz("2026-10-12T00:00:00.654321Z"),i%2?"owner-a":null,["draft","published","archived"][i%3]!,null,i%2?"owner-a":"owner-b",`record ${i}`,i===0?"-9007199254740993":String(i),i%2,i===0?exactJSON:i===1?"null":JSON.stringify({z:[null,false,"emoji 🧪"],a:{nested:"value"}}),encodeTimestamptz("2026-10-12T08:00:00.123456+08:00"),encodeDate("2024-02-29"),i%4?null:encodeTimestamptz("2000-01-01T00:00:00Z"));
  const at="2026-10-12T00:00:00.123456Z";
  f.db.query('INSERT INTO user(id,name,email,emailVerified,"createdAt","updatedAt") VALUES(?,?,?,?,?,?)').run("member","Member","member@example.test",1,at,at);
  f.db.query('INSERT INTO session(id,token,"userId","expiresAt","createdAt","updatedAt") VALUES(?,?,?,?,?,?)').run("session","fixture-token","member","2030-01-01T00:00:00.000001Z",at,at);
  f.db.query('INSERT INTO account(id,"accountId","providerId","userId","createdAt","updatedAt") VALUES(?,?,?,?,?,?)').run("account","member","email","member",at,at);
  f.db.query('INSERT INTO verification(id,identifier,value,"expiresAt","createdAt","updatedAt") VALUES(?,?,?,?,?,?)').run("verification","synthetic","value",at,at,at);
  f.db.query('INSERT INTO jwks(id,"publicKey","privateKey","createdAt") VALUES(?,?,?,?)').run("key","synthetic-public","synthetic-private",at);
  f.db.query('INSERT INTO "oauthClient"(id,"clientId","redirectUris","userId",metadata) VALUES(?,?,?,?,?)').run("client-row","client",'["https://example.test/callback"]',"member",JSON.stringify("scalar JSON"));
  f.db.query('INSERT INTO "oauthConsent"(id,"clientId","userId",scopes,"createdAt","updatedAt") VALUES(?,?,?,?,?,?)').run("consent","client","member",'["mcp"]',at,at);
  f.db.query('INSERT INTO "oauthRefreshToken"(id,token,"clientId","userId","sessionId",scopes,"expiresAt","createdAt") VALUES(?,?,?,?,?,?,?,?)').run("refresh","synthetic-refresh","client","member","session",'["mcp"]',at,at);
  f.db.query('INSERT INTO "oauthAccessToken"(id,token,"clientId","userId","sessionId","refreshId",scopes,"expiresAt","createdAt") VALUES(?,?,?,?,?,?,?,?,?)').run("access","synthetic-access","client","member","session","refresh",'["mcp"]',at,at);
  f.db.query('INSERT INTO site_config(key,value) VALUES(?,?)').run("brand","Portable");
  f.db.query('INSERT INTO media_assets(id,created_at,owner_id,variants) VALUES(?,?,?,?)').run("asset",1700000000123,"member","[]");
  f.db.query('INSERT INTO pending_media_uploads(id,record,expires_at) VALUES(?,?,?)').run("pending","{}",1700000000999);
}
const exported = (f:{app:any;handle:unknown}) => new Response(f.app.exportStore(f.handle)).text();
const body = (dump:string) => dump.slice(dump.indexOf("\n")+1);

test("portable SQLite dump includes all scopes, TTL and publishing states, preserves ids/versions/microseconds, excludes sessions",async()=>{
  const source=await sqlite(),target=await sqlite();try{
    await seed(source);const dump=await exported(source),header=JSON.parse(dump.split("\n")[0]!);
    expect(header.sessions).toBe("omitted");expect(header.ignoredSessionLinks).toContainEqual(["oauthAccessToken","sessionId"]);
    expect(dump).toContain('"9007199254740993"');expect(dump).toContain('"-9007199254740993"');expect(dump).not.toContain('"table":"session"');
    expect(await target.app.importStore(target.handle,stream(dump))).toEqual({rows:76});
    expect(await exported(target)).toBe(dump);
    expect(target.db.query("SELECT payload -> '$.int' AS integer, payload -> '$.decimal' AS decimal, payload -> '$.huge' AS huge FROM items WHERE id='row-000'").get()).toEqual({integer:"9007199254740993",decimal:"1234567890123456789e-18",huge:"1e400"});
    expect(target.db.query("SELECT payload, payload IS NULL AS sqlNull FROM items WHERE id='row-001'").get()).toEqual({payload:"null",sqlNull:0});
    expect(target.db.query("SELECT COUNT(*) AS n FROM session").get()).toEqual({n:0});
    expect(target.db.query('SELECT "sessionId" FROM "oauthRefreshToken"').get()).toEqual({sessionId:null});
    expect(target.db.query('SELECT COUNT(*) AS n FROM "_mantle_fts_items" WHERE "_mantle_fts_items" MATCH \'record\'').get()).toEqual({n:65});
    expect(target.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  }finally{source.db.close();target.db.close();}
});

(process.env.MANTLE_NEXT_BUN_PG_URL?test:test.skip)("SQLite → real PostgreSQL → SQLite preserves canonical portable rows and generated View date output",async()=>{
  const source=await sqlite(),target=await postgres(),back=await sqlite();try{
    await seed(source);const original=await exported(source);await target.app.importStore(target.handle,stream(original));const pg=await exported(target);
    expect(body(pg)).toBe(body(original));
    expect((await target.db.unsafe("SELECT payload->>'int' AS integer,payload->>'decimal' AS decimal,payload->>'negative' AS negative FROM items WHERE id='row-000'"))[0]).toEqual({integer:"9007199254740993",decimal:"1.234567890123456789",negative:"-9007199254740993"});
    expect((await target.db.unsafe("SELECT CAST(payload AS TEXT) AS payload,payload IS NULL AS null FROM items WHERE id='row-001'"))[0]).toEqual({payload:"null",null:false});
    await back.app.importStore(back.handle,stream(pg));expect(await exported(back)).toBe(original);
    const caller={kind:"user",subject:"owner-a",role:null,scopes:[],credential:"session",credentialId:null,clientId:null};
    expect(await target.query.views.items(target.db,caller,{})).toEqual(await source.query.views.items(source.db,caller,{}));
  }finally{source.db.close();back.db.close();await target.close();}
},60_000);

test("fresh target and wrong descriptor are refused before writes; corrupt dumps roll back SQLite and mark D1 incomplete",async()=>{
  const source=await sqlite();try{
    await seed(source);const dump=await exported(source);
    for(const [variant,needle] of [[dump.replace(/"fingerprint":"[a-f0-9]+"/,'"fingerprint":"wrong"'),"fingerprint"],[dump,"empty"]] as const){
      const target=await sqlite();try{if(needle==="empty")target.db.query("INSERT INTO site_config(key,value) VALUES('existing','value')").run();await expect(target.app.importStore(target.handle,stream(variant))).rejects.toMatchObject({code:"DUMP_INVALID"});expect(target.db.query("SELECT COUNT(*) AS n FROM items").get()).toEqual({n:0});}finally{target.db.close();}
    }
    const corrupted=dump.replace(/"sha256":"[a-f0-9]+"/,'"sha256":"wrong"');
    for(const flavor of ["bun-sqlite","cloudflare-d1"] as const){const target=await sqlite(flavor);try{await expect(target.app.importStore(target.handle,stream(corrupted))).rejects.toMatchObject({code:flavor==="bun-sqlite"?"DUMP_INVALID":"IMPORT_INCOMPLETE"});expect((target.db.query("SELECT COUNT(*) AS n FROM items").get() as {n:number}).n).toBe(flavor==="bun-sqlite"?0:60);}finally{target.db.close();}}
  }finally{source.db.close();}
});

test("NDJSON parser refuses invalid UTF-8, oversize lines, duplicate keys, missing footer and unsafe integer rows",async()=>{
  const source=await sqlite();try{
    await seed(source);const dump=await exported(source),lines=dump.trimEnd().split("\n"),row=JSON.parse(lines[2]!);
    const units=source.app.transferPlan.tables[0].columns.findIndex((c:any)=>c[0]==="units");row[units]="9223372036854775808";
    const invalid=["null\n",JSON.stringify(JSON.parse(lines[0]!))+"\n"+'x'.repeat(1_048_577)+"\n",[...lines.slice(0,3),lines[2],...lines.slice(3)].join("\n")+"\n",lines.slice(0,-1).join("\n")+"\n",[...lines.slice(0,2),JSON.stringify(row),...lines.slice(3)].join("\n")+"\n"];
    for(const text of invalid){const target=await sqlite();try{await expect(target.app.importStore(target.handle,stream(text))).rejects.toBeInstanceOf(Error);expect(target.db.query("SELECT COUNT(*) AS n FROM items").get()).toEqual({n:0});}finally{target.db.close();}}
    const target=await sqlite();try{const bytes=new ReadableStream<Uint8Array>({start(c){c.enqueue(new Uint8Array([0xff]));c.close();}});await expect(target.app.importStore(target.handle,bytes)).rejects.toBeInstanceOf(Error);}finally{target.db.close();}
  }finally{source.db.close();}
});

test("portable JSON keeps scalar types and refuses duplicate keys or excessive nesting",async()=>{
  const source=await sqlite();try{
    await seed(source);
    for(const raw of ['[9007199254740993,1.234567890123456789,"text",null]', '{"a":{"same":1},"b":{"same":2},"__proto__":{"value":9007199254740993}}', '"scalar"', 'true', 'null']){
      source.db.query("UPDATE items SET payload=? WHERE id='row-000'").run(raw);const target=await sqlite();try{
        const dump=await exported(source);await target.app.importStore(target.handle,stream(dump));expect(await exported(target)).toBe(dump);
      }finally{target.db.close();}
    }
    for(const raw of ['{"a":1,"a":2}', '{"a":1,"\\u0061":2}', '['.repeat(66)+'0'+']'.repeat(66)]){
      source.db.query("UPDATE items SET payload=? WHERE id='row-000'").run(raw);await expect(exported(source)).rejects.toMatchObject({code:"DUMP_INVALID"});
    }
  }finally{source.db.close();}
});

test("SQLite non-null temporal values outside native formatting range cannot export as NULL",async()=>{
  const source=await sqlite();try{
    await seed(source);
    for(const [column,literal] of [["optional_day","3000000"],["expires","CAST('9223372036854775807' AS INTEGER)"],["published_at","CAST('-9223372036854775808' AS INTEGER)"]] as const){
      source.db.exec(`UPDATE items SET "${column}"=${literal} WHERE id='row-000'`);
      expect(source.db.query(`SELECT "${column}" IS NULL AS nil FROM items WHERE id='row-000'`).get()).toEqual({nil:0});
      await expect(exported(source)).rejects.toMatchObject({code:"SQL_TYPE"});
      source.db.exec(`UPDATE items SET "${column}"=NULL WHERE id='row-000'`);
    }
    await expect(exported(source)).resolves.toContain('"complete":true');
  }finally{source.db.close();}
});

(process.env.MANTLE_NEXT_BUN_PG_URL?test:test.skip)("PostgreSQL nullable dates, timestamps and auth dates refuse infinity/BCE without altering real NULL",async()=>{
  const options={user:{additionalFields:{holiday:{type:"date" as const,required:false}}}},source=await sqlite("bun-sqlite",options),target=await postgres(options);try{
    await seed(source);const original=await exported(source);await target.app.importStore(target.handle,stream(original));
    for(const [table,column,literal] of [["items","optional_day","DATE '0001-01-01 BC'"],["items","optional_day","DATE 'infinity'"],["items","optional_day","DATE '-infinity'"],["items","expires","TIMESTAMPTZ '2000-01-01 00:00:00+00 BC'"],["items","expires","TIMESTAMPTZ 'infinity'"],["items","expires","TIMESTAMPTZ '-infinity'"],["user","holiday","TIMESTAMPTZ '2000-01-01 00:00:00+00 BC'"],["user","holiday","TIMESTAMPTZ 'infinity'"],["user","holiday","TIMESTAMPTZ '-infinity'"]] as const){
      const id=table==="items"?"row-001":"member";
      await target.db.unsafe(`UPDATE "${table}" SET "${column}"=${literal} WHERE id=$1`,[id]);
      expect((await target.db.unsafe(`SELECT "${column}" IS NULL AS nil FROM "${table}" WHERE id=$1`,[id]))[0].nil).toBe(false);
      await expect(exported(target)).rejects.toMatchObject({code:"SQL_TYPE"});
      await target.db.unsafe(`UPDATE "${table}" SET "${column}"=NULL WHERE id=$1`,[id]);
    }
    expect(body(await exported(target))).toBe(body(original));
  }finally{source.db.close();await target.close();}
},60_000);

test("transfer modules stay out of an ordinary request bundle",async()=>{
  const f=await fixture("cloudflare-d1");
  // Build an actual generated View, whose graph has no dump entry or node:crypto dependency.
  const entry=resolve(directory,"no-transfer.ts");await Bun.write(entry,f.files["generated.ts"]!.replace(/"@aotter\/mantle-next\/([^\"]+)"/g,(_,p)=>JSON.stringify(resolve(import.meta.dir,"../src/kernel",p+".ts"))));
  const request=await Bun.build({entrypoints:[entry],target:"browser",sourcemap:"external"});expect(request.success).toBe(true);expect((await request.outputs.find(o=>o.path.endsWith(".map"))!.json()).sources.some((p:string)=>p.endsWith("/transfer.ts"))).toBe(false);
});

test("configured auth model and field renames retain FK order and omit the renamed session table",async()=>{
  const options={...auth(),user:{modelName:"members",fields:{name:"display_name",createdAt:"created_on",updatedAt:"updated_on"}},session:{modelName:"member_sessions"}};
  const source=await sqlite("bun-sqlite",options),target=await sqlite("bun-sqlite",options);try{
    source.db.query('INSERT INTO members(id,display_name,email,emailVerified,created_on,updated_on) VALUES(?,?,?,?,?,?)').run("member","Member","member@example.test",1,"2026-10-12T00:00:00.123456Z","2026-10-12T00:00:00.123456Z");
    const dump=await exported(source);expect(JSON.parse(dump.split("\n")[0]!).omitted).toEqual(["member_sessions"]);await target.app.importStore(target.handle,stream(dump));expect(await exported(target)).toBe(dump);expect(target.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  }finally{source.db.close();target.db.close();}
});

test("required session references cannot silently lose linked data",async()=>{
  const options={plugins:[{id:"session-dependent",schema:{session_note:{fields:{sessionId:{type:"string",required:true,references:{model:"session",field:"id",onDelete:"cascade"}}}}}}]};
  await expect(fixture("bun-sqlite",options)).rejects.toThrow("session_note.sessionId");
});

(process.env.MANTLE_NEXT_BUN_PG_URL?test:test.skip)("configured UUID identities and foreign references remain canonical across targets",async()=>{
  const options={...auth(),advanced:{database:{generateId:"uuid" as const}}},source=await sqlite("bun-sqlite",options),target=await postgres(options);try{
    const id="12345678-1234-1234-1234-123456789abc",account="23456789-1234-1234-1234-123456789abc",at="2026-10-12T00:00:00.123456Z";
    source.db.query('INSERT INTO user(id,name,email,emailVerified,"createdAt","updatedAt") VALUES(?,?,?,?,?,?)').run(id,"Member","uuid@example.test",1,at,at);
    source.db.query('INSERT INTO account(id,"accountId","providerId","userId","createdAt","updatedAt") VALUES(?,?,?,?,?,?)').run(account,"member","email",id,at,at);
    const dump=await exported(source);await target.app.importStore(target.handle,stream(dump));expect(body(await exported(target))).toBe(body(dump));
  }finally{source.db.close();await target.close();}
},60_000);

(process.env.MANTLE_NEXT_BUN_PG_URL?test:test.skip)("portable text keys use binary order across case and supplementary Unicode characters",async()=>{
  const source=await sqlite(),target=await postgres();try{
    const keys=["A","a","Z","z","😀","\uE000"],at="2026-10-12T00:00:00.123456Z";
    for(const id of keys)source.db.query('INSERT INTO user(id,name,email,emailVerified,"createdAt","updatedAt") VALUES(?,?,?,?,?,?)').run(id,"Member",`${id}@example.test`,1,at,at);
    const dump=await exported(source);await target.app.importStore(target.handle,stream(dump));expect(body(await exported(target))).toBe(body(dump));
  }finally{source.db.close();await target.close();}
},60_000);

(process.env.MANTLE_NEXT_BUN_PG_URL?test:test.skip)("serial auth ids reset PostgreSQL identities; uncertain COMMIT stays OUTCOME_UNKNOWN after a real commit",async()=>{
  const options={...auth(),advanced:{database:{generateId:"serial" as const}}},source=await sqlite("bun-sqlite",options),target=await postgres(options);try{
    source.db.query('INSERT INTO user(id,name,email,emailVerified,"createdAt","updatedAt") VALUES(?,?,?,?,?,?)').run(12,"Member","member@example.test",1,"2026-10-12T00:00:00.123456Z","2026-10-12T00:00:00.123456Z");
    const dump=await exported(source),uncertain={unsafe:target.db.unsafe.bind(target.db),begin:async<T>(isolation:string,fn:(tx:any)=>Promise<T>)=>{await target.db.begin(isolation,fn);throw new Error("lost COMMIT reply");}};
    await expect(target.app.importStore(uncertain,stream(dump))).rejects.toMatchObject({code:"OUTCOME_UNKNOWN"});
    expect(body(await exported(target))).toBe(body(dump));
    const inserted=await target.db.unsafe('INSERT INTO "user"(name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$2,$3,CAST(CAST($4 AS text) AS timestamptz),CAST(CAST($4 AS text) AS timestamptz)) RETURNING id',["Next","next@example.test",true,"2026-10-12T00:00:00.000001Z"]);expect(inserted[0].id).toBe(13);
  }finally{source.db.close();await target.close();}
},60_000);

test("thin CLI uses an application-owned Node SQLite driver, private exclusive files and safe errors",async()=>{
  const {execFileSync}=await import("node:child_process"),{writeFile,readFile,stat}=await import("node:fs/promises"),{transform}=await import("esbuild");
  const f=await fixture("bun-sqlite",{},false),sourceFile=resolve(f.dir,"source.sqlite"),targetFile=resolve(f.dir,"target.sqlite"),dumpFile=resolve(f.dir,"dump.ndjson"),cli=resolve(import.meta.dir,"../dist/infrastructure/cli.js"),generated=resolve(f.dir,"transfer.js");
  const sourceDB=new Database(sourceFile);sourceDB.exec(f.ddl);await seed({...f,db:sourceDB,handle:sourceDB});sourceDB.close();const targetDB=new Database(targetFile);targetDB.exec(f.ddl);targetDB.close();
  await writeFile(generated,(await transform(f.files["transfer.ts"]!,{loader:"ts",format:"esm"})).code);
  const driver=async(name:string,path:string)=>{const file=resolve(f.dir,name);await writeFile(file,`import {DatabaseSync} from 'node:sqlite';const native=new DatabaseSync(${JSON.stringify(path)});export const db={query:sql=>({all:(...values)=>native.prepare(sql).all(Object.fromEntries(values.map((v,i)=>['?'+(i+1),v])))}),exec:native.exec.bind(native),transaction:()=>{throw Error('nested transaction');}};export const dispose=()=>native.close();`);return file;};
  const sourceDriver=await driver("source.js",sourceFile),targetDriver=await driver("target.js",targetFile);
  execFileSync("node",[cli,"export",generated,sourceDriver,dumpFile],{stdio:"pipe"});expect((await stat(dumpFile)).mode&0o777).toBe(0o600);execFileSync("node",[cli,"import",generated,targetDriver,dumpFile],{stdio:"pipe"});
  const output=execFileSync("node",[cli,"export",generated,targetDriver,"-"],{encoding:"utf8",stdio:"pipe"});expect(output).toBe(await readFile(dumpFile,"utf8"));
  expect(()=>execFileSync("node",[cli,"export",generated,sourceDriver,dumpFile],{stdio:"pipe"})).toThrow();
  const bad=resolve(f.dir,"bad.js"),secret="TEST_FAKE_CREDENTIAL_DO_NOT_LOG";await writeFile(bad,`throw Error(${JSON.stringify(secret)});`);
  try{execFileSync("node",[cli,"import",generated,bad,dumpFile],{stdio:"pipe"});throw Error("expected failure");}catch(error:any){expect(String(error.stderr)).not.toContain(secret);expect(String(error.stderr)).toContain("Storage transfer failed");}
},30_000);

(process.env.MANTLE_NEXT_TRANSFER_D1?test:test.skip)("actual local D1 imports/exports exact int64, auth/site rows and marks a bad import incomplete",async()=>{
  const {unstable_splitSqlQuery}=await import("wrangler"),{spawn}=await import("node:child_process"),{mkdtemp,open,writeFile,readFile}=await import("node:fs/promises"),{tmpdir}=await import("node:os"),{once}=await import("node:events");
  const source=await sqlite(),target=await fixture("cloudflare-d1"),privateDir=await mkdtemp(resolve(tmpdir(),"mantle-transfer-d1-")),port=process.env.MANTLE_NEXT_TRANSFER_PORT??"8996";
  let worker:ReturnType<typeof spawn>|undefined,exited:Promise<unknown>|undefined,log:Awaited<ReturnType<typeof open>>|undefined;
  try{
    await seed(source);const dump=await exported(source),ddl=unstable_splitSqlQuery(target.ddl),entry=resolve(target.dir,"worker.ts");
    await writeFile(entry,`import {exportStore,importStore} from ${JSON.stringify(resolve(target.dir,"transfer.ts"))};
const dump=${JSON.stringify(dump)},ddl=${JSON.stringify(ddl)};
const stream=text=>new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(text));c.close();}});
export default {async fetch(request,env){if(new URL(request.url).pathname==='/health')return new Response('ready');
try {for(const db of [env.DB,env.BROKEN])for(const sql of ddl)await db.prepare(sql).run();
const restored=await importStore(env.DB,stream(dump)),roundtrip=await new Response(exportStore(env.DB)).text();
let nonempty=false,incomplete=false;try{await importStore(env.DB,stream(dump));}catch(e){nonempty=e.code==='DUMP_INVALID';}
try{await importStore(env.BROKEN,stream(dump.replace(/"sha256":"[a-f0-9]+"/,'"sha256":"wrong"')));}catch(e){incomplete=e.code==='IMPORT_INCOMPLETE'&&e.fields?.incomplete===true;}
const nativeJSON=await env.DB.prepare("SELECT payload -> '$.int' AS integer,payload -> '$.decimal' AS decimal FROM items WHERE id='row-000'").first();
let temporalRefusals=0;for(const sql of ["UPDATE items SET optional_day=3000000 WHERE id='row-000'","UPDATE items SET optional_day=NULL,expires=CAST('9223372036854775807' AS INTEGER) WHERE id='row-000'"]){await env.DB.prepare(sql).run();try{await new Response(exportStore(env.DB)).text();}catch(e){if(e.code==='SQL_TYPE')temporalRefusals++;}}
return Response.json({restored,roundtrip,nonempty,incomplete,nativeJSON,temporalRefusals});}catch(e){return Response.json({error:e.code??'FAILED',message:e.message},{status:500});}}};`);
    const config=resolve(privateDir,"wrangler.json"),base=resolve(import.meta.dir,"..");
    await writeFile(config,JSON.stringify({name:"mantle-transfer-local",main:entry,compatibility_date:"2026-09-28",compatibility_flags:["nodejs_compat"],d1_databases:[{binding:"DB",database_name:"transfer-ok",database_id:"00000000-0000-0000-0000-000000001298"},{binding:"BROKEN",database_name:"transfer-bad",database_id:"00000000-0000-0000-0000-000000001299"}]}),{mode:0o600});
    log=await open(resolve(privateDir,"wrangler.log"),"w",0o600);
    worker=spawn("node",[resolve(base,"node_modules/wrangler/bin/wrangler.js"),"dev","--local","--config",config,"--ip","127.0.0.1","--port",port,"--inspector-port","0","--persist-to",resolve(privateDir,"state")],{cwd:base,detached:true,env:{...process.env,WRANGLER_SEND_METRICS:"false",NO_PROXY:"127.0.0.1,localhost",no_proxy:"127.0.0.1,localhost"},stdio:["ignore",log.fd,log.fd]});exited=once(worker,"exit");
    let ready=false;for(let i=0;i<60;i++){if(worker.exitCode!==null)throw Error(await readFile(resolve(privateDir,"wrangler.log"),"utf8"));try{ready=(await fetch(`http://127.0.0.1:${port}/health`,{signal:AbortSignal.timeout(1000)})).ok;}catch{}if(ready)break;await new Promise(r=>setTimeout(r,1000));}
    expect(ready).toBe(true);const response=await fetch(`http://127.0.0.1:${port}/verify`,{signal:AbortSignal.timeout(60_000)}),result=await response.json() as any;expect(response.status).toBe(200);expect(result).toEqual({restored:{rows:76},roundtrip:dump,nonempty:true,incomplete:true,nativeJSON:{integer:"9007199254740993",decimal:"1234567890123456789e-18"},temporalRefusals:2});
  }finally{source.db.close();if(worker?.pid){try{process.kill(-worker.pid,"SIGTERM");}catch{}await exited;}await log?.close();await rm(privateDir,{recursive:true,force:true});}
},90_000);
