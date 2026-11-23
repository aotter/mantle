import { startLocalD1 } from "./apps/local-d1.js";
import { test, expect } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { generateFromSources } from "../src/infrastructure/generate.js";
import { writeGenerated } from "./apps/link.js";
import { mcpInit } from "./mcp-wire.js";

const source = `apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: {name: entries}
spec: {title: Entries, schema: {type: object, properties: {title: {type: string}}}}
---
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: {name: entries}
spec: {surface: public, sql: 'SELECT id FROM entries ORDER BY id'}
`;

(process.env.MANTLE_NEXT_MCP_MEDIA_D1 ? test : test.skip)(
  "MCP media executes the native D1 library and R2 adapter on actual local bindings",
  async () => {
    const base = resolve(import.meta.dir, ".."),
      dir = await mkdtemp(join(base, "tests/apps/.mcp-r2-")),
      state = await mkdtemp(join(tmpdir(), "mantle-mcp-r2-"));
    const port = process.env.MANTLE_NEXT_MCP_MEDIA_PORT ?? "9131",
      origin = "http://127.0.0.1:" + port;
    let stop: (() => Promise<void>) | undefined;
    try {
      const generated = await generateFromSources({
        target: "cloudflare-d1",
        sources: { sources: [{ sourceId: "media.yaml", text: source }] },
        site: { media: { purposes: [{ name: "cover", required: ["png"], maxBytes: { "image/png": 100 } }] } },
      });
      if (!generated.ok) throw Error(JSON.stringify(generated.diagnostics));
      await writeGenerated(dir, generated.files);
      const { unstable_splitSqlQuery } = await import("wrangler");
      await writeFile(
        join(dir, "worker.ts"),
        `import {userCaller} from '${resolve(base, "src/kernel/user-caller.ts")}';import {mcp} from './mcp.js';
import {site} from './site.js';
import {wire} from ${JSON.stringify(resolve(base, "src/kernel/contracts.ts"))};
import {mediaError} from ${JSON.stringify(resolve(base, "src/kernel/media.ts"))};
import {r2MediaStorage} from ${JSON.stringify(resolve(base, "src/kernel/r2-media.ts"))};
let reads=0;
const caller=userCaller({id:'native-admin',role:'admin'});
const storage=env=>r2MediaStorage({bucket:env.MEDIA,endpoint:${JSON.stringify(origin)},publicBase:${JSON.stringify(origin)},signer:{async sign(url){return{url};}}});
const handle=mcp({db:env=>({prepare(sql){const statement=env.DB.prepare(sql);return{original:statement,bind(...values){const bound=statement.bind(...values);return{original:bound,all(){reads++;return bound.all();}};}}},batch(statements){return env.DB.batch(statements.map(s=>s.original));}}),caller:request=>request.headers.get('x-test-caller')==='anonymous'?{kind:'anonymous'}:request.headers.get('x-test-caller')==='member'?{...caller,role:'member',admin:false}:caller,media:storage});
export default{async fetch(request,env){const url=new URL(request.url),key=url.pathname.slice(1);
 if(url.pathname==='/health')return new Response('ready');
 if(url.pathname==='/setup'){for(const sql of ${JSON.stringify(unstable_splitSqlQuery(generated.files["schema.sql"]!))})await env.DB.prepare(sql).run();return new Response(null,{status:204});}
 if(url.pathname==='/counts')return Response.json({reads,objects:(await env.MEDIA.list()).objects.map(o=>o.key)});
 if(url.pathname.startsWith('/uploads/')&&request.method==='PUT'){await env.MEDIA.put(key,request.body,{httpMetadata:{contentType:request.headers.get('content-type')}});return new Response(null,{status:204});}
 if(url.pathname.startsWith('/committed/')){const object=await env.MEDIA.get(key);return object?new Response(object.body,{headers:{'content-type':object.httpMetadata.contentType}}):new Response(null,{status:404});}
 if(url.pathname==='/native-error-status'){const native=storage(env);try{const library=site(env.DB,caller).media(url.searchParams.has('partial')?{...native,async deleteObject(value){await native.deleteObject(value);throw mediaError('PARTIAL_FAILURE','Object deletion reply lost.','media/r2');}}:native);if(url.searchParams.has('partial'))await library.delete(url.searchParams.get('id'));else await library.get('missing-native-asset');throw Error('Expected native media failure.');}catch(error){const result=wire(error);return Response.json(result,{status:result.status});}}
 return await handle(request,env)??new Response(null,{status:404});}};`,
      );
      const config = join(state, "wrangler.json");
      await writeFile(
        config,
        JSON.stringify({
          name: "mantle-mcp-r2-local",
          main: join(dir, "worker.ts"),
          compatibility_date: "2026-09-28",
          compatibility_flags: ["nodejs_compat"],
          d1_databases: [
            {
              binding: "DB",
              database_name: "mantle-mcp-r2-local",
              database_id: "00000000-0000-0000-0000-000000000001",
            },
          ],
          r2_buckets: [{ binding: "MEDIA", bucket_name: "mantle-mcp-r2-local" }],
        }),
      );
      const running = await startLocalD1(config, port, state);
      stop = running.stop;
      expect((await fetch(origin + "/setup")).status).toBe(204);
      const counts = async () =>
        (await (await fetch(origin + "/counts")).json()) as { reads: number; objects: string[] };
      const rpc = async (
        method: string,
        params: unknown = {},
        path = "/mcp/admin",
        headers: Record<string, string> = {},
      ) => {
        const response = await fetch(
          origin + path,
          mcpInit(
            { jsonrpc: "2.0", id: 1, method, params },
            {
              headers: {
                origin,
                "content-type": "application/json",
                accept: "application/json, text/event-stream",
                ...headers,
              },
            },
          ),
        );
        const body = await response.text();
        return {
          response,
          data: JSON.parse(body.startsWith("event:") ? body.split("data: ")[1]!.split("\n")[0]! : body),
        };
      };
      const call = async (name: string, args: unknown = {}) =>
        (await rpc("tools/call", { name, arguments: args })).data.result;
      const names = (await rpc("tools/list")).data.result.tools.map((tool: { name: string }) => tool.name);
      expect(names).toEqual([
        "upload_media",
        "find_media",
        "update_media",
        "delete_media",
        "get_media_upload_policy",
        "create_media_upload",
        "commit_media_upload",
        "list_media_assets",
        "get_media_asset",
        "update_media_asset",
        "delete_media_asset",
        "open_media_upload",
      ]);
      expect(
        (await rpc("tools/list", {}, "/mcp")).data.result.tools.map((tool: { name: string }) => tool.name),
      ).toEqual(["entries"]);
      expect((await counts()).reads).toBe(0);
      expect((await rpc("tools/list", {}, "/mcp/admin", { "x-test-caller": "anonymous" })).response.status).toBe(401);
      expect((await rpc("tools/list", {}, "/mcp/admin", { "x-test-caller": "member" })).response.status).toBe(403);
      expect((await call("get_media_asset", { id: 2 })).isError).toBe(true);
      expect((await counts()).reads).toBe(0);
      expect((await call("get_media_upload_policy")).structuredContent.purposes[0].name).toBe("cover");
      expect((await counts()).reads).toBe(1);
      const upload = (
          await call("create_media_upload", {
            filename: "native.png",
            purpose: "cover",
            variants: [{ mimeType: "image/png", byteSize: 5, role: "primary" }],
          })
        ).structuredContent,
        capability = upload.capabilities[0];
      const bytes = new Uint8Array([137, 80, 78, 71, 13]);
      expect(
        (await fetch(capability.uploadUrl, { method: "PUT", headers: capability.requiredHeaders, body: bytes })).status,
      ).toBe(204);
      const committed = (await call("commit_media_upload", { uploadGroupId: upload.uploadGroupId })).structuredContent;
      expect(committed.id).toBe(upload.uploadGroupId);
      expect(committed.variants[0].byteSize).toBe(5);
      expect(committed.variants[0].storageKey.startsWith("committed/")).toBe(true);
      expect(Array.from(new Uint8Array(await (await fetch(committed.variants[0].publicUrl)).arrayBuffer()))).toEqual(
        Array.from(bytes),
      );
      expect((await counts()).objects).toEqual([committed.variants[0].storageKey]);
      expect((await call("commit_media_upload", { uploadGroupId: upload.uploadGroupId })).structuredContent.id).toBe(
        committed.id,
      );
      expect((await call("list_media_assets", { search: committed.id })).structuredContent.rows).toHaveLength(1);
      expect((await call("list_media_assets", { search: "a".repeat(49) })).structuredContent.rows).toHaveLength(0);
      expect((await call("update_media_asset", { id: committed.id, alt: "native R2" })).structuredContent.alt).toBe(
        "native R2",
      );
      const before = (await counts()).reads,
        refused = await rpc(
          "tools/call",
          { name: "delete_media_asset", arguments: { id: committed.id } },
          "/mcp/admin",
          { origin: "https://evil.test" },
        );
      expect(refused.response.status).toBe(403);
      expect(refused.data.error.message).toBe("Invalid Origin: evil.test");
      expect((await counts()).reads).toBe(before);
      expect((await call("get_media_asset", { id: committed.id })).structuredContent.alt).toBe("native R2");
      const missing = await fetch(origin + "/native-error-status");
      expect(missing.status).toBe(404);
      expect(((await missing.json()) as { error: { code: string; path: string } }).error).toMatchObject({
        code: "MEDIA_ASSET_NOT_FOUND",
        path: "media",
      });
      const partial = await fetch(origin + "/native-error-status?partial=1&id=" + committed.id);
      expect(partial.status).toBe(503);
      expect(
        ((await partial.json()) as { error: { code: string; path: string; failure: unknown } }).error,
      ).toMatchObject({
        code: "PARTIAL_FAILURE",
        path: "media",
        failure: { outcome: "partial", retry: "safe", resource: "media" },
      });
      expect((await call("get_media_asset", { id: committed.id })).structuredContent.id).toBe(committed.id);
      expect((await call("delete_media_asset", { id: committed.id })).structuredContent).toEqual({
        deleted: true,
        variantsRemoved: 1,
      });
      expect((await counts()).objects).toEqual([]);
      expect((await fetch(committed.variants[0].publicUrl)).status).toBe(404);
      expect(
        JSON.parse((await call("get_media_asset", { id: committed.id })).content[0].text).diagnostics[0],
      ).toMatchObject({ code: "MEDIA_ASSET_NOT_FOUND", path: "media" });
    } finally {
      await stop?.();
      await rm(dir, { recursive: true, force: true });
      await rm(state, { recursive: true, force: true });
    }
  },
  90000,
);
