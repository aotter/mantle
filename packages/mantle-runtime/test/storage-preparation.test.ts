import {
  linkManifestSet,
  parseManifestSources,
  type LinkedManifestSet,
} from "@aotter/mantle-spec";
import { describe, expect, it, vi } from "vitest";
import type {
  MantleStorageAdapter,
  PreparedMantleStorage,
  SiteConfigRepository,
  ViewQueryExecutor,
} from "../src/domain/port/index.js";
import {
  compileRuntimePlan,
  type RuntimePlan,
} from "../src/domain/service/RuntimePlanCompiler.js";
import { SqliteMantleStorageAdapter } from "../src/infrastructure/storage/SqliteMantleStorageAdapter.js";
import { CANONICAL_MIGRATIONS } from "../src/infrastructure/boot/canonicalMigrations.js";
import { readStoreInstanceId } from "../src/infrastructure/boot/bootState.js";
import { buildSqliteMigrationArtifact } from "../src/infrastructure/storage/SqliteMigrationArtifact.js";
import { createMantleRuntime } from "../src/MantleRuntime.js";
import {
  BootValidationError,
  prepareDeployment,
} from "../src/usecase/boot/ValidateBootUseCase.js";
import { InMemoryDatabase } from "./fakes/database.js";
import { InMemoryEntryRepository } from "./fakes/in-memory-store.js";

describe("prepareDeployment", () => {
  it("rejects TTL on an adapter that cannot filter expired reads", async () => {
    const plan = compilePlan(`apiVersion: cms.mantle.aotter.net/v1
kind: Schema
metadata: { name: events }
spec:
  title: Events
  ttl: { field: expiresAt, expireAfterSeconds: 0 }
  schema:
    type: object
    properties:
      expiresAt: { type: string, format: date-time }
`);
    const prepare = vi.fn();
    await expect(prepareDeployment(plan, { prepare })).rejects.toThrow("RESOURCE_UNAVAILABLE");
    expect(prepare).not.toHaveBeenCalled();
  });

  it("prepares an official adapter over an existing database handle once", async () => {
    const db = new InMemoryDatabase();
    const plan = compilePlan(declarativeManifest);
    const adapter = new SqliteMantleStorageAdapter(db, { locales: ["en"] });
    const prepared = await prepareDeployment(plan, adapter);
    const storeInstanceId = db.native()
      .prepare("SELECT store_instance_id FROM _mantle_boot_state WHERE id = ?")
      .get("runtime")!.store_instance_id;

    expect(prepared.plan).toBe(plan);
    expect(await prepared.storage.localePolicy?.readLocales()).toEqual(["en"]);

    await prepared.storage.entries.create({
      id: "post-1",
      collection: "posts",
      status: "published",
      data: { title: "Hello" },
      authorId: null,
      now: 1,
    });
    const result = await prepared.storage.views.execute<{ id: string; title: string }>({
      view: "published-posts",
    });
    expect(result.rows).toEqual([{ id: "post-1", title: "Hello" }]);

    const before = db.executions.length;
    await prepareDeployment(plan, adapter);
    expect(db.native().prepare("SELECT store_instance_id FROM _mantle_boot_state WHERE id = ?")
      .get("runtime")!.store_instance_id).toBe(storeInstanceId);
    expect(db.executions.slice(before).map(({ sql }) => sql)).toEqual([
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND lower(name) = 'entries' LIMIT 1",
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN ('_migrations', '_mantle_storage_state', '_mantle_managed_runtime_state')",
      "SELECT canonical_version FROM _mantle_managed_runtime_state WHERE id = 1",
      "SELECT fingerprint, store_instance_id FROM _mantle_boot_state WHERE id = ? LIMIT 1",
    ]);
  });

  it("mints a store identity when upgrading an existing boot marker", async () => {
    const db = new InMemoryDatabase();
    await db.migrations.runAll(CANONICAL_MIGRATIONS.slice(0, 4));
    db.native().prepare("INSERT INTO _mantle_boot_state(id, fingerprint) VALUES (?, ?)")
      .run("runtime", "legacy");

    await prepareDeployment(compilePlan(declarativeManifest), new SqliteMantleStorageAdapter(db));

    expect(db.native().prepare("SELECT store_instance_id FROM _mantle_boot_state WHERE id = ?")
      .get("runtime")!.store_instance_id).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it("mints a store identity for externally migrated managed storage", async () => {
    const db = new InMemoryDatabase();
    const plan = compilePlan(declarativeManifest);
    const schemas = Object.values(plan.schemas).map(({ manifest }) => manifest);
    const artifact = await buildSqliteMigrationArtifact([], schemas);
    await db.migrations.runAll(artifact.migrations);
    for (const { name, projection } of artifact.projections) {
      await db.prepare("INSERT INTO _mantle_schema_tables(name, projection) VALUES (?, ?)")
        .bind(name, projection).run();
    }
    await db.prepare("INSERT INTO _mantle_storage_state(id, fingerprint) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET fingerprint = excluded.fingerprint")
      .bind(artifact.targetFingerprint).run();
    await db.prepare("INSERT INTO _mantle_managed_runtime_state(id, canonical_version) VALUES (1, ?)")
      .bind(artifact.targetCanonicalVersion).run();

    const adapter = new SqliteMantleStorageAdapter(db, undefined, {
      managedStorageFingerprint: artifact.targetFingerprint,
    });
    await prepareDeployment(plan, adapter);

    const storeInstanceId = await readStoreInstanceId(db);
    expect(storeInstanceId).toMatch(/^[0-9a-f-]{36}$/u);
    await prepareDeployment(plan, adapter);
    await expect(readStoreInstanceId(db)).resolves.toBe(storeInstanceId);

    await db.prepare("UPDATE _mantle_managed_runtime_state SET canonical_version = 'old' WHERE id = 1").run();
    await expect(prepareDeployment(plan, adapter)).rejects.toThrow("pending runtime migration");
    await db.prepare("UPDATE _mantle_managed_runtime_state SET canonical_version = ? WHERE id = 1")
      .bind(artifact.targetCanonicalVersion).run();
    await expect(prepareDeployment(plan, new SqliteMantleStorageAdapter(db)))
      .rejects.toThrow("cannot use runtime-managed migrations");

    await db.prepare("UPDATE _mantle_storage_state SET fingerprint = 'pending' WHERE id = 1").run();
    await expect(prepareDeployment(plan, new SqliteMantleStorageAdapter(db, undefined, {
      managedStorageFingerprint: artifact.targetFingerprint,
    }))).rejects.toThrow("pending migration");
    expect((await db.prepare("SELECT fingerprint FROM _mantle_storage_state WHERE id = 1").first<{ fingerprint: string }>())?.fingerprint)
      .toBe("pending");

    await db.prepare("UPDATE _mantle_storage_state SET fingerprint = ? WHERE id = 1")
      .bind(artifact.targetFingerprint).run();
    await db.prepare('DROP TABLE "posts"').run();
    await expect(prepareDeployment(plan, new SqliteMantleStorageAdapter(db, undefined, {
      managedStorageFingerprint: artifact.targetFingerprint,
    }))).rejects.toThrow("Schema table 'posts' is missing");
  });

  it("keeps an older managed plan available after an additive Schema migration", async () => {
    const db = new InMemoryDatabase();
    const oldPlan = compilePlan(declarativeManifest);
    const newPlan = compilePlan(declarativeManifest.replace(
      "      title: { type: string }",
      "      title: { type: string }\n      rank: { type: integer }",
    ));
    const oldSchemas = Object.values(oldPlan.schemas).map(({ manifest }) => manifest);
    const newSchemas = Object.values(newPlan.schemas).map(({ manifest }) => manifest);
    const initial = await buildSqliteMigrationArtifact([], oldSchemas);
    await db.migrations.runAll(initial.migrations);
    for (const { name, projection } of initial.projections) {
      await db.prepare("INSERT INTO _mantle_schema_tables(name, projection) VALUES (?, ?)").bind(name, projection).run();
    }
    await db.prepare("INSERT INTO _mantle_storage_state(id, fingerprint) VALUES (1, ?)").bind(initial.targetFingerprint).run();
    await db.prepare("INSERT INTO _mantle_managed_runtime_state(id, canonical_version) VALUES (1, ?)")
      .bind(initial.targetCanonicalVersion).run();
    const oldAdapter = new SqliteMantleStorageAdapter(db, undefined, { managedStorageFingerprint: initial.targetFingerprint });
    await prepareDeployment(oldPlan, oldAdapter);
    const upgrade = await buildSqliteMigrationArtifact(oldSchemas, newSchemas, {
      appliedMigrationIds: initial.migrations.map(({ id }) => id),
    });
    await db.migrations.runAll(upgrade.migrations);
    for (const { name, projection } of upgrade.projections) {
      await db.prepare("UPDATE _mantle_schema_tables SET projection = ? WHERE name = ?").bind(projection, name).run();
    }
    await db.prepare("UPDATE _mantle_storage_state SET fingerprint = ? WHERE id = 1").bind(upgrade.targetFingerprint).run();
    await expect(prepareDeployment(oldPlan, oldAdapter)).resolves.toBeDefined();
    await expect(prepareDeployment(newPlan, new SqliteMantleStorageAdapter(db, undefined, {
      managedStorageFingerprint: upgrade.targetFingerprint,
    }))).resolves.toBeDefined();
  });

  it("does not replay runtime migrations on a legacy managed database", async () => {
    const db = new InMemoryDatabase();
    for (const migration of CANONICAL_MIGRATIONS) db.native().exec(migration.sql);
    db.native().exec("INSERT INTO _mantle_storage_state(id, fingerprint) VALUES (1, 'legacy')");
    await expect(prepareDeployment(compilePlan(declarativeManifest), new SqliteMantleStorageAdapter(db)))
      .rejects.toThrow("cannot use runtime-managed migrations");
  });

  it("activates locales on a new adapter over a current database without reseeding", async () => {
    const db = new InMemoryDatabase();
    const plan = compilePlan(declarativeManifest);
    const defaults = { locales: ["en"] };
    await prepareDeployment(plan, new SqliteMantleStorageAdapter(db, defaults));
    const migrations = vi.spyOn(db.migrations, "runAll");
    const before = db.executions.length;
    const fresh = new SqliteMantleStorageAdapter(db, defaults, {
      decorateSiteConfigRepository: (canonical) => ({
        seed: (values) => canonical.seed(values),
        load: () => canonical.load(),
        readLocales: () => canonical.readLocales(),
        readMediaPurposes: () => canonical.readMediaPurposes(),
      }),
    });
    const seed = vi.spyOn(fresh.siteConfig, "seed");
    const prepared = await prepareDeployment(plan, fresh);
    expect(migrations).not.toHaveBeenCalled();
    expect(seed).not.toHaveBeenCalled();
    expect(db.executions.slice(before)).toHaveLength(4);
    for (let i = 0; i < 3; i++) {
      expect(await prepared.storage.localePolicy?.readLocales()).toEqual(["en"]);
    }
    expect(db.executions.slice(before)).toHaveLength(5);
    expect(db.executions.slice(before).every(({ sql }) => sql.startsWith("SELECT"))).toBe(true);

    db.siteConfig.set("title", "Edited live");
    db.siteConfig.set("mediaPurposes", JSON.stringify([{ name: "new-purpose" }]));
    expect((await fresh.siteConfig.load()).title).toBe("Edited live");
    expect(await fresh.siteConfig.readMediaPurposes()).toEqual([{ name: "new-purpose" }]);
  });

  it("isolates locale snapshots by database and resets them when a revision retries", async () => {
    const db = new InMemoryDatabase();
    const defaults = { locales: ["en"] };
    const plan = compilePlan(declarativeManifest);
    const adapter = new SqliteMantleStorageAdapter(db, defaults);
    await prepareDeployment(plan, adapter);
    expect(await adapter.siteConfig.readLocales()).toEqual(["en"]);
    const other = new SqliteMantleStorageAdapter(new InMemoryDatabase(), { locales: ["ja"] });
    await prepareDeployment(plan, other);
    expect(await other.siteConfig.readLocales()).toEqual(["ja"]);

    defaults.locales = ["zh"];
    const runAll = db.migrations.runAll;
    vi.spyOn(db.migrations, "runAll")
      .mockImplementationOnce(runAll)
      .mockRejectedValueOnce(new Error("index reconciliation failed"));
    await expect(prepareDeployment(plan, adapter)).rejects.toThrow("index reconciliation failed");
    defaults.locales = ["fr"];
    await prepareDeployment(plan, adapter);
    expect(await adapter.siteConfig.readLocales()).toEqual(["fr"]);
    const changedPlan = compilePlan(declarativeManifest.replace("Posts", "Updated posts"));
    const seed = vi.spyOn(adapter.siteConfig, "seed");
    await prepareDeployment(changedPlan, adapter);
    expect(seed).toHaveBeenCalledOnce();
    const current = new SqliteMantleStorageAdapter(db, defaults);
    await prepareDeployment(changedPlan, current);
    expect(await current.siteConfig.readLocales()).toEqual(["fr"]);
    expect(await other.siteConfig.readLocales()).toEqual(["ja"]);
  });

  it("uses one injected site-config repository for preparation and runtime binding", async () => {
    const db = new InMemoryDatabase();
    const calls: string[] = [];
    let decorated: SiteConfigRepository | undefined;
    const adapter = new SqliteMantleStorageAdapter(
      db,
      { brand: "Injected" },
      {
        decorateSiteConfigRepository: (canonical) => {
          decorated = {
            seed: async (defaults) => {
              calls.push("seed");
              await canonical.seed(defaults);
            },
            load: () => canonical.load(),
            readLocales: () => canonical.readLocales(),
            readMediaPurposes: () => canonical.readMediaPurposes(),
            updateEditable: async (values) => {
              calls.push("update");
              await canonical.updateEditable?.(values);
            },
          };
          return decorated;
        },
      },
    );

    const prepared = await prepareDeployment(compilePlan(declarativeManifest), adapter);

    expect(prepared.storage.siteConfig).toBe(decorated);
    expect(prepared.storage.localePolicy).toBe(decorated);
    expect(calls).toEqual(["seed"]);
    expect((await prepared.storage.siteConfig?.load()).brand).toBe("Injected");
  });

  it("accepts application-owned semantic ports without a table mapping DSL", async () => {
    const entries = new InMemoryEntryRepository();
    const views: ViewQueryExecutor = {
      async execute(request) {
        const page = await entries.list({
          collection: "posts",
          status: "published",
          limit: request.show,
        });
        return {
          rows: page.rows.map((row) => ({ id: row.id, title: row.data["title"] })),
          page: request.page ?? 1,
          show: request.show ?? 50,
          hasMore: page.nextCursor !== undefined,
        };
      },
    };
    const storage: MantleStorageAdapter = {
      async prepare() {
        return { entries, views };
      },
    };
    const prepared = await prepareDeployment(compilePlan(declarativeManifest), storage);

    await prepared.storage.entries.create({
      id: "app-post",
      collection: "posts",
      status: "published",
      data: { title: "Application table" },
      authorId: "app-user",
      now: 2,
    });
    expect((await prepared.storage.views.execute({ view: "published-posts" })).rows).toEqual([
      { id: "app-post", title: "Application table" },
    ]);
    expect(await prepared.storage.entries.readPublished({ collection: "posts" })).toEqual([
      expect.objectContaining({ id: "app-post", data: { title: "Application table" } }),
    ]);
  });

  it("rejects an unsupported native dialect before touching storage", async () => {
    let called = false;
    const storage: MantleStorageAdapter = {
      async prepare(): Promise<PreparedMantleStorage> {
        called = true;
        throw new Error("must not prepare");
      },
    };

    await expect(prepareDeployment(compilePlan(nativeManifest), storage))
      .rejects.toMatchObject<Partial<BootValidationError>>({
        diagnostics: [expect.objectContaining({
          code: "VIEW_DIALECT_UNSUPPORTED",
          phase: "boot",
          value: "sqlite",
        })],
      });
    expect(called).toBe(false);
  });

  it("checks handler and selected-route readiness before touching storage", async () => {
    let called = false;
    const storage: MantleStorageAdapter = {
      async prepare(): Promise<PreparedMantleStorage> {
        called = true;
        throw new Error("must not prepare");
      },
    };

    await expect(prepareDeployment(compilePlan(handlerManifest), storage, {
      handlerNames: [],
      reservedHttpPathPrefixes: ["/api/app"],
    }))
      .rejects.toMatchObject({
        diagnostics: [
          expect.objectContaining({ code: "HANDLER_NOT_REGISTERED" }),
          expect.objectContaining({ code: "TRIGGER_PATH_INVALID" }),
        ],
      });
    expect(called).toBe(false);
  });

  it("lets a read-only embedding omit unrelated Procedure handlers", async () => {
    const prepared = await prepareDeployment(
      compilePlan(handlerManifest),
      new SqliteMantleStorageAdapter(new InMemoryDatabase()),
    );

    expect(prepared.storage.views).toBeDefined();
  });

  it("does not bind fewer handlers than the prepared revision validated", async () => {
    const plan = compilePlan(handlerManifest);
    const prepared = await prepareDeployment(
      plan,
      new SqliteMantleStorageAdapter(new InMemoryDatabase()),
      { handlerNames: ["appHandler"] },
    );

    expect(() => createMantleRuntime({ prepared, handlers: {} }))
      .toThrow("HANDLER_NOT_REGISTERED");
  });
});

function compilePlan(text: string): RuntimePlan {
  const linked = parseAndLink(text);
  const compiled = compileRuntimePlan(linked);
  if (!compiled.ok) throw new Error("expected compiled storage fixture");
  return compiled.value;
}

function parseAndLink(text: string): LinkedManifestSet {
  const parsed = parseManifestSources({
    sources: [{ sourceId: "memory:storage", text }],
  });
  if (!parsed.ok) throw new Error(parsed.diagnostics.map((item) => item.message).join("\n"));
  const linked = linkManifestSet(parsed.value);
  if (!linked.ok) throw new Error(linked.diagnostics.map((item) => item.message).join("\n"));
  return linked.value;
}

const declarativeManifest = `apiVersion: cms.mantle.aotter.net/v1
kind: Schema
metadata: { name: posts }
spec:
  title: Posts
  schema:
    type: object
    properties:
      title: { type: string }
---
apiVersion: cms.mantle.aotter.net/v1
kind: View
metadata: { name: published-posts }
spec:
  surface: public
  from: posts
  fields: [id, title]
  filter: { eq: { field: status, value: published } }
`;

const nativeManifest = `apiVersion: cms.mantle.aotter.net/v1
kind: View
metadata: { name: native-report }
spec:
  surface: staff
  sql: SELECT 1 AS value
`;

const handlerManifest = `apiVersion: cms.mantle.aotter.net/v1
kind: Procedure
metadata: { name: app-handler }
spec:
  input: { type: object }
  output: { type: object }
  handler: { kind: ref, ref: appHandler }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Trigger
metadata: { name: app-route }
spec:
  source: { kind: http, method: POST, path: /api/app/run }
  target: { procedure: app-handler }
`;
