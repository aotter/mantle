import { startLocalD1 } from "./apps/local-d1.js";
import { test, expect } from "bun:test";
import { mkdtemp, writeFile, rm, open } from "node:fs/promises";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { generateOrThrow, writeGenerated, loadFixtureSources } from "./apps/link.js";
(process.env.MANTLE_NEXT_TRANSLATIONS_D1 ? test : test.skip)(
  "translation publish/locales run on actual local D1",
  async () => {
    const { unstable_splitSqlQuery } = await import("wrangler"),
      base = resolve(import.meta.dir, ".."),
      dir = await mkdtemp(join(base, "tests/apps/.translation-d1-")),
      privateDir = await mkdtemp(join(tmpdir(), "mantle-translation-d1-")),
      port = process.env.MANTLE_NEXT_TRANSLATIONS_PORT ?? "8998";
    let stop: (() => Promise<void>) | undefined;
    try {
      const files = await generateOrThrow("cloudflare-d1", await loadFixtureSources("translations.yaml"));
      await writeGenerated(dir, files, false);
      await writeFile(
        join(dir, "worker.ts"),
        `import {authenticatedAs as userCaller} from '@aotter/mantle/testing';import * as app from './generated.js';import {translationLocales} from './translations.js';import {verifyTranslations} from ${JSON.stringify(resolve(import.meta.dir, "translation-scenarios.ts"))};export default{async fetch(request:Request,env:{DB:any}){if(new URL(request.url).pathname==='/health')return new Response('ready');try{for(const sql of ${JSON.stringify(unstable_splitSqlQuery(files["schema.sql"]!))})await env.DB.prepare(sql).run();await verifyTranslations(app,translationLocales,env.DB,userCaller);return Response.json({ok:true});}catch(error){return Response.json({error:String(error),stack:(error as Error).stack},{status:500});}}};`,
      );
      const config = join(privateDir, "wrangler.json");
      await writeFile(
        config,
        JSON.stringify({
          name: "mantle-translations-local",
          main: join(dir, "worker.ts"),
          compatibility_date: "2026-09-28",
          compatibility_flags: ["nodejs_compat"],
          d1_databases: [
            {
              binding: "DB",
              database_name: "mantle-translations-local",
              database_id: "00000000-0000-0000-0000-000000000001",
            },
          ],
        }),
      );
      const running = await startLocalD1(config, port, privateDir);
      stop = running.stop;
      const response = await fetch(`http://127.0.0.1:${port}/verify`, { signal: AbortSignal.timeout(30000) });
      expect(await response.json()).toEqual({ ok: true });
      expect(response.status).toBe(200);
    } finally {
      await stop?.();
      await rm(dir, { recursive: true, force: true });
      await rm(privateDir, { recursive: true, force: true });
    }
  },
  90000,
);
