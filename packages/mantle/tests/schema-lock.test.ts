import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { SQL } from "bun";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { generateOrThrow, writeGenerated } from "./apps/link.js";
import { verifyOnLocalD1 } from "./apps/local-d1.js";
import { lockManifest, verifyLock } from "./lock-scenarios.js";

// #1822: a Schema lock is a row rule every caller's generic update and delete carries; a trusted write does not.
const sources = [{ sourceId: "lock.yaml", text: lockManifest }];
const NOT = "NOT (EXISTS (SELECT 1 FROM posts AS _mantle_lock_0 WHERE _mantle_lock_0.current_revision = ";

test.each(["bun-sqlite", "cloudflare-d1", "bun-postgres"] as const)("%s: caller writes carry the lock, trusted ones do not", async target => {
  const files = await generateOrThrow(target, sources), code = files["generated.ts"]!;
  const line = (name: string) => code.split("\n").find(l => l.startsWith(`const ${name} =`))!;
  const procedures = Object.fromEntries([...code.matchAll(/\["(\w+)"\]: (procedure\d+)/g)].map(([, name, fn]) => [name, fn]));
  expect(line(`${procedures.edit_revision}Caller`)).toContain(`${NOT}post_revisions.id))`);
  expect(line(`${procedures.prune_revision}Caller`)).toContain(`${NOT}r.id))`);
  expect(line(`${procedures.edit_revision}Caller`)).toContain(`lock: {"sql":"SELECT CASE WHEN (EXISTS`);
  // the lock's relations read through reserved aliases, so the write's own alias (`p`, `posts`) names only the locked row
  expect(line(`${procedures.prune_as_p}Caller`)).toContain("NOT (EXISTS (SELECT 1 FROM posts AS _mantle_lock_0 WHERE _mantle_lock_0.current_revision = p.id)) AND NOT (EXISTS (SELECT 1 FROM posts AS _mantle_lock_0 WHERE _mantle_lock_0.current_revision = p.id))");
  expect(line(`${procedures.edit_as_posts}Caller`)).toContain("_mantle_lock_0.current_revision = posts.id");
  expect(line(`${procedures.upsert_revision}Caller`)).toContain("_mantle_lock_0.current_revision = p.id");
  // so does the probe that classifies the refusal
  expect(line(`${procedures.prune_as_p}Caller`)).toContain(`lock: {"sql":"SELECT CASE WHEN (EXISTS (SELECT 1 FROM posts AS _mantle_lock_0 WHERE _mantle_lock_0.current_revision = p.id)) IS NOT FALSE`);
  expect(line(`${procedures.edit_revision}Trusted`)).not.toContain("NOT (EXISTS");
  expect(line(`${procedures.prune_revision}Trusted`)).not.toContain("NOT (EXISTS");
  // posts has no lock: switching revisions is unchanged
  expect(line(`${procedures.switch_revision}Caller`)).not.toContain("NOT (");
});

test("bun:sqlite: Procedures and Stores cannot change a locked row", async () => {
  const files = await generateOrThrow("bun-sqlite", sources), dir = await mkdtemp(resolve(import.meta.dir, "apps/.lock-"));
  try {
    await writeGenerated(dir, files);
    const db = new Database(":memory:"); db.exec(files["schema.sql"]!);
    await verifyLock(await import(join(dir, "generated.ts")), db);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

(process.env.MANTLE_NEXT_BUN_PG_URL ? test : test.skip)("PostgreSQL: Procedures and Stores cannot change a locked row", async () => {
  const files = await generateOrThrow("bun-postgres", sources), dir = await mkdtemp(resolve(import.meta.dir, "apps/.lock-"));
  const sql = new SQL(process.env.MANTLE_NEXT_BUN_PG_URL!, { max: 1 }), schema = "lock_" + crypto.randomUUID().replaceAll("-", "");
  try {
    await writeGenerated(dir, files);
    await sql.unsafe(`CREATE SCHEMA ${schema}`); await sql.unsafe(`SET search_path TO ${schema}`); await sql.unsafe(files["schema.sql"]!);
    await verifyLock(await import(join(dir, "generated.ts")), sql);
  } finally { await rm(dir, { recursive: true, force: true }); await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {}); await sql.close(); }
}, 30000);

(process.env.MANTLE_NEXT_REST_D1 ? test : test.skip)("local D1: Procedures and Stores cannot change a locked row", async () => {
  const { unstable_splitSqlQuery } = await import("wrangler"), files = await generateOrThrow("cloudflare-d1", sources), dir = await mkdtemp(resolve(import.meta.dir, "apps/.lock-"));
  try {
    await writeGenerated(dir, files);
    expect(await verifyOnLocalD1(dir, `import * as app from './generated.ts';import {verifyLock} from ${JSON.stringify(resolve(import.meta.dir, "lock-scenarios.ts"))};
export default{async fetch(request:Request,env:{DB:any}){if(new URL(request.url).pathname==='/health')return new Response('ready');try{for(const sql of ${JSON.stringify(unstable_splitSqlQuery(files["schema.sql"]!))})await env.DB.prepare(sql).run();
await verifyLock(app as any,env.DB);return Response.json({ok:true});}catch(error){return Response.json({error:String(error)},{status:500});}}};`, process.env.MANTLE_NEXT_LOCK_D1_PORT ?? "8993")).toEqual({ ok: true });
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 90000);
