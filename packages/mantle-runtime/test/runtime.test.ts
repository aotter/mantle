import { describe, expect, it } from "vitest";
import { createCmsRuntime } from "../src/runtime.js";
import { BootValidationError } from "../src/usecase/boot/index.js";
import { DatabaseSiteConfigRepository } from "../src/infrastructure/persistence/DatabaseSiteConfigRepository.js";
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

  it("bootInit installs manifest unique indexes", async () => {
    const db = new InMemoryDatabase();
    const schema = postsSchema();
    const runtime = createCmsRuntime({
      manifests: [{
        ...schema,
        spec: { ...schema.spec, uniqueIndexes: [["slug"]] },
      }],
      db,
      kv: new InMemoryKv(),
      assets: noopAssets,
    });

    await runtime.bootInit();

    expect(db.appliedMigrations).toContain("schema-index-column:posts__slug");
    expect(db.appliedMigrations).toContain("schema-unique-index:uq_posts__slug");
  });

  it("bootInit replaces stale manifest unique indexes", async () => {
    const db = new InMemoryDatabase();
    const schema = postsSchema();
    const runtime = (uniqueIndexes: readonly (readonly string[])[]) =>
      createCmsRuntime({
        manifests: [{
          ...schema,
          spec: { ...schema.spec, uniqueIndexes },
        }],
        db,
        kv: new InMemoryKv(),
        assets: noopAssets,
      });

    await runtime([["slug"]]).bootInit();
    await runtime([["slug", "locale"]]).bootInit();

    expect(db.appliedMigrations).not.toContain("schema-unique-index:uq_posts__slug");
    expect(db.appliedMigrations).toContain("schema-unique-index:uq_posts__slug__locale");

    await runtime([["slug"]]).bootInit();
    expect(db.appliedMigrations).toContain("schema-unique-index:uq_posts__slug");
    expect(db.appliedMigrations).not.toContain("schema-unique-index:uq_posts__slug__locale");
  });

  it("bootInit throws BootValidationError when handler ref is missing", async () => {
    const runtime = createCmsRuntime({
      manifests: [makeProcedure({ handlerRef: "missing" })],
      db: new InMemoryDatabase(),
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
    // developer edited `mantleConfig.ts > siteDefaults.media.purposes`
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

    // Developer adds a locale in `mantleConfig.ts` and redeploys.
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
