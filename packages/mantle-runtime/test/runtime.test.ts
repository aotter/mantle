import { describe, expect, it } from "vitest";
import { createCmsRuntime } from "../src/runtime.js";
import { BootValidationError } from "../src/usecase/boot/index.js";
import { DatabaseSiteConfigRepository } from "../src/infrastructure/persistence/DatabaseSiteConfigRepository.js";
import { schemaIndexMigrations } from "../src/infrastructure/boot/index.js";
import { InMemoryDatabase } from "./fakes/database.js";
import { makeProcedure, postsSchema } from "./fakes/manifests.js";
import type { AssetServer } from "../src/domain/port/index.js";

const noopAssets: AssetServer = {
  async fetch() {
    return null;
  },
};

describe("createCmsRuntime compatibility composition", () => {
  it("constructs with empty manifests + required ports", async () => {
    const runtime = await createCmsRuntime({
      manifests: [],
      db: new InMemoryDatabase(),
      assets: noopAssets,
    });
    expect(runtime.schemasByName.size).toBe(0);
    expect(runtime.proceduresByName.size).toBe(0);
    expect(runtime.viewsByName.size).toBe(0);
  });

  it("prepares storage, seeds siteDefaults, and validates before returning", async () => {
    const db = new InMemoryDatabase();
    await createCmsRuntime({
      manifests: [makeProcedure()],
      handlers: { echoHandler: () => ({ ok: true }) },
      db,
      assets: noopAssets,
      siteDefaults: {
        brand: "Blog",
        title: "Blog Site",
        description: "A nice place.",
        origin: "https://example.com",
      },
    });
    expect(db.appliedMigrations.has("0001-init")).toBe(true);
    const site = await new DatabaseSiteConfigRepository(db).load();
    expect(site.brand).toBe("Blog");
    expect(site.title).toBe("Blog Site");
    expect(site.description).toBe("A nice place.");
    expect(site.origin).toBe("https://example.com");
  });

  it("skips unchanged boot reconciliation across Worker isolates", async () => {
    const db = new InMemoryDatabase();
    const options = {
      manifests: [postsSchema()],
      db,
      assets: noopAssets,
      siteDefaults: { brand: "Blog", locales: ["en"] },
    } as const;

    await createCmsRuntime(options);
    const firstBootQueries = db.executions.length;
    await createCmsRuntime(options);

    expect(db.executions.slice(firstBootQueries).map(({ sql }) => sql)).toEqual([
      "SELECT fingerprint FROM _mantle_boot_state WHERE id = ? LIMIT 1",
    ]);
  });

  it("invalidates once after every successful content and site mutation", async () => {
    const calls: string[] = [];
    const operational = {
      ...postsSchema(),
      metadata: { name: "events" },
      spec: { ...postsSchema().spec, lifecycle: "operational" as const },
    };
    const runtime = await createCmsRuntime({
      manifests: [postsSchema(), operational],
      db: new InMemoryDatabase(),
      assets: noopAssets,
      siteDefaults: { brand: "Blog", title: "Blog" },
      onPublicChange: async () => { calls.push("purge"); },
    });
    const created = await runtime.createDraft.execute({
      collection: "posts",
      data: { title: "Hello", slug: "hello", content: "Body" },
      authorId: null,
    });
    const updated = await runtime.updateDraft.execute({
      id: created.id,
      expectedVersion: created.version,
      data: { title: "Updated" },
    });
    const published = await runtime.requestPublish.execute({ id: updated.id });
    const draft = await runtime.unpublish.execute({ id: published.id });
    await runtime.deleteEntry.execute({ id: draft.id });
    await runtime.updateSiteSettings.execute({ title: "New title" });
    await runtime.createDraft.execute({
      collection: "events",
      data: { title: "Private event", slug: "private-event", content: "Operational" },
      authorId: null,
    });

    expect(calls).toHaveLength(6);
  });

  it("installs manifest Schema indexes", async () => {
    const db = new InMemoryDatabase();
    const schema = postsSchema();
    const indexedSchema = {
      ...schema,
      spec: {
        ...schema.spec,
        indexes: [["title"]],
        uniqueIndexes: [["slug"]],
      },
    } as const;
    await createCmsRuntime({
      manifests: [indexedSchema],
      db,
      assets: noopAssets,
    });

    const ids = schemaIndexMigrations([indexedSchema]).map(({ id }) => id);
    expect(ids).toHaveLength(4);
    expect(ids.filter((id) => id.startsWith("schema-index-v2:column:"))).toHaveLength(2);
    expect(ids.filter((id) => id.startsWith("schema-index-v2:index:"))).toHaveLength(2);
    expect(ids.every((id) => db.appliedMigrations.has(id))).toBe(true);
    expect([...db.appliedMigrations]).not.toContainEqual(
      expect.stringMatching(/^schema-(?:index-column|unique-index):/),
    );
  });

  it("replaces stale v2 indexes but keeps generated columns", async () => {
    const db = new InMemoryDatabase();
    const schema = postsSchema();
    const manifest = (indexes: readonly (readonly string[])[]) => ({
      ...schema,
      spec: { ...schema.spec, indexes },
    } as const);
    const runtime = (indexes: readonly (readonly string[])[]) =>
      createCmsRuntime({
        manifests: [manifest(indexes)],
        db,
        assets: noopAssets,
      });

    await runtime([["slug"]]);
    const first = schemaIndexMigrations([manifest([["slug"]])]);
    await runtime([["slug", "title"]]);
    const second = schemaIndexMigrations([manifest([["slug", "title"]])]);

    expect(db.appliedMigrations.has(first.find(({ id }) =>
      id.startsWith("schema-index-v2:index:"))!.id)).toBe(false);
    expect(db.appliedMigrations.has(second.find(({ id }) =>
      id.startsWith("schema-index-v2:index:"))!.id)).toBe(true);
    for (const { id } of first.filter(({ id }) =>
      id.startsWith("schema-index-v2:column:"))) {
      expect(db.appliedMigrations.has(id)).toBe(true);
    }

    await runtime([["slug"]]);
    expect(db.appliedMigrations.has(first.find(({ id }) =>
      id.startsWith("schema-index-v2:index:"))!.id)).toBe(true);
    expect(db.appliedMigrations.has(second.find(({ id }) =>
      id.startsWith("schema-index-v2:index:"))!.id)).toBe(false);
  });

  it("retains declared alpha.59 unique indexes and removes retired ones", async () => {
    const db = new InMemoryDatabase();
    const legacyId = "schema-unique-index:uq_posts__slug";
    db.appliedMigrations.add(legacyId);
    db.legacyIndexColumns.set("uq_posts__slug", ["posts__slug"]);
    const schema = postsSchema();
    const runtime = (uniqueIndexes: readonly (readonly string[])[]) =>
      createCmsRuntime({
        manifests: [{ ...schema, spec: { ...schema.spec, uniqueIndexes } }],
        db,
        assets: noopAssets,
      });

    await runtime([["slug"]]);
    expect(db.appliedMigrations.has(legacyId)).toBe(true);

    await runtime([]);
    expect(db.appliedMigrations.has(legacyId)).toBe(false);
  });

  it("drops an ambiguous alpha.59 index-name collision", async () => {
    const db = new InMemoryDatabase();
    const legacyId = "schema-unique-index:uq_posts__a_b";
    db.appliedMigrations.add(legacyId);
    db.legacyIndexColumns.set("uq_posts__a_b", ["posts__a_b"]);
    const schema = postsSchema();
    await createCmsRuntime({
      manifests: [{
        ...schema,
        spec: {
          ...schema.spec,
          schema: {
            type: "object",
            properties: { "a.b": { type: "string" } },
          },
          searchableFields: [],
          uniqueIndexes: [["a.b"]],
        },
      }],
      db,
      assets: noopAssets,
    });

    expect(db.appliedMigrations.has(legacyId)).toBe(false);
    expect(db.legacyIndexColumns.has("uq_posts__a_b")).toBe(false);
  });

  it("rejects creation with BootValidationError when a handler ref is missing", async () => {
    const db = new InMemoryDatabase();
    await expect(createCmsRuntime({
      manifests: [makeProcedure({ handlerRef: "missing" })],
      db,
      assets: noopAssets,
    })).rejects.toBeInstanceOf(BootValidationError);
  });

  it("seeds media.purposes and readMediaPurposes returns them (#272 policy shape)", async () => {
    const db = new InMemoryDatabase();
    const seeded = [
      {
        name: "post-cover",
        required: ["image/avif", "image/webp", "image/jpeg"],
        maxBytes: {
          "image/avif": 200_000,
          "image/webp": 300_000,
          "image/jpeg": 500_000,
        },
      },
      {
        name: "product-gallery",
        required: ["image/avif", "image/webp", "image/jpeg"],
        maxBytes: {
          "image/avif": 250_000,
          "image/webp": 400_000,
          "image/jpeg": 600_000,
        },
      },
    ] as const;
    await createCmsRuntime({
      manifests: [],
      db,
      assets: noopAssets,
      siteDefaults: { media: { purposes: seeded } },
    });
    const repo = new DatabaseSiteConfigRepository(db);
    const purposes = await repo.readMediaPurposes();
    expect(purposes.map((p) => p.name).sort()).toEqual(["post-cover", "product-gallery"]);
    expect(purposes.find((p) => p.name === "post-cover")?.maxBytes["image/avif"]).toBe(200_000);
    const site = await repo.load();
    expect(site.media.purposes.map((p) => p.name).sort()).toEqual([
      "post-cover",
      "product-gallery",
    ]);
  });

  it("readMediaPurposes returns empty when siteDefaults declares none", async () => {
    const db = new InMemoryDatabase();
    await createCmsRuntime({
      manifests: [],
      db,
      assets: noopAssets,
      siteDefaults: { brand: "No-media starter" },
    });
    const purposes = await new DatabaseSiteConfigRepository(db).readMediaPurposes();
    expect(purposes).toEqual([]);
  });

  it("seedSiteDefaults respects ON CONFLICT DO NOTHING semantics", async () => {
    const db = new InMemoryDatabase();
    await createCmsRuntime({
      manifests: [],
      db,
      assets: noopAssets,
      siteDefaults: { brand: "First" },
    });
    // Operator edits the brand directly:
    db.siteConfig.set("brand", "Operator-Edited");
    const writesBeforeReboot = db.executions.filter(({ sql }) =>
      sql.startsWith("INSERT INTO site_config")
    ).length;
    // Subsequent boot with new defaults must NOT overwrite the operator's edit.
    await createCmsRuntime({
      manifests: [],
      db,
      assets: noopAssets,
      siteDefaults: { brand: "Second" },
    });
    const site = await new DatabaseSiteConfigRepository(db).load();
    expect(site.brand).toBe("Operator-Edited");
    expect(db.executions.filter(({ sql }) => sql.startsWith("INSERT INTO site_config")))
      .toHaveLength(writesBeforeReboot);
  });

  it("re-boot syncs a custom-domain origin while preserving operator-owned settings", async () => {
    const db = new InMemoryDatabase();
    await createCmsRuntime({
      manifests: [],
      db,
      assets: noopAssets,
      siteDefaults: { brand: "First", origin: "https://site.workers.dev" },
    });
    db.siteConfig.set("brand", "Operator-Edited");

    await createCmsRuntime({
      manifests: [],
      db,
      assets: noopAssets,
      siteDefaults: { brand: "Second", origin: "https://www.example.com" },
    });

    const site = await new DatabaseSiteConfigRepository(db).load();
    expect(site.origin).toBe("https://www.example.com");
    expect(site.brand).toBe("Operator-Edited");
  });

  it("uses one code-canonical icon set and reads legacy favicon rows", async () => {
    const db = new InMemoryDatabase();
    db.siteConfig.set("faviconUrl", "/legacy.svg");
    const repo = new DatabaseSiteConfigRepository(db);
    expect((await repo.load()).icons).toEqual([{ src: "/legacy.svg" }]);

    await createCmsRuntime({
      manifests: [],
      db,
      assets: noopAssets,
      siteDefaults: {
        icons: [
          { src: "/site-icon.png", mimeType: "image/png", sizes: ["64x64"] },
          { src: "/site-icon.svg", mimeType: "image/svg+xml", sizes: ["any"] },
        ],
      },
    });
    expect((await repo.load()).icons).toEqual([
      { src: "/site-icon.png", mimeType: "image/png", sizes: ["64x64"] },
      { src: "/site-icon.svg", mimeType: "image/svg+xml", sizes: ["any"] },
    ]);
  });

  it("updates only provided editable site settings in one batch", async () => {
    class CountingDatabase extends InMemoryDatabase {
      batches = 0;

      override async batch(stmts: Parameters<InMemoryDatabase["batch"]>[0]) {
        this.batches += 1;
        return super.batch(stmts);
      }
    }

    const db = new CountingDatabase();
    db.siteConfig.set("brand", "Old brand");
    db.siteConfig.set("title", "Keep title");
    db.siteConfig.set("description", "Old description");
    db.siteConfig.set("origin", "https://example.com");
    const repo = new DatabaseSiteConfigRepository(db);

    await repo.updateEditable({
      brand: "New brand",
      title: "New title",
      description: "",
      ga4MeasurementId: "G-TEST",
      facebookPixelId: "PIXEL-TEST",
    });

    expect(db.batches).toBe(1);
    expect(db.siteConfig.get("brand")).toBe("New brand");
    expect(db.siteConfig.get("title")).toBe("New title");
    expect(db.siteConfig.get("description")).toBe("");
    expect(db.siteConfig.get("ga4MeasurementId")).toBe("G-TEST");
    expect(db.siteConfig.get("facebookPixelId")).toBe("PIXEL-TEST");
    expect(db.siteConfig.get("origin")).toBe("https://example.com");

    await repo.updateEditable({});
    expect(db.batches).toBe(1);
  });

  it("#441 re-boot syncs mediaPurposes from config even after first boot wrote a different value", async () => {
    const db = new InMemoryDatabase();
    const first = [
      {
        name: "post-cover",
        required: ["image/jpeg"],
        maxBytes: { "image/jpeg": 500_000 },
      },
    ] as const;
    await createCmsRuntime({
      manifests: [],
      db,
      assets: noopAssets,
      siteDefaults: { media: { purposes: first } },
    });
    const repo = new DatabaseSiteConfigRepository(db);
    expect((await repo.readMediaPurposes()).map((p) => p.name)).toEqual(["post-cover"]);

    // Config changes (new purpose, adjusted maxBytes) — as if a
    // developer edited `src/mantle/config.ts > siteDefaults.media.purposes`
    // and redeployed. Boot again against the same DB.
    const second = [
      {
        name: "post-cover",
        required: ["image/jpeg"],
        maxBytes: { "image/jpeg": 900_000 },
      },
      {
        name: "product-gallery",
        required: ["image/avif", "image/webp", "image/jpeg"],
        maxBytes: { "image/avif": 250_000, "image/webp": 400_000, "image/jpeg": 600_000 },
      },
    ] as const;
    await createCmsRuntime({
      manifests: [],
      db,
      assets: noopAssets,
      siteDefaults: { media: { purposes: second } },
    });

    const purposes = await repo.readMediaPurposes();
    expect(purposes.map((p) => p.name).sort()).toEqual(["post-cover", "product-gallery"]);
    expect(purposes.find((p) => p.name === "post-cover")?.maxBytes["image/jpeg"]).toBe(900_000);
    const site = await repo.load();
    expect(site.media.purposes.map((p) => p.name).sort()).toEqual([
      "post-cover",
      "product-gallery",
    ]);
  });

  it("#441 re-boot syncs locales from config (no admin-UI edit path) while brand (UI-editable) stays operator-owned", async () => {
    const db = new InMemoryDatabase();
    await createCmsRuntime({
      manifests: [],
      db,
      assets: noopAssets,
      siteDefaults: { brand: "First", locales: ["en"] },
    });
    const repo = new DatabaseSiteConfigRepository(db);
    expect(await repo.readLocales()).toEqual(["en"]);

    // Operator edits brand directly via the admin settings UI.
    db.siteConfig.set("brand", "Operator-Edited");

    // Developer adds a locale in `src/mantle/config.ts` and redeploys.
    await createCmsRuntime({
      manifests: [],
      db,
      assets: noopAssets,
      siteDefaults: { brand: "Second", locales: ["en", "ja"] },
    });

    expect(await repo.readLocales()).toEqual(["en", "ja"]);
    const site = await repo.load();
    expect(site.brand).toBe("Operator-Edited");
  });
});
