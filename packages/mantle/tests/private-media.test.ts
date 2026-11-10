import { fixtureCaller } from "./apps/fixtures.js";
import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { generateFromSources } from "../src/infrastructure/generate.js";
import { writeGenerated } from "./apps/link.js";
import { r2MediaStorage, type R2Bucket } from "../src/kernel/r2-media.js";
import { wire } from "../src/kernel/contracts.js";
import { mediaItem } from "../src/kernel/media.js";
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
const cover = { name: "cover", required: ["png"], maxBytes: { "image/png": 100 } };
const docs = { name: "docs", required: ["png"], maxBytes: { "image/png": 100 }, visibility: "private" as const };
const admin: any = fixtureCaller({
  kind: "user",
  subject: "admin-id",
  role: "admin",
  admin: true,
  scopes: ["mcp"],
  credential: "session",
  credentialId: null,
  clientId: null,
});
const upload = (purpose: string) => ({
  filename: "x.png",
  purpose,
  variants: [{ mimeType: "image/png", byteSize: 90, role: "primary" }],
});
/** An R2 bucket in memory; `gets` counts signed reads. */
function bucket(publicBase: string | null) {
  const objects = new Map<string, { type: string; size: number }>(),
    signed: { method: string; url: string }[] = [];
  const native: R2Bucket = {
    async head(key) {
      const o = objects.get(key);
      return o ? { size: o.size, httpMetadata: { contentType: o.type } } : null;
    },
    async get(key) {
      const o = objects.get(key);
      return o
        ? { size: o.size, httpMetadata: { contentType: o.type }, body: new Blob([new Uint8Array(o.size)]).stream() }
        : null;
    },
    async put(key, body, options) {
      objects.set(key, {
        size: (await new Response(body).arrayBuffer()).byteLength,
        type: options.httpMetadata.contentType,
      });
    },
    async delete(keys) {
      for (const key of typeof keys === "string" ? [keys] : keys) objects.delete(key);
    },
  };
  const storage = r2MediaStorage({
    bucket: native,
    endpoint: publicBase ? "https://public.r2.test" : "https://private.r2.test",
    publicBase,
    signer: {
      async sign(url, init) {
        signed.push({ method: init.method, url });
        return { url: url + "&X-Amz-Signature=sig" };
      },
    },
  });
  return { objects, signed, storage, gets: () => signed.filter(s => s.method === "GET").length };
}
async function fixture(purposes: readonly object[]) {
  const generated = await generateFromSources({
    target: "bun-sqlite",
    sources: { sources: [{ sourceId: "media.yaml", text: source }] },
    site: { media: { purposes: purposes as any } },
  });
  if (!generated.ok) throw Error(JSON.stringify(generated.diagnostics));
  const dir = await mkdtemp(join(import.meta.dir, ".private-media-")),
    db = new Database(":memory:");
  db.exec(generated.files["schema.sql"]!);
  await writeGenerated(dir, generated.files);
  return {
    dir,
    db,
    files: generated.files,
    site: (await import(join(dir, "site.ts"))).site,
    mcp: (await import(join(dir, "mcp.ts"))).mcp,
    close: async () => {
      db.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
const put = async (media: any, b: ReturnType<typeof bucket>, purpose: string) => {
  const u = await media.createUpload(upload(purpose));
  for (const c of u.capabilities) b.objects.set(new URL(c.uploadUrl).pathname.slice(1), { type: c.mimeType, size: 90 });
  return media.commitUpload(u.uploadGroupId);
};

test("an omitted visibility is public, as before; an unknown one fails generation", async () => {
  const f = await fixture([cover]);
  try {
    const pub = bucket("https://media.test"),
      asset = await put(f.site(f.db, admin).media(pub.storage), pub, "cover");
    expect(asset.visibility).toBeUndefined();
    expect(asset.variants[0].publicUrl).toStartWith("https://media.test/committed/");
    expect(mediaItem(asset)).not.toHaveProperty("visibility");
    expect(pub.gets()).toBe(0);
  } finally {
    await f.close();
  }
  const bad = await generateFromSources({
    target: "bun-sqlite",
    sources: { sources: [{ sourceId: "media.yaml", text: source }] },
    site: { media: { purposes: [{ ...cover, visibility: "hidden" as any }] } },
  });
  expect(bad.ok).toBe(false);
  expect(JSON.stringify(bad)).toContain("visibility must be 'public' or 'private'");
  expect(() =>
    r2MediaStorage({
      bucket: {} as R2Bucket,
      endpoint: "https://r2.test",
      publicBase: undefined as any,
      signer: {
        async sign(url) {
          return { url };
        },
      },
    }),
  ).toThrow("or null for a private bucket");
});

test("a private purpose without a private storage fails at construction", async () => {
  const f = await fixture([cover, docs]);
  try {
    expect(f.files["site.ts"]).toContain('"visibility":"private"');
    let error: any;
    try {
      f.site(f.db, admin).media(bucket("https://media.test").storage);
    } catch (caught) {
      error = caught;
    }
    expect(error.code).toBe("MEDIA_NOT_CONFIGURED");
    expect(error.message).toContain("'docs'");
    expect(error.message).toContain("{ public, private }");
    expect(wire(error).status).toBe(501);
    expect(() =>
      f.site(f.db, admin).media({ public: bucket("https://media.test").storage, private: bucket(null).storage }),
    ).not.toThrow();
  } finally {
    await f.close();
  }
});

test("a private asset has no public URL on library, Admin or MCP reads, and signRead runs only when called", async () => {
  const f = await fixture([cover, docs]),
    pub = bucket("https://media.test"),
    priv = bucket(null),
    storages = { public: pub.storage, private: priv.storage };
  try {
    const media = f.site(f.db, admin).media(storages),
      shown = await put(media, pub, "cover"),
      hidden = await put(media, priv, "docs");
    expect([...pub.objects.keys()].some(k => k.includes(hidden.id))).toBe(false);
    expect([...priv.objects.keys()].filter(k => k.includes(hidden.id))).toHaveLength(1);
    expect(shown.visibility).toBeUndefined();
    expect(hidden.visibility).toBe("private");
    expect(hidden.variants[0]).not.toHaveProperty("publicUrl");
    const reads = [
      hidden,
      await media.get(hidden.id),
      (await media.list({})).rows.find((r: any) => r.id === hidden.id),
      await media.update(hidden.id, { alt: "secret" }),
      mediaItem(await media.get(hidden.id)),
    ];
    for (const read of reads) expect(JSON.stringify(read)).not.toMatch(/https?:|publicUrl/);
    expect(mediaItem(hidden)).toMatchObject({ primaryUrl: null, visibility: "private" });
    // MCP: every read-only media tool, whatever it is named
    const handle = f.mcp({
      db: () => f.db,
      allowedOrigins: ["https://app.test"],
      caller: () => admin,
      media: () => storages,
    });
    const rpc = async (method: string, params: any = {}) => {
      const response = await handle(
        new Request("https://app.test/mcp/admin", {
          method: "POST",
          headers: {
            origin: "https://app.test",
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        }),
        {},
      );
      const text = await response.text();
      return JSON.parse(text.startsWith("event:") ? text.split("data: ")[1]!.split("\n")[0]! : text).result;
    };
    const readTools = (await rpc("tools/list")).tools.filter(
      (t: any) =>
        t.annotations?.readOnlyHint &&
        t.inputSchema.properties &&
        ("id" in t.inputSchema.properties || "limit" in t.inputSchema.properties),
    );
    expect(readTools.length).toBeGreaterThanOrEqual(2);
    for (const tool of readTools) {
      const result = await rpc("tools/call", {
        name: tool.name,
        arguments: "id" in tool.inputSchema.properties ? { id: hidden.id } : {},
      });
      expect(result.isError).toBeFalsy();
      expect(JSON.stringify(result)).toContain(hidden.id);
      expect(JSON.stringify(result)).not.toContain("private.r2.test");
      expect(
        JSON.stringify(result)
          .match(/https?:[^"]*/g)
          ?.every(url => url.startsWith("https://media.test/committed/" + shown.id)) ?? true,
      ).toBe(true);
    }
    expect(priv.gets()).toBe(0);
    expect(pub.gets()).toBe(0);
    // on demand only
    const read = await media.signRead(hidden.id, 60);
    expect(priv.gets()).toBe(1);
    expect(new URL(priv.signed.at(-1)!.url).searchParams.get("X-Amz-Expires")).toBe("60");
    expect(read.variants[0].url).toStartWith("https://private.r2.test/committed/" + hidden.id);
    expect(read.expiresAt).toBeGreaterThan(Date.now());
    expect((await media.signRead(shown.id)).variants[0].url).toBe(shown.variants[0].publicUrl);
    expect(pub.gets()).toBe(0);
    await expect(media.signRead(hidden.id, 0)).rejects.toMatchObject({ code: "INPUT_VALIDATION_FAILED" });
    expect(await media.delete(hidden.id)).toEqual({ deleted: true, variantsRemoved: 1 });
    expect([...priv.objects.keys()].some(k => k.includes(hidden.id))).toBe(false);
  } finally {
    await f.close();
  }
});

test("a storage whose URLs contradict its visibility is refused, and an unsigned private storage is a configuration error", async () => {
  const f = await fixture([cover, docs]),
    pub = bucket("https://media.test");
  const custom = (publicUrl: boolean) => {
    const deleted: string[] = [];
    const storage: MediaStorage = {
      async createUpload(a) {
        return {
          capabilities: a.variants.map(v => ({
            ...v,
            method: "PUT" as const,
            storageKey: "uploads/" + a.uploadGroupId,
            uploadUrl: "https://up.test/" + a.uploadGroupId,
          })),
        };
      },
      async commitUpload(a) {
        return {
          id: a.uploadGroupId,
          createdAt: a.now,
          variants: a.variants.map(v => ({
            ...v,
            storageKey: "committed/" + a.uploadGroupId,
            ...(publicUrl ? { publicUrl: "https://leak.test/" + a.uploadGroupId } : {}),
            byteSize: 5,
          })),
        };
      },
      async deleteObject({ storageKey }) {
        deleted.push(storageKey);
      },
    };
    return { storage, deleted };
  };
  try {
    for (const [purpose, storages] of [
      [
        "docs",
        (() => {
          const s = custom(true);
          return { s, option: { public: pub.storage, private: s.storage } };
        })(),
      ],
      [
        "cover",
        (() => {
          const s = custom(false);
          return { s, option: { public: s.storage, private: bucket(null).storage } };
        })(),
      ],
    ] as const) {
      const media = f.site(f.db, admin).media(storages.option),
        u = await media.createUpload(upload(purpose));
      await expect(media.commitUpload(u.uploadGroupId)).rejects.toMatchObject({ code: "MEDIA_NOT_CONFIGURED" });
      expect(storages.s.deleted.sort()).toEqual(["committed/" + u.uploadGroupId, "uploads/" + u.uploadGroupId]);
    }
    expect(f.db.query("SELECT id FROM media_assets").all()).toEqual([]);
    const unsigned = custom(false),
      media = f.site(f.db, admin).media({ public: pub.storage, private: unsigned.storage }),
      u = await media.createUpload(upload("docs")),
      asset = await media.commitUpload(u.uploadGroupId);
    expect(asset.visibility).toBe("private");
    await expect(media.signRead(asset.id)).rejects.toMatchObject({ code: "MEDIA_NOT_CONFIGURED" });
  } finally {
    await f.close();
  }
});

test("an MCP tool returns a signed read URL only in the result _meta", async () => {
  const f = await fixture([docs]),
    priv = bucket(null),
    storages = { public: bucket("https://media.test").storage, private: priv.storage };
  try {
    const { mcp, withResultMeta } = await import("../src/kernel/mcp.js"),
      hidden = await put(f.site(f.db, admin).media(storages), priv, "docs");
    // the application's own read, after its own check
    const tool = {
      name: "read_document",
      surface: "public",
      description: "read",
      inputSchema: { type: "object" },
      validate: (raw: any) => raw,
      run: async (db: any, caller: any) => {
        const media = f.site(db, caller).media(storages);
        return withResultMeta(await media.get(hidden.id), { "app/read": await media.signRead(hidden.id, 60) });
      },
    };
    const handle = mcp([tool] as any, { db: () => f.db, allowedOrigins: ["https://app.test"], caller: () => admin });
    const response = await handle(
      new Request("https://app.test/mcp", {
        method: "POST",
        headers: {
          origin: "https://app.test",
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "read_document", arguments: {} },
        }),
      }),
      {},
    );
    const text = await response!.text(),
      result = JSON.parse(text.startsWith("event:") ? text.split("data: ")[1]!.split("\n")[0]! : text).result;
    if (!result._meta) throw Error(text);
    expect(result._meta["app/read"].variants[0].url).toStartWith("https://private.r2.test/");
    expect(JSON.stringify(result.content)).not.toContain("r2.test");
    expect(JSON.stringify(result.structuredContent)).not.toContain("r2.test");
    expect(result.structuredContent.id).toBe(hidden.id);
  } finally {
    await f.close();
  }
});
