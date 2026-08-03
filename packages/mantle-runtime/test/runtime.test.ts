import { describe, expect, it } from "vitest";
import { createCmsRuntime } from "../src/runtime.js";
import { BootValidationError } from "../src/usecase/boot/index.js";
import { DatabaseSiteConfigRepository } from "../src/infrastructure/persistence/DatabaseSiteConfigRepository.js";
import { schemaIndexMigrations } from "../src/infrastructure/boot/index.js";
import { InMemoryDatabase } from "./fakes/database.js";
import { InMemoryKv } from "./fakes/kv.js";
import { makeProcedure, postsSchema } from "./fakes/manifests.js";
import type { AssetServer } from "../src/domain/port/index.js";

const noopAssets: AssetServer = {
  async fetch() {
    return null;
  },
};

describe("createCmsRuntime + bootInit", () => {
  it("constructs with empty manifests + required ports", async () => {
    const runtime = createCmsRuntime({
      manifests: [],
      db: new InMemoryDatabase(),
      kv: new InMemoryKv(),
      assets: noopAssets,
    });
    expect(runtime.schemasByName.size).toBe(0);
    expect(runtime.proceduresByName.size).toBe(0);
    expect(runtime.viewsByName.size).toBe(0);
  });

  it("bootInit runs migrations + seeds siteDefaults + validates", async () => {
    const db = new InMemoryDatabase();
    const runtime = createCmsRuntime({
      manifests: [makeProcedure()],
      handlers: { echoHandler: () => ({ ok: true }) },
      db,
      kv: new InMemoryKv(),
      assets: noopAssets,
      siteDefaults: {
        brand: "Blog",
        title: "Blog Site",
        description: "A nice place.",
        origin: "https://example.com",
      },
    });
    await runtime.bootInit();
    expect(db.appliedMigrations.has("0001-init")).toBe(true);
    const site = await new DatabaseSiteConfigRepository(db).load();
    expect(site.brand).toBe("Blog");
    expect(site.title).toBe("Blog Site");
    expect(site.description).toBe("A nice place.");
    expect(site.origin).toBe("https://example.com");
  });

  it("bootInit installs manifest Schema indexes", async () => {
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
    const runtime = createCmsRuntime({
      manifests: [indexedSchema],
      db,
      kv: new InMemoryKv(),
      assets: noopAssets,
    });

    await runtime.bootInit();

    const ids = schemaIndexMigrations([indexedSchema]).map(({ id }) => id);
    expect(ids).toHaveLength(4);
    expect(ids.filter((id) => id.startsWith("schema-index-v2:column:"))).toHaveLength(2);
    expect(ids.filter((id) => id.startsWith("schema-index-v2:index:"))).toHaveLength(2);
    expect(ids.every((id) => db.appliedMigrations.has(id))).toBe(true);
    expect([...db.appliedMigrations]).not.toContainEqual(
      expect.stringMatching(/^schema-(?:index-column|unique-index):/),
    );
  });

  it("bootInit replaces stale v2 indexes but keeps generated columns", async () => {
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
        kv: new InMemoryKv(),
        assets: noopAssets,
      });

    await runtime([["slug"]]).bootInit();
    const first = schemaIndexMigrations([manifest([["slug"]])]);
    await runtime([["slug", "title"]]).bootInit();
    const second = schemaIndexMigrations([manifest([["slug", "title"]])]);

    expect(db.appliedMigrations.has(first.find(({ id }) =>
      id.startsWith("schema-index-v2:index:"))!.id)).toBe(false);
    expect(db.appliedMigrations.has(second.find(({ id }) =>
      id.startsWith("schema-index-v2:index:"))!.id)).toBe(true);
    for (const { id } of first.filter(({ id }) =>
      id.startsWith("schema-index-v2:column:"))) {
      expect(db.appliedMigrations.has(id)).toBe(true);
    }

    await runtime([["slug"]]).bootInit();
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
        kv: new InMemoryKv(),
        assets: noopAssets,
      });

    await runtime([["slug"]]).bootInit();
    expect(db.appliedMigrations.has(legacyId)).toBe(true);

    await runtime([]).bootInit();
    expect(db.appliedMigrations.has(legacyId)).toBe(false);
  });

  it("drops an ambiguous alpha.59 index-name collision", async () => {
    const db = new InMemoryDatabase();
    const legacyId = "schema-unique-index:uq_posts__a_b";
    db.appliedMigrations.add(legacyId);
    db.legacyIndexColumns.set("uq_posts__a_b", ["posts__a_b"]);
    const schema = postsSchema();
    const runtime = createCmsRuntime({
      manifests: [{
        ...schema,
        spec: {
          ...schema.spec,
          schema: {
            type: "object",
            properties: { "a.b": { type: "string" } },
          },
          uniqueIndexes: [["a.b"]],
        },
      }],
      db,
      kv: new InMemoryKv(),
      assets: noopAssets,
    });

    await runtime.bootInit();

    expect(db.appliedMigrations.has(legacyId)).toBe(false);
    expect(db.legacyIndexColumns.has("uq_posts__a_b")).toBe(false);
  });

  it("rejects invalid Schema indexes before running dynamic index migrations", async () => {
    const db = new InMemoryDatabase();
    const schema = postsSchema();
    const runtime = createCmsRuntime({
      manifests: [{
        ...schema,
        spec: { ...schema.spec, indexes: [["missing"]] },
      }],
      db,
      kv: new InMemoryKv(),
      assets: noopAssets,
    });

    const error = await runtime.bootInit().catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(BootValidationError);
    expect((error as BootValidationError).diagnostics[0]?.code).toBe(
      "SCHEMA_INDEX_FIELD_UNKNOWN",
    );
    expect(db.appliedMigrations.has("0001-init")).toBe(true);
    expect([...db.appliedMigrations]).not.toContainEqual(
      expect.stringMatching(/^schema-index-v2:/),
    );
  });

  it("bootInit throws BootValidationError when handler ref is missing", async () => {
    const db = new InMemoryDatabase();
    const runtime = createCmsRuntime({
      manifests: [makeProcedure({ handlerRef: "missing" })],
      db,
      kv: new InMemoryKv(),
      assets: noopAssets,
    });
    await expect(runtime.bootInit()).rejects.toBeInstanceOf(BootValidationError);
  });

  it("bootInit seeds media.purposes and readMediaPurposes returns them (#272 policy shape)", async () => {
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
    const runtime = createCmsRuntime({
      manifests: [],
      db,
      kv: new InMemoryKv(),
      assets: noopAssets,
      siteDefaults: { media: { purposes: seeded } },
    });
    await runtime.bootInit();
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
    const runtime = createCmsRuntime({
      manifests: [],
      db,
      kv: new InMemoryKv(),
      assets: noopAssets,
      siteDefaults: { brand: "No-media starter" },
    });
    await runtime.bootInit();
    const purposes = await new DatabaseSiteConfigRepository(db).readMediaPurposes();
    expect(purposes).toEqual([]);
  });

  it("seedSiteDefaults respects ON CONFLICT DO NOTHING semantics", async () => {
    const db = new InMemoryDatabase();
    const runtime = createCmsRuntime({
      manifests: [],
      db,
      kv: new InMemoryKv(),
      assets: noopAssets,
      siteDefaults: { brand: "First" },
    });
    await runtime.bootInit();
    // Operator edits the brand directly:
    db.siteConfig.set("brand", "Operator-Edited");
    // Subsequent boot with new defaults must NOT overwrite the operator's edit.
    const runtime2 = createCmsRuntime({
      manifests: [],
      db,
      kv: new InMemoryKv(),
      assets: noopAssets,
      siteDefaults: { brand: "Second" },
    });
    await runtime2.bootInit();
    const site = await new DatabaseSiteConfigRepository(db).load();
    expect(site.brand).toBe("Operator-Edited");
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
    const runtime = createCmsRuntime({
      manifests: [],
      db,
      kv: new InMemoryKv(),
      assets: noopAssets,
      siteDefaults: { media: { purposes: first } },
    });
    await runtime.bootInit();
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
    const runtime2 = createCmsRuntime({
      manifests: [],
      db,
      kv: new InMemoryKv(),
      assets: noopAssets,
      siteDefaults: { media: { purposes: second } },
    });
    await runtime2.bootInit();

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
    const runtime = createCmsRuntime({
      manifests: [],
      db,
      kv: new InMemoryKv(),
      assets: noopAssets,
      siteDefaults: { brand: "First", locales: ["en"] },
    });
    await runtime.bootInit();
    const repo = new DatabaseSiteConfigRepository(db);
    expect(await repo.readLocales()).toEqual(["en"]);

    // Operator edits brand directly via the admin settings UI.
    db.siteConfig.set("brand", "Operator-Edited");

    // Developer adds a locale in `src/mantle/config.ts` and redeploys.
    const runtime2 = createCmsRuntime({
      manifests: [],
      db,
      kv: new InMemoryKv(),
      assets: noopAssets,
      siteDefaults: { brand: "Second", locales: ["en", "ja"] },
    });
    await runtime2.bootInit();

    expect(await repo.readLocales()).toEqual(["en", "ja"]);
    const site = await repo.load();
    expect(site.brand).toBe("Operator-Edited");
  });
});
