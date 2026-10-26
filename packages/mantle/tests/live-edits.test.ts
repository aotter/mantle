import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { SQL } from "bun";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { generateOrThrow, writeGenerated } from "./apps/link.js";
import { admin, outcome, system } from "./lock-scenarios.js";

// #1822: a Store update keeps a published row publishable, for every caller, as `publish` itself checks required data.
const m = (name: string, spec: object) => JSON.stringify({ apiVersion: "cms.mantle.aotter.net/v2", kind: "Schema", metadata: { name }, spec });
const sources = [{ sourceId: "live.yaml", text: [
  m("articles", { title: "Articles", lifecycle: "publishing", publishing: { liveEdits: true }, schema: { type: "object", required: ["title"], properties: { title: { type: "string" }, body: { type: "string" } } } }),
].join("\n---\n") }];

async function verify(app: { procedures: Record<string, (db: any, caller: any, input: object) => Promise<any>>; store: (db: any, caller: any) => any }, db: unknown) {
  const articles = (caller: unknown) => app.store(db, caller).collection("articles");
  const draft = await articles(admin).insert({ title: "t", body: "b" });
  // a draft may be incomplete
  const cleared = await articles(admin).update(draft.id, { title: null }, { lock: draft.version });
  const restored = await articles(admin).update(draft.id, { title: "t" }, { lock: cleared.version });
  await app.procedures["articles.publish"]!(db, admin, { id: draft.id, expectedVersion: restored.version });
  const live = await articles(admin).findById(draft.id);
  expect(live.status).toBe("published");
  for (const caller of [admin, system]) expect(await outcome(() => articles(caller).update(draft.id, { title: null }, { lock: live.version }))).toBe("INPUT_VALIDATION_FAILED");
  const edited = await articles(admin).update(draft.id, { body: "edited" }, { lock: live.version });
  expect(edited).toMatchObject({ status: "published", body: "edited", published_at: live.published_at, version: live.version + 1 });
  // a stale version on a publishable update stays the row conflict
  expect(await outcome(() => articles(admin).update(draft.id, { body: "x" }, { lock: live.version }))).toBe("CONFLICT:row");
}

test("generation refuses spec.publishing outside lifecycle: publishing", async () => {
  await expect(generateOrThrow("bun-sqlite", [{ sourceId: "x.yaml", text: m("notes", { title: "Notes", publishing: { liveEdits: true }, schema: { type: "object", properties: { body: { type: "string" } } } }) }])).rejects.toThrow(/SCHEMA_PUBLISHING_INVALID/);
});

test("bun:sqlite: a Store update keeps a published row publishable", async () => {
  const files = await generateOrThrow("bun-sqlite", sources), dir = await mkdtemp(resolve(import.meta.dir, "apps/.live-"));
  try {
    await writeGenerated(dir, files);
    const db = new Database(":memory:"); db.exec(files["schema.sql"]!);
    await verify(await import(join(dir, "generated.ts")), db);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

(process.env.MANTLE_NEXT_BUN_PG_URL ? test : test.skip)("PostgreSQL: a Store update keeps a published row publishable", async () => {
  const files = await generateOrThrow("bun-postgres", sources), dir = await mkdtemp(resolve(import.meta.dir, "apps/.live-"));
  const sql = new SQL(process.env.MANTLE_NEXT_BUN_PG_URL!, { max: 1 }), schema = "live_" + crypto.randomUUID().replaceAll("-", "");
  try {
    await writeGenerated(dir, files);
    await sql.unsafe(`CREATE SCHEMA ${schema}`); await sql.unsafe(`SET search_path TO ${schema}`); await sql.unsafe(files["schema.sql"]!);
    await verify(await import(join(dir, "generated.ts")), sql);
  } finally { await rm(dir, { recursive: true, force: true }); await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {}); await sql.close(); }
}, 30000);
