import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { SQL } from "bun";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { generateOrThrow, loadFixtureSources, writeGenerated } from "./apps/link.js";
import { verifyOnLocalD1 } from "./apps/local-d1.js";
import { verifyGlobalUnique } from "./global-unique-scenarios.js";

// docs/handbook/reference/schema.md, "A value unique across all owners": its manifests are apps/global-unique.yaml.
const base = resolve(import.meta.dir, ".."),
  port = process.env.MANTLE_NEXT_GLOBAL_UNIQUE_D1_PORT ?? "8991";
const composition = `import {userCaller} from '${resolve(base, "src/kernel/user-caller.ts")}';import {rest} from './rest.js';
const api=rest({db:(env:{DB:any})=>env.DB,caller:async(request:Request)=>userCaller({id:request.headers.get("x-user")!},{credential:"oauth"}),handlers:{}});
export const app=(request:Request,env:{DB:any})=>api(request,env);`;

async function fixture(target: "bun-sqlite" | "bun-postgres" | "cloudflare-d1") {
  const files = await generateOrThrow(target, await loadFixtureSources("global-unique.yaml")),
    dir = await mkdtemp(join(base, "tests/apps/.global-unique-"));
  await writeGenerated(dir, files);
  await writeFile(join(dir, "app.ts"), composition);
  return { dir, files };
}

test("the schema reference's manifests are this test's fixture, minus its REST Triggers", async () => {
  const documents = (text: string) =>
    text
      .split(/\n---\n/)
      .map(doc => doc.replace(/^(#.*\n)+/, "").trim())
      .filter(doc => !/kind: Trigger/.test(doc));
  const reference = await readFile(resolve(base, "../../docs/handbook/reference/schema.md"), "utf8");
  const section = reference.split("### A value unique across all owners")[1]!.split(/\n##+ /)[0]!;
  const blocks = [...section.matchAll(/^```yaml\n([\s\S]*?)^```$/gm)].flatMap(match => documents(match[1]!));
  expect(blocks).toEqual(documents((await loadFixtureSources("global-unique.yaml"))[0]!.text));
});

test("bun:sqlite: a registry Schema keeps a value unique across organizations", async () => {
  const { dir, files } = await fixture("bun-sqlite");
  try {
    const db = new Database(":memory:");
    db.exec(files["schema.sql"]!);
    const { app } = await import(join(dir, "app.ts"));
    await verifyGlobalUnique(
      request => app(request, { DB: db }),
      async sql => db.query(sql).all() as Record<string, unknown>[],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

(process.env.MANTLE_NEXT_BUN_PG_URL ? test : test.skip)(
  "PostgreSQL: a registry Schema keeps a value unique across organizations",
  async () => {
    const { dir, files } = await fixture("bun-postgres"),
      sql = new SQL(process.env.MANTLE_NEXT_BUN_PG_URL!, { max: 1 }),
      schema = "global_unique_" + crypto.randomUUID().replaceAll("-", "");
    try {
      await sql.unsafe(`CREATE SCHEMA ${schema}`);
      await sql.unsafe(`SET search_path TO ${schema}`);
      await sql.unsafe(files["schema.sql"]!);
      const { app } = await import(join(dir, "app.ts"));
      await verifyGlobalUnique(
        request => app(request, { DB: sql }),
        async text => [...(await sql.unsafe(text))],
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
      await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
      await sql.close();
    }
  },
  30000,
);

(process.env.MANTLE_NEXT_REST_D1 ? test : test.skip)(
  "local D1: a registry Schema keeps a value unique across organizations, each program one batch",
  async () => {
    const { unstable_splitSqlQuery } = await import("wrangler"),
      { dir, files } = await fixture("cloudflare-d1");
    try {
      expect(
        await verifyOnLocalD1(
          dir,
          `${composition}\nimport {verifyGlobalUnique} from ${JSON.stringify(resolve(import.meta.dir, "global-unique-scenarios.ts"))};
export default{async fetch(request:Request,env:{DB:any}){if(new URL(request.url).pathname==='/health')return new Response('ready');try{for(const sql of ${JSON.stringify(unstable_splitSqlQuery(files["schema.sql"]!))})await env.DB.prepare(sql).run();
await verifyGlobalUnique(request=>app(request,env),async sql=>(await env.DB.prepare(sql).all()).results);return Response.json({ok:true});}catch(error){return Response.json({error:String(error)},{status:500});}}};`,
          port,
        ),
      ).toEqual({ ok: true });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
  90000,
);
