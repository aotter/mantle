import { startLocalD1 } from "./apps/local-d1.js";
import { test, expect } from "bun:test";
import { mkdtemp, rm, writeFile, open } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { generateFromSources } from "../src/infrastructure/generate.js";
import { loadFixtureSources, writeGenerated } from "./apps/link.js";
(process.env.MANTLE_NEXT_SITE_D1 ? test : test.skip)(
  "optional site/media performs durable native local D1 writes",
  async () => {
    const dir = await mkdtemp(join(import.meta.dir, "apps/.site-d1-")),
      state = await mkdtemp(join(tmpdir(), "mantle-site-d1-"));
    let stop: (() => Promise<void>) | undefined;
    try {
      const generated = await generateFromSources({
        target: "cloudflare-d1",
        sources: { sources: await loadFixtureSources() },
        site: {
          brand: "D1",
          media: { purposes: [{ name: "cover", required: ["png"], maxBytes: { "image/png": 100 } }] },
        },
      });
      if (!generated.ok) throw Error(JSON.stringify(generated.diagnostics));
      await writeGenerated(dir, generated.files);
      const { unstable_splitSqlQuery } = await import("wrangler");
      const source = `import {userCaller} from '${resolve(import.meta.dir, "../src/kernel/user-caller.ts")}';import {site} from './site.js';
 const caller=userCaller({id:'admin',role:'admin'});
 const storage={async createUpload(a:any){return {capabilities:a.variants.map((v:any)=>({...v,method:'PUT' as const,uploadUrl:'https://upload.test/'+a.uploadGroupId,storageKey:'uploads/'+a.uploadGroupId}))}},async commitUpload(a:any){return {id:a.uploadGroupId,createdAt:a.now,variants:a.variants.map((v:any)=>({mimeType:v.mimeType,role:v.role,storageKey:a.uploadGroupId,publicUrl:'https://media.test/'+a.uploadGroupId,byteSize:90}))}},async deleteObject(){}};
 export default {async fetch(request:Request,env:any){if(new URL(request.url).pathname==='/health')return new Response('ready');try{for(const sql of ${JSON.stringify(unstable_splitSqlQuery(generated.files["schema.sql"]!))})await env.DB.prepare(sql).run();
 const s=site(env.DB,caller);await s.updateSettings({title:'Durable D1'});const media=s.media(storage);const u=await media.createUpload({filename:'x.png',purpose:'cover',variants:[{mimeType:'image/png',byteSize:90,role:'primary'}]});const a=await media.commitUpload(u.uploadGroupId);const repeated=await media.commitUpload(u.uploadGroupId);const list=await media.list({search:a.id});await media.update(a.id,{alt:'D1 alt'});const changed=await media.get(a.id);const deleted=await media.delete(a.id);return Response.json({title:(await s.read()).title,id:a.id===repeated.id,pending:(await env.DB.prepare('SELECT count(*) AS n FROM pending_media_uploads').all()).results[0].n,rows:list.rows.length,alt:changed.alt,deleted,remaining:(await media.list({})).rows.length});}catch(error){return Response.json({error:String(error),stack:(error as Error).stack},{status:500});}}};`;
      await writeFile(join(dir, "worker.ts"), source);
      const config = join(state, "wrangler.json");
      await writeFile(
        config,
        JSON.stringify({
          name: "mantle-site-local",
          main: join(dir, "worker.ts"),
          compatibility_date: "2026-09-28",
          compatibility_flags: ["nodejs_compat"],
          d1_databases: [
            { binding: "DB", database_name: "mantle-site-local", database_id: "00000000-0000-0000-0000-000000000001" },
          ],
        }),
      );
      const running = await startLocalD1(config, "9001", state);
      stop = running.stop;
      const response = await fetch("http://127.0.0.1:9001/verify");
      expect(await response.json()).toEqual({
        title: "Durable D1",
        id: true,
        pending: 0,
        rows: 1,
        alt: "D1 alt",
        deleted: { deleted: true, variantsRemoved: 1 },
        remaining: 0,
      });
      expect(response.status).toBe(200);
    } finally {
      await stop?.();
      await rm(dir, { recursive: true, force: true });
      await rm(state, { recursive: true, force: true });
    }
  },
  90000,
);
