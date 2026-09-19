import { describe, expect, it } from "vitest";
import {
  DEFAULT_SITE_ICONS,
  linkManifestSet,
  parseManifestSources,
  type Manifest,
  type SiteDefaults,
} from "@aotter/mantle-spec";
import {
  compileRuntimePlan,
  createMantleRuntime,
  prepareDeployment,
  SqliteMantleStorageAdapter,
  type DatabaseDriver,
  type MantleRuntime,
} from "../src/index.js";
import type { AnyHandler } from "../src/domain/model/HandlerContext.js";
import { BootValidationError } from "../src/usecase/boot/index.js";
import { DatabaseSiteConfigRepository } from "../src/infrastructure/persistence/DatabaseSiteConfigRepository.js";
import { schemaTableMigrations } from "../src/infrastructure/storage/SqliteSchemaTables.js";
import { InMemoryDatabase } from "./fakes/database.js";
import { makeProcedure, postsSchema } from "./fakes/manifests.js";

describe("SQLite runtime composition", () => {
  it("prepares storage, seeds siteDefaults, and validates before returning", async () => {
    const db = new InMemoryDatabase();
    await createTestRuntime({
      manifests: [makeProcedure()],
      handlers: { echoHandler: () => ({ ok: true }) },
      db,
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
      siteDefaults: { brand: "Blog", locales: ["en"] },
    } as const;

    await createTestRuntime(options);
    const firstBootQueries = db.executions.length;
    await createTestRuntime(options);

    expect(db.executions.slice(firstBootQueries).map(({ sql }) => sql)).toEqual([
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND lower(name) = 'entries' LIMIT 1",
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
    const runtime = await createTestRuntime({
      manifests: [postsSchema(), operational],
      db: new InMemoryDatabase(),
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
      collection: created.collection,
      expectedVersion: created.version,
      data: { title: "Updated" },
    });
    const published = await runtime.requestPublish.execute({ id: updated.id, collection: updated.collection });
    const draft = await runtime.unpublish.execute({ id: published.id, collection: published.collection });
    await runtime.deleteEntry.execute({ id: draft.id, collection: draft.collection });
    await runtime.updateSiteSettings!.execute({ title: "New title" });
    await runtime.createDraft.execute({
      collection: "events",
      data: { title: "Private event", slug: "private-event", content: "Operational" },
      authorId: null,
    });

    expect(calls).toHaveLength(6);
  });

  it("keeps a committed content write successful when cache invalidation fails", async () => {
    const error = console.error;
    console.error = () => undefined;
    try {
      const runtime = await createTestRuntime({
        manifests: [postsSchema()],
        db: new InMemoryDatabase(),
        onPublicChange: async () => { throw new Error("purge unavailable"); },
      });

      await expect(runtime.createDraft.execute({
        collection: "posts",
        data: { title: "Saved", slug: "saved", content: "Body" },
        authorId: null,
      })).resolves.toMatchObject({ data: { title: "Saved" } });
    } finally {
      console.error = error;
    }
  });

  it("installs native Schema columns and indexes", async () => {
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
    await createTestRuntime({
      manifests: [indexedSchema],
      db,
    });

    const ids = schemaTableMigrations([indexedSchema]).map(({ id }) => id);
    expect(ids.filter((id) => id.startsWith("schema-table-v2:column:"))).toHaveLength(4);
    expect(ids.filter((id) => id.startsWith("schema-table-v2:index:"))).toHaveLength(5);
    expect(ids.every((id) => db.appliedMigrations.has(id))).toBe(true);
    expect(db.native().prepare('PRAGMA table_info("posts")').all().map((row) => row.name))
      .toEqual(expect.arrayContaining(["_mantle_id", "_mantle_status", "title", "slug", "content"]));
  });

  it("allows additive fields and keeps removed fields or non-unique indexes for rollback", async () => {
    const db = new InMemoryDatabase();
    const schema = postsSchema();
    await createTestRuntime({
      manifests: [{ ...schema, spec: { ...schema.spec, indexes: [["slug"]] } }],
      db,
    });
    const additive = { ...schema, spec: { ...schema.spec, schema: {
      ...schema.spec.schema,
      properties: { ...schema.spec.schema.properties, subtitle: { type: "string" } },
    }, indexes: [["slug"]] } } as const;
    await expect(createTestRuntime({ manifests: [additive], db })).resolves.toBeDefined();
    await expect(createTestRuntime({ manifests: [schema], db })).resolves.toBeDefined();
    expect(db.native().prepare('PRAGMA table_info("posts")').all().map((row) => row.name)).toContain("subtitle");
  });

  it("rejects creation with BootValidationError when a handler ref is missing", async () => {
    const db = new InMemoryDatabase();
    await expect(createTestRuntime({
      manifests: [makeProcedure({ handlerRef: "missing" })],
      db,
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
    await createTestRuntime({
      manifests: [],
      db,
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
    await createTestRuntime({
      manifests: [],
      db,
      siteDefaults: { brand: "No-media starter" },
    });
    const purposes = await new DatabaseSiteConfigRepository(db).readMediaPurposes();
    expect(purposes).toEqual([]);
  });

  it("seedSiteDefaults respects ON CONFLICT DO NOTHING semantics", async () => {
    const db = new InMemoryDatabase();
    await createTestRuntime({
      manifests: [],
      db,
      siteDefaults: { brand: "First" },
    });
    // Operator edits the brand directly:
    db.siteConfig.set("brand", "Operator-Edited");
    const writesBeforeReboot = db.executions.filter(({ sql }) =>
      sql.startsWith("INSERT INTO site_config")
    ).length;
    // Subsequent boot with new defaults must NOT overwrite the operator's edit.
    await createTestRuntime({
      manifests: [],
      db,
      siteDefaults: { brand: "Second" },
    });
    const site = await new DatabaseSiteConfigRepository(db).load();
    expect(site.brand).toBe("Operator-Edited");
    expect(db.executions.filter(({ sql }) => sql.startsWith("INSERT INTO site_config")))
      .toHaveLength(writesBeforeReboot);
  });

  it("re-boot syncs a custom-domain origin while preserving operator-owned settings", async () => {
    const db = new InMemoryDatabase();
    await createTestRuntime({
      manifests: [],
      db,
      siteDefaults: { brand: "First", origin: "https://site.workers.dev" },
    });
    db.siteConfig.set("brand", "Operator-Edited");

    await createTestRuntime({
      manifests: [],
      db,
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

    await createTestRuntime({
      manifests: [],
      db,
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

    await createTestRuntime({ manifests: [], db, siteDefaults: {} });
    expect((await repo.load()).icons).toEqual(DEFAULT_SITE_ICONS);
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
    });

    expect(db.batches).toBe(1);
    expect(db.siteConfig.get("brand")).toBe("New brand");
    expect(db.siteConfig.get("title")).toBe("New title");
    expect(db.siteConfig.get("description")).toBe("");
    expect(db.siteConfig.get("origin")).toBe("https://example.com");

    await repo.updateEditable({});
    expect(db.batches).toBe(1);
  });

  it("ignores leftover ga4MeasurementId and facebookPixelId rows on load", async () => {
    const db = new InMemoryDatabase();
    db.siteConfig.set("brand", "Mantle");
    db.siteConfig.set("title", "Mantle site");
    db.siteConfig.set("ga4MeasurementId", "G-LEFTOVER");
    db.siteConfig.set("facebookPixelId", "1234567890");
    const site = await new DatabaseSiteConfigRepository(db).load();

    expect(site.brand).toBe("Mantle");
    expect(site.title).toBe("Mantle site");
    expect(site).not.toHaveProperty("ga4MeasurementId");
    expect(site).not.toHaveProperty("facebookPixelId");
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
    await createTestRuntime({
      manifests: [],
      db,
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
    await createTestRuntime({
      manifests: [],
      db,
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
    await createTestRuntime({
      manifests: [],
      db,
      siteDefaults: { brand: "First", locales: ["en"] },
    });
    const repo = new DatabaseSiteConfigRepository(db);
    expect(await repo.readLocales()).toEqual(["en"]);

    // Operator edits brand directly via the admin settings UI.
    db.siteConfig.set("brand", "Operator-Edited");

    // Developer adds a locale in `src/mantle/config.ts` and redeploys.
    await createTestRuntime({
      manifests: [],
      db,
      siteDefaults: { brand: "Second", locales: ["en", "ja"] },
    });

    expect(await repo.readLocales()).toEqual(["en", "ja"]);
    const site = await repo.load();
    expect(site.brand).toBe("Operator-Edited");
  });
});

async function createTestRuntime(args: {
  readonly manifests: readonly Manifest[];
  readonly db: DatabaseDriver;
  readonly handlers?: Readonly<Record<string, AnyHandler>>;
  readonly siteDefaults?: SiteDefaults;
  readonly onPublicChange?: () => Promise<void>;
}): Promise<MantleRuntime> {
  const parsed = parseManifestSources({
    sources: args.manifests.map((manifest, index) => ({
      sourceId: `test:${index}`,
      text: JSON.stringify(manifest),
    })),
  });
  if (!parsed.ok) throw new BootValidationError(parsed.diagnostics);
  const linked = linkManifestSet(parsed.value);
  if (!linked.ok) throw new BootValidationError(linked.diagnostics);
  const compiled = compileRuntimePlan(linked.value);
  if (!compiled.ok) throw new BootValidationError(compiled.diagnostics);
  const storage = new SqliteMantleStorageAdapter(args.db, args.siteDefaults);
  const prepared = await prepareDeployment(compiled.value, storage, {
    handlerNames: Object.keys(args.handlers ?? {}),
  });
  return createMantleRuntime({
    prepared,
    handlers: args.handlers,
    ports: { onPublishingContentChange: args.onPublicChange },
  });
}
