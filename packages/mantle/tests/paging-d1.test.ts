import { startLocalD1 } from "./apps/local-d1.js";
import { fixtureCaller } from "./apps/fixtures.js";
import { test, expect } from "bun:test";
import { mkdtemp, writeFile, rm, open } from "node:fs/promises";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { generateOrThrow, writeGenerated, loadFixtureSources } from "./apps/link.js";
import { verifyPaging, pagingSeed } from "./paging-scenarios.js";
(process.env.MANTLE_NEXT_PAGING_D1 ? test : test.skip)(
  "actual local D1 pages use one query per request and match the native oracle",
  async () => {
    const { unstable_splitSqlQuery } = await import("wrangler"),
      base = resolve(import.meta.dir, ".."),
      dir = await mkdtemp(join(base, "tests/apps/.paging-d1-")),
      state = await mkdtemp(join(tmpdir(), "mantle-paging-d1-")),
      port = process.env.MANTLE_NEXT_PAGING_PORT ?? "8995";
    let stop: (() => Promise<void>) | undefined;
    try {
      const sources = await loadFixtureSources("paging.yaml");
      const extra =
        "\n---\napiVersion: cms.mantle.aotter.net/v2\nkind: View\nmetadata: {name: integer-groups}\nspec:\n  surface: public\n  sql: SELECT block,MIN(position) AS low,'literal?1' AS literal FROM positions GROUP BY block ORDER BY MIN(position),block\n";
      const files = await generateOrThrow("cloudflare-d1", [{ ...sources[0]!, text: sources[0]!.text + extra }]);
      await writeGenerated(dir, files, false);
      const names = [
        "ordered",
        "mixed",
        "grouped",
        "grouped-time",
        "window-groups",
        "joined",
        "lookup",
        "singleton",
        "integer-groups",
      ];
      await writeFile(
        join(dir, "worker.ts"),
        `${names.map((name, i) => `import p${i} from './paged/views/${name}.js';`).join("\n")}
const pages={${names.map((name, i) => `${JSON.stringify(name)}:p${i}`).join(",")}};
export default{async fetch(request:Request,env:{DB:any}){const path=new URL(request.url).pathname;if(path==='/health')return new Response('ready');try{if(path==='/seed'){for(const sql of ${JSON.stringify(unstable_splitSqlQuery(files["schema.sql"]! + ";" + pagingSeed(false)))})await env.DB.prepare(sql).run();return Response.json({ok:true});}const args:any=await request.json();if(path==='/native')return Response.json((await env.DB.prepare(args.sql).all()).results);let calls=0;const db={prepare(sql:string){calls++;return env.DB.prepare(sql)}};const rows=await pages[args.name](db,args.caller,args.input,args.options);return Response.json({rows,calls});}catch(error){return Response.json({error:{code:(error as any).code,message:String(error)}},{status:400});}}};`,
      );
      const config = join(state, "wrangler.json");
      await writeFile(
        config,
        JSON.stringify({
          name: "mantle-paging-local",
          main: join(dir, "worker.ts"),
          compatibility_date: "2026-09-28",
          compatibility_flags: ["nodejs_compat"],
          d1_databases: [
            {
              binding: "DB",
              database_name: "mantle-paging-local",
              database_id: "00000000-0000-0000-0000-000000000001",
            },
          ],
        }),
      );
      const running = await startLocalD1(config, port, state);
      stop = running.stop;
      const origin = `http://127.0.0.1:${port}`;
      expect(await (await fetch(origin + "/seed")).json()).toEqual({ ok: true });
      let calls = 0;
      const post = async (path: string, body: unknown) => {
        const result: any = await (await fetch(origin + path, { method: "POST", body: JSON.stringify(body) })).json();
        if (result.error) throw Object.assign(Error(result.error.message), { code: result.error.code });
        return result;
      };
      const pages: Record<string, Function> = {};
      for (const name of names)
        pages[name] = async (_: unknown, caller: unknown, input: unknown, options: unknown) => {
          const result = await post("/page", { name, caller, input, options });
          calls += result.calls;
          return result.rows;
        };
      await verifyPaging(
        pages,
        null,
        sql => post("/native", { sql }),
        () => calls,
        false,
      );
      const caller = fixtureCaller({
          kind: "user",
          subject: "a",
          role: null,
          scopes: [],
          credential: "api-key",
          credentialId: null,
          clientId: null,
        }),
        args = { name: "integer-groups", caller, input: {} };
      const first = await post("/page", { ...args, options: { limit: 1 } }),
        tuple = JSON.parse(decodeURIComponent(first.rows.nextCursor));
      expect(first.calls).toBe(1);
      const cursor = (text: boolean) =>
        encodeURIComponent(
          JSON.stringify(tuple.map((v: any, i: number) => (i < 2 ? (text ? String(v) : Number(v)) : v))),
        );
      const number = await post("/page", { ...args, options: { limit: 1, cursor: cursor(false) } }),
        text = await post("/page", { ...args, options: { limit: 1, cursor: cursor(true) } });
      expect(text.rows).toEqual(number.rows);
      expect(text.rows.rows).toHaveLength(1);
      expect(text.rows.rows[0].literal).toBe("literal?1");
      expect(text.calls).toBe(1);
    } finally {
      await stop?.();
      await rm(dir, { recursive: true, force: true });
      await rm(state, { recursive: true, force: true });
    }
  },
  120000,
);
