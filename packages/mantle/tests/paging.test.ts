import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateOrThrow, writeGenerated } from "./apps/link.js";
import { ContractError, statusOf, wire } from "../src/kernel/contracts.js";
const source = `apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: {name: items}
spec:
  title: Items
  lifecycle: operational
  indexes: [[rank]]
  schema:
    type: object
    required: [rank]
    properties: {rank: {type: integer}}
---
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: {name: items}
spec:
  surface: public
  sql: SELECT id, rank FROM items ORDER BY rank, id LIMIT 2
`;
test("selected View pages ties across three pages, caps limit and refuses foreign/malformed cursors", async () => {
  const files = await generateOrThrow("bun-sqlite", [{ sourceId: "items.yaml", text: source }]);
  expect(files["paged/views/items.ts"]).not.toContain("_k2");
  const aliased=await generateOrThrow("bun-sqlite",[{sourceId:"alias.yaml",text:source.replace("SELECT id, rank FROM items ORDER BY rank, id", "SELECT rank AS id FROM items ORDER BY id")}]);
  expect(aliased["paged/views/items.ts"]).toContain("_k1");
  const dir = await mkdtemp(join(tmpdir(), "mantle-page-")), db = new Database(":memory:");
  try {
    await writeGenerated(dir, files);
    const { default: page } = await import(join(dir, "paged/views/items.ts"));
    db.exec(files["schema.sql"]!);
    for (let i = 0; i < 6; i++) db.query("INSERT INTO items(id,version,created_at,updated_at,rank) VALUES (?,1,0,0,?)").run(String(i), Math.floor(i / 3));
    const caller = { kind: "anonymous" };
    const first = await page(db, caller, {alpha:1,beta:2}, { limit: 100 });
    expect(JSON.parse(decodeURIComponent(first.nextCursor))[2]).toBe("views/items");
    expect(first.rows.map((r: any) => r.id)).toEqual(["0", "1"]);
    const second = await page(db, caller, {beta:2,alpha:1}, { cursor: first.nextCursor });
    expect(second.rows.map((r: any) => r.id)).toEqual(["2", "3"]);
    const third = await page(db, caller, {}, { cursor: second.nextCursor });
    expect(third).toEqual({ rows: [{ id: "4", rank: 1 }, { id: "5", rank: 1 }] });
    for (const cursor of ["%", "[]", encodeURIComponent(JSON.stringify([0,"1","views/other[]"])), encodeURIComponent(JSON.stringify([null,"1","views/items[]"]))]) await expect(page(db, caller, {}, { cursor })).rejects.toMatchObject({ code: "INPUT_VALIDATION_FAILED", path: "views/items/cursor" });
    for (const limit of [0, -1, 1.5, Infinity]) await expect(page(db, caller, {}, { limit })).rejects.toMatchObject({ code: "INPUT_VALIDATION_FAILED" });
  } finally { db.close(); await rm(dir, { recursive: true, force: true }); }
});
test("exposed paging refuses nullable or unindexed order keys at generation", async () => {
  const { generateFromSources } = await import("../src/infrastructure/generate.js");
  for (const text of [source.replace("indexes: [[rank]]", "indexes: []"), source.replace("required: [rank]", "required: []")]) {
    const result = await generateFromSources({ target: "bun-sqlite", sources: { sources: [{ sourceId: "bad.yaml", text }] } });
    expect(result).toMatchObject({ ok: false, diagnostics: [{ code: "GENERATE_UNSUPPORTED", path: "views/items" }] });
  }
});
test("wire preserves contract fields/status and hides native errors", () => {
  for (const [code, status] of Object.entries({ INPUT_VALIDATION_FAILED:400, UNAUTHENTICATED:401, AUTH_DENIED:403, NOT_FOUND:404, METHOD_NOT_ALLOWED:405, CONFLICT:409, OUTCOME_UNKNOWN:503 })) {
    expect(statusOf(code)).toBe(status);
    expect(wire(new ContractError(code,"message","input/name"))).toEqual({status,error:{code,message:"message",path:"input/name"}});
  }
  expect(wire(new Error("secret SQL"))).toEqual({status:500,error:{code:"INTERNAL_ERROR",message:"An internal error occurred.",path:""}});
  expect(wire(new ContractError("SQL_TYPE", "secret-value", "secret-path"))).toEqual(wire(new Error()));
  expect(statusOf("SQL_TYPE")).toBe(500);
  expect(statusOf("toString")).toBe(500);
});

test("date-time keyset retains wire microseconds across SQLite pages", async () => {
  const text = source.replace("indexes: [[rank]]", "indexes: [[at]]").replace("required: [rank]", "required: [at]").replace("properties: {rank: {type: integer}}", "properties: {at: {type: string, format: date-time}}").replace("SELECT id, rank FROM items ORDER BY rank, id LIMIT 2", "SELECT i.id, i.at FROM items i ORDER BY i.at DESC, i.id DESC LIMIT 2");
  const files = await generateOrThrow("bun-sqlite", [{ sourceId: "dates.yaml", text }]);
  const dir = await mkdtemp(join(tmpdir(), "mantle-date-page-")), db = new Database(":memory:");
  try {
    await writeGenerated(dir, files);
    const { default: page } = await import(join(dir, "paged/views/items.ts"));
    db.exec(files["schema.sql"]!);
    for (let i = 0; i < 5; i++) db.query("INSERT INTO items(id,version,created_at,updated_at,at) VALUES (?,1,0,0,?)").run(String(i), 1791676800123456 + i);
    const first = await page(db, {kind:"anonymous"}, {});
    expect(first.rows).toEqual([{id:"4",at:"2026-10-11T00:00:00.123460Z"},{id:"3",at:"2026-10-11T00:00:00.123459Z"}]);
    const forged = JSON.parse(decodeURIComponent(first.nextCursor)); forged[0] = "not a date";
    await expect(page(db, {kind:"anonymous"}, {}, {cursor:encodeURIComponent(JSON.stringify(forged))})).rejects.toMatchObject({code:"INPUT_VALIDATION_FAILED",path:"views/items/cursor"});
    const second = await page(db, {kind:"anonymous"}, {}, {cursor:first.nextCursor});
    expect(second.rows.map((r:any)=>r.id)).toEqual(["2","1"]);
    const third = await page(db, {kind:"anonymous"}, {}, {cursor:second.nextCursor});
    expect(third).toEqual({rows:[{id:"0",at:"2026-10-11T00:00:00.123456Z"}]});
  } finally {db.close();await rm(dir,{recursive:true,force:true});}
  const postgres = await generateOrThrow("bun-postgres", [{sourceId:"dates.yaml",text}]);
  expect(postgres["paged/views/items.ts"]).toContain("AS text) AS timestamptz)");
});

test("TTL clock changes do not invalidate a View cursor", async () => {
  const text = source.replace("indexes: [[rank]]", "indexes: [[rank]]\n  ttl: {field: expiresAt, expireAfterSeconds: 0}").replace("properties: {rank: {type: integer}}", "properties: {rank: {type: integer}, expiresAt: {type: string, format: date-time, nullable: true}}");
  const files = await generateOrThrow("bun-sqlite", [{sourceId:"ttl.yaml",text}]);
  const dir = await mkdtemp(join(tmpdir(),"mantle-ttl-page-")), db = new Database(":memory:"), clock=Date.now;
  try {
    await writeGenerated(dir,files);
    const {default:page}=await import(join(dir,"paged/views/items.ts"));
    db.exec(files["schema.sql"]!);
    for(let i=0;i<4;i++)db.query("INSERT INTO items(id,version,created_at,updated_at,rank,expiresat) VALUES (?,1,0,0,0,?)").run(String(i),clock()*1000+1e12);
    Date.now=()=>1000;
    const first=await page(db,{kind:"anonymous"},{});
    Date.now=()=>2000;
    expect((await page(db,{kind:"anonymous"},{},{cursor:first.nextCursor})).rows.map((r:any)=>r.id)).toEqual(["2","3"]);
  } finally {Date.now=clock;db.close();await rm(dir,{recursive:true,force:true});}
});

for (const [type,invalid,valid] of [["integer",["abc",true,1e30],[12,"12"]],["boolean",["abc",12],[true,false]]] as const) test(`PostgreSQL ${type} cursor keys fail before driver SQL`,async()=>{
  const text=source.replace("rank: {type: integer}",`rank: {type: ${type}}`);
  const files=await generateOrThrow("bun-postgres",[{sourceId:"cursor.yaml",text}]);
  const dir=await mkdtemp(join(tmpdir(),"mantle-forged-cursor-"));
  try {
    await writeGenerated(dir,files);
    const {default:page}=await import(join(dir,"paged/views/items.ts"));
    let calls=0;const db={unsafe:async()=>{calls++;return[];}};
    for(const key of invalid)await expect(page(db,{kind:"anonymous"},{},{cursor:encodeURIComponent(JSON.stringify([key,"id","views/items"]))})).rejects.toMatchObject({code:"INPUT_VALIDATION_FAILED",path:"views/items/cursor"});
    expect(calls).toBe(0);
    for(const key of valid)await page(db,{kind:"anonymous"},{},{cursor:encodeURIComponent(JSON.stringify([key,"id","views/items"]))});
    expect(calls).toBe(valid.length);
  } finally {await rm(dir,{recursive:true,force:true});}
});

test.skipIf(!process.env.MANTLE_NEXT_BUN_PG_URL)("real PostgreSQL rejects forged cursor keys as 400 before SQL",async()=>{
  const {SQL}=await import("bun"), sql=new SQL(process.env.MANTLE_NEXT_BUN_PG_URL!);
  const dir=await mkdtemp(join(tmpdir(),"mantle-native-cursor-"));
  try {
    for(const [type,storage,invalid] of [["integer","bigint",["abc",true,1e30]],["boolean","boolean",["abc",12]]] as const) {
      const files=await generateOrThrow("bun-postgres",[{sourceId:"native-cursor.yaml",text:source.replace("rank: {type: integer}",`rank: {type: ${type}}`)}]);
      const destination=join(dir,type);await writeGenerated(destination,files);
      const {default:page}=await import(join(destination,"paged/views/items.ts"));
      await sql.begin(async(tx)=>{
        await tx.unsafe(`CREATE TEMP TABLE items (id text, version bigint, created_at timestamptz, updated_at timestamptz, author_id text, rank ${storage}) ON COMMIT DROP`);
        let calls=0;const db={unsafe:(text:string,values:any[])=>{calls++;return tx.unsafe(text,values);}};
        for(const key of invalid) {
          let caught:unknown;try {await page(db,{kind:"anonymous"},{},{cursor:encodeURIComponent(JSON.stringify([key,"id","views/items"]))});}catch(error){caught=error;}
          expect(wire(caught)).toMatchObject({status:400,error:{code:"INPUT_VALIDATION_FAILED",path:"views/items/cursor"}});
        }
        expect(calls).toBe(0);
        await page(db,{kind:"anonymous"},{},{cursor:encodeURIComponent(JSON.stringify([type==="integer"?"12":true,"id","views/items"]))});
        expect(calls).toBe(1);
      });
    }
  } finally {await sql.close();await rm(dir,{recursive:true,force:true});}
});
