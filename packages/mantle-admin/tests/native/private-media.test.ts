import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { sdkFixtureCaller } from "../../../mantle/tests/apps/fixtures.js";
import { generateFromSources } from "../../../mantle/src/infrastructure/generate.js";
import { admin, type Options } from "../../src/server/index.js";
import { siteRoutes } from "../../src/server/site.js";
import { writeAdminFixture } from "./generated-fixture.js";
import { r2MediaStorage, type R2Bucket } from "@aotter/mantle/media/r2";

test("Admin media routes return a private asset with ids and metadata only, and sign nothing to read it", async () => {
  const result = await generateFromSources({
    target: "bun-sqlite",
    sources: {
      sources: [
        {
          sourceId: "notes.yaml",
          text: `apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: {name: notes}
spec:
  title: Notes
  lifecycle: operational
  schema: {type: object, properties: {title: {type: string}}, required: [title]}
`,
        },
      ],
    },
    site: {
      media: {
        purposes: [
          { name: "card", required: ["png"], maxBytes: { "image/png": 1000 } },
          { name: "contract", required: ["png"], maxBytes: { "image/png": 1000 }, visibility: "private" },
        ],
      },
    },
  });
  if (!result.ok) throw Error(JSON.stringify(result.diagnostics));
  const directory = await mkdtemp(join(import.meta.dir, ".private-media-")),
    db = new Database(":memory:");
  try {
    await writeAdminFixture(directory, result.files);
    db.exec(result.files["schema.sql"]!);
    const { site } = await import(join(directory, "site.ts"));
    const objects = new Map<string, { size: number; httpMetadata: { contentType: string } }>(),
      methods: string[] = [];
    const bucket: R2Bucket = {
      async head(key) {
        return objects.get(key) ?? null;
      },
      async get(key) {
        const value = objects.get(key);
        return value ? { ...value, body: new Blob([new Uint8Array(value.size)]).stream() } : null;
      },
      async put(key, body, options) {
        objects.set(key, {
          size: (await new Response(body).arrayBuffer()).byteLength,
          httpMetadata: options.httpMetadata,
        });
      },
      async delete(keys) {
        for (const key of typeof keys === "string" ? [keys] : keys) objects.delete(key);
      },
    };
    const storage = (publicBase: string | null) =>
      r2MediaStorage({
        bucket,
        signer: {
          async sign(url, init) {
            methods.push(init.method);
            return { url };
          },
        },
        endpoint: publicBase ? "https://public.r2.test" : "https://private.r2.test",
        publicBase,
      });
    const session = sdkFixtureCaller({
      kind: "user",
      subject: "a",
      role: "admin",
      admin: true,
      scopes: [],
      credential: "session",
      credentialId: null,
      clientId: null,
    });
    const ask = (fetch: ReturnType<typeof admin>, path: string, body?: unknown) =>
      fetch(
        new Request("https://app.test/admin/api" + path, {
          method: body ? "POST" : "GET",
          headers: { origin: "https://app.test", "content-type": "application/json" },
          ...(body ? { body: JSON.stringify(body) } : {}),
        }),
        {},
      );
    const handler = (media: Options<{}, Database>["media"]) => {
      const options: Options<{}, Database> = { db: () => db, caller: () => session, site, media };
      return admin({ collections: [], views: [], operations: [], webmcp: { tools: [], routes: {} } }, [], [], {
        ...options,
        routes: siteRoutes(options),
      });
    };

    const unsplit = await ask(handler(storage("https://media.test")), "/media");
    expect(unsplit?.status).toBe(501);
    expect((await unsplit!.json()).error.code).toBe("MEDIA_NOT_CONFIGURED");

    const fetch = handler({ public: storage("https://media.test"), private: storage(null) });
    const created = await (await ask(fetch, "/media/uploads", {
      filename: "c.png",
      purpose: "contract",
      variants: [{ mimeType: "image/png", byteSize: 90, role: "primary" }],
    }))!.json();
    expect(new URL(created.capabilities[0].uploadUrl).hostname).toBe("private.r2.test");
    for (const capability of created.capabilities)
      objects.set(new URL(capability.uploadUrl).pathname.slice(1), {
        size: 90,
        httpMetadata: { contentType: "image/png" },
      });
    const committed = await ask(fetch, `/media/uploads/${created.uploadGroupId}/commit`, {});
    expect(committed?.status).toBe(200);
    const reads = [
      await committed!.text(),
      await (await ask(fetch, "/media"))!.text(),
      await (await ask(fetch, `/media/${created.uploadGroupId}`))!.text(),
    ];
    for (const read of reads) {
      expect(read).toContain(created.uploadGroupId);
      expect(read).not.toMatch(/https?:|publicUrl/);
    }
    expect(JSON.parse(reads[2]!)).toMatchObject({ primaryUrl: null, visibility: "private" });
    expect(methods).toEqual(["PUT"]);
  } finally {
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
