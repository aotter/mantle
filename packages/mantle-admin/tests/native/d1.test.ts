import { startLocalD1 } from "../../../mantle/tests/apps/local-d1.js";
import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { generateAdmin, writeAdminFixture } from "./generated-fixture.js";
import { refManifest } from "./server-native-scenarios.js";
(process.env.MANTLE_ADMIN_LOCAL_D1 ? test : test.skip)(
  "thin Admin API on actual local D1 retains scope/OCC/transition and one-read paging",
  async () => {
    const base = resolve(import.meta.dir, "../../../mantle"),
      dir = await mkdtemp(join(base, "tests/apps/.thin-admin-d1-")),
      privateDir = await mkdtemp(join(tmpdir(), "thin-admin-d1-")),
      port = process.env.MANTLE_ADMIN_D1_PORT ?? "9126";
    let stop: (() => Promise<void>) | undefined;
    try {
      const files = await generateAdmin("cloudflare-d1", refManifest);
      await writeAdminFixture(dir, files);
      const { unstable_splitSqlQuery } = await import("../../../mantle/node_modules/wrangler");
      await writeFile(
        join(dir, "worker.ts"),
        `import {adminBindings} from './admin-bindings.js';import {verifyAdminBindings,handlers} from ${JSON.stringify(resolve(import.meta.dir, "server-native-scenarios.ts"))};
export default{async fetch(request,env){if(new URL(request.url).pathname==='/health')return new Response('ready');try{
 for(const sql of ${JSON.stringify(unstable_splitSqlQuery(files["schema.sql"]!))})await env.DB.prepare(sql).run();
 let reads=0;const db={prepare(sql){const statement=env.DB.prepare(sql);return{original:statement,bind(...values){const bound=statement.bind(...values);return{original:bound,all(){reads++;return bound.all();}};}}},batch(statements){return env.DB.batch(statements.map(s=>s.original));}};
 return Response.json(await verifyAdminBindings(adminBindings({handlers}),db,()=>reads));}catch(error){console.error(error);return Response.json({error:String(error)},{status:500});}}};`,
      );
      const config = join(privateDir, "wrangler.json");
      await writeFile(
        config,
        JSON.stringify({
          name: "mantle-admin-native-local",
          main: join(dir, "worker.ts"),
          compatibility_date: "2026-09-28",
          compatibility_flags: ["nodejs_compat"],
          d1_databases: [
            {
              binding: "DB",
              database_name: "mantle-admin-native-local",
              database_id: "00000000-0000-0000-0000-000000000001",
            },
          ],
        }),
      );
      const running = await startLocalD1(config, port, privateDir);
      stop = running.stop;
      const response = await fetch(`http://127.0.0.1:${port}/verify`, { signal: AbortSignal.timeout(30000) });
      expect(await response.json()).toEqual({ ok: true, checks: 14 });
      expect(response.status).toBe(200);
    } finally {
      await stop?.();
      await rm(dir, { recursive: true, force: true });
      await rm(privateDir, { recursive: true, force: true });
    }
  },
  90000,
);
