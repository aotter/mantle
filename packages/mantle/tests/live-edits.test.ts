import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { SQL } from "bun";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { generateOrThrow, writeGenerated } from "./apps/link.js";
import { verifyOnLocalD1 } from "./apps/local-d1.js";
import { liveManifest, verifyLiveEdits } from "./lock-scenarios.js";

// #1822: a Store update keeps a published row publishable, for every caller, as `publish` itself checks required data.
const sources = [{ sourceId: "live.yaml", text: liveManifest }];

test("generation refuses spec.publishing outside lifecycle: publishing", async () => {
  const text = JSON.stringify({ apiVersion: "cms.mantle.aotter.net/v2", kind: "Schema", metadata: { name: "notes" }, spec: { title: "Notes", publishing: { liveEdits: true }, schema: { type: "object", properties: { body: { type: "string" } } } } });
  await expect(generateOrThrow("bun-sqlite", [{ sourceId: "x.yaml", text }])).rejects.toThrow(/SCHEMA_PUBLISHING_INVALID/);
});

test("bun:sqlite: a Store update keeps a published row publishable", async () => {
  const files = await generateOrThrow("bun-sqlite", sources), dir = await mkdtemp(resolve(import.meta.dir, "apps/.live-"));
  try {
    await writeGenerated(dir, files);
    const db = new Database(":memory:"); db.exec(files["schema.sql"]!);
    await verifyLiveEdits(await import(join(dir, "generated.ts")), db);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

(process.env.MANTLE_NEXT_BUN_PG_URL ? test : test.skip)("PostgreSQL: a Store update keeps a published row publishable", async () => {
  const files = await generateOrThrow("bun-postgres", sources), dir = await mkdtemp(resolve(import.meta.dir, "apps/.live-"));
  const sql = new SQL(process.env.MANTLE_NEXT_BUN_PG_URL!, { max: 1 }), schema = "live_" + crypto.randomUUID().replaceAll("-", "");
  try {
    await writeGenerated(dir, files);
    await sql.unsafe(`CREATE SCHEMA ${schema}`); await sql.unsafe(`SET search_path TO ${schema}`); await sql.unsafe(files["schema.sql"]!);
    await verifyLiveEdits(await import(join(dir, "generated.ts")), sql);
  } finally { await rm(dir, { recursive: true, force: true }); await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {}); await sql.close(); }
}, 30000);

(process.env.MANTLE_NEXT_REST_D1 ? test : test.skip)("local D1: a Store update keeps a published row publishable", async () => {
  const { unstable_splitSqlQuery } = await import("wrangler"), files = await generateOrThrow("cloudflare-d1", sources), dir = await mkdtemp(resolve(import.meta.dir, "apps/.live-"));
  try {
    await writeGenerated(dir, files);
    expect(await verifyOnLocalD1(dir, `import * as app from './generated.ts';import {verifyLiveEdits} from ${JSON.stringify(resolve(import.meta.dir, "lock-scenarios.ts"))};
export default{async fetch(request:Request,env:{DB:any}){if(new URL(request.url).pathname==='/health')return new Response('ready');try{for(const sql of ${JSON.stringify(unstable_splitSqlQuery(files["schema.sql"]!))})await env.DB.prepare(sql).run();
await verifyLiveEdits(app as any,env.DB);return Response.json({ok:true});}catch(error){return Response.json({error:String(error)},{status:500});}}};`, process.env.MANTLE_NEXT_LIVE_D1_PORT ?? "8994")).toEqual({ ok: true });
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 90000);
