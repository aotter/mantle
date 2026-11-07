import { fixtureCaller } from "./apps/fixtures.js";
import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { generateFromSources } from "../src/infrastructure/generate.js";
import { writeGenerated } from "./apps/link.js";
import type { MediaStorage } from "../src/kernel/site-types.js";

const source = `apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: {name: entries}
spec: {title: Entries, lifecycle: operational, schema: {type: object, properties: {title: {type: string}}}}
---
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: {name: entries}
spec: {surface: public, sql: 'SELECT id FROM entries ORDER BY id'}
`;
const admin = fixtureCaller({ kind: "user", subject: "u", role: "admin", admin: true, scopes: ["mcp"], credential: "session", credentialId: null, clientId: null });
const storage: MediaStorage = {
  async createUpload(a) { return { capabilities: a.variants.map(v => ({ ...v, method: "PUT" as const, storageKey: "uploads/" + a.uploadGroupId, uploadUrl: "https://upload.test/" + a.uploadGroupId })) }; },
  async commitUpload(a) { return { id: a.uploadGroupId, createdAt: a.now, variants: a.variants.map(v => ({ ...v, storageKey: "committed/" + a.uploadGroupId, publicUrl: "https://media.test/" + a.uploadGroupId, byteSize: 5 })) }; },
  async deleteObject() {},
};
const upload = { filename: "x.png", purpose: "cover", variants: [{ mimeType: "image/png", byteSize: 5, role: "primary" }] };

test("another server's upload and asset ids get a distinct refusal over MCP that names nothing of that server; legacy ids still resolve (#1952)", async () => {
  const generated = await generateFromSources({ target: "bun-sqlite", sources: { sources: [{ sourceId: "media.yaml", text: source }] }, site: { media: { purposes: [{ name: "cover", required: ["png"], maxBytes: { "image/png": 100 } }] } } });
  if (!generated.ok) throw Error(JSON.stringify(generated.diagnostics));
  const dir = await mkdtemp(join(import.meta.dir, ".media-ownership-"));
  const [a, b] = [new Database(":memory:"), new Database(":memory:")];
  try {
    await writeGenerated(dir, generated.files);
    for (const db of [a, b]) db.exec(generated.files["schema.sql"]!);
    const { mcp } = await import(join(dir, "mcp.ts")), { site } = await import(join(dir, "site.ts"));
    const call = async (db: Database, name: string, args: object) => {
      const response = await mcp({ db: () => db, allowedOrigins: ["https://app.test"], caller: () => admin, media: () => storage })(new Request("https://app.test/mcp/admin", { method: "POST",
        headers: { origin: "https://app.test", "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) }), {});
      const text = await response.text();
      return { text, result: JSON.parse(text.startsWith("event:") ? text.split("data: ")[1]!.split("\n")[0]! : text).result };
    };
    const code = (r: { result: { content: { text: string }[] } }) => JSON.parse(r.result.content[0]!.text).diagnostics[0];

    const pending = (await call(a, "create_media_upload", upload)).result.structuredContent.uploadGroupId as string;
    const committed = (await call(a, "create_media_upload", upload)).result.structuredContent.uploadGroupId as string;
    expect((await call(a, "commit_media_upload", { uploadGroupId: committed })).result.structuredContent.id).toBe(committed);
    const tag = committed.split("_")[0]!;
    expect(committed).toMatch(/^[0-9a-f]{12}_[0-9a-f-]{36}$/);
    expect(pending.startsWith(tag + "_")).toBe(true);

    // b has never minted an id: any tagged id is another server's, before and after it mints its own
    for (const mint of [false, true]) {
      if (mint) expect((await call(b, "create_media_upload", upload)).result.structuredContent.uploadGroupId.startsWith(tag)).toBe(false);
      const foreign = await call(b, "commit_media_upload", { uploadGroupId: pending });
      expect(foreign.result.isError).toBe(true);
      expect(code(foreign)).toMatchObject({ code: "MEDIA_NOT_OWNED", message: "not an upload of this server; use the server that created it" });
      expect(foreign.text).not.toContain(tag);
      for (const name of ["get_media_asset", "update_media_asset", "delete_media_asset"]) {
        const refused = await call(b, name, { id: committed });
        expect(code(refused)).toMatchObject({ code: "MEDIA_NOT_OWNED", message: "not a media asset of this server; use the server that created it" });
        expect(refused.text).not.toContain(tag);
      }
    }
    // the owner still answers; its own unknown ids keep the unknown/expired codes
    expect((await call(a, "get_media_asset", { id: committed })).result.structuredContent.id).toBe(committed);
    expect(code(await call(a, "get_media_asset", { id: `${tag}_${crypto.randomUUID()}` })).code).toBe("MEDIA_ASSET_NOT_FOUND");
    expect(code(await call(a, "commit_media_upload", { uploadGroupId: `${tag}_${crypto.randomUUID()}` })).code).toBe("MEDIA_UPLOAD_EXPIRED");

    // legacy untagged ids resolve as before, and an unknown one is not called foreign
    const legacy = crypto.randomUUID();
    b.query("INSERT INTO media_assets (id, created_at, variants) VALUES (?, 1, '[]')").run(legacy);
    expect((await call(b, "get_media_asset", { id: legacy })).result.structuredContent.id).toBe(legacy);
    expect((await call(b, "update_media_asset", { id: legacy, alt: "kept" })).result.structuredContent.alt).toBe("kept");
    const library = site(b, admin).media(storage);
    expect((await library.list({})).rows.map((row: { id: string }) => row.id)).toContain(legacy);
    await expect(library.get(crypto.randomUUID())).rejects.toMatchObject({ code: "MEDIA_ASSET_NOT_FOUND" });
    await expect(library.commitUpload(crypto.randomUUID())).rejects.toMatchObject({ code: "MEDIA_UPLOAD_EXPIRED" });
    expect(await library.delete(legacy)).toEqual({ deleted: true, variantsRemoved: 0 });
    // site settings never show the tag
    expect(JSON.stringify(await site(b, admin).read())).not.toContain("media_id_tag");
  } finally { a.close(); b.close(); await rm(dir, { recursive: true, force: true }); }
});
