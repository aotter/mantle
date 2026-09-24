import type { SchemaManifest } from "@aotter/mantle-spec";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  buildSqliteMigrationArtifact,
  renderSqliteManagedMigration,
  verifySqliteMigrationArtifact,
} from "../src/infrastructure/storage/SqliteMigrationArtifact.js";
import { splitSqlStatements } from "../src/infrastructure/boot/SqliteMigrationRunner.js";
import { CANONICAL_MIGRATIONS } from "../src/infrastructure/boot/canonicalMigrations.js";

describe("SQLite migration artifacts", () => {
  it("emits deterministic initial and additive artifacts", async () => {
    const initial = await buildSqliteMigrationArtifact([], [schema({ title: { type: "string" } })]);
    const same = await buildSqliteMigrationArtifact([], [schema({ title: { type: "string" } })]);
    expect(initial).toEqual(same);
    expect(initial.destructive).toBe(false);
    expect(initial.migrations.some(({ sql }) => sql.includes('CREATE TABLE IF NOT EXISTS "posts"'))).toBe(true);

    const additive = await buildSqliteMigrationArtifact(
      [schema({ title: { type: "string" } })],
      [schema({ title: { type: "string" }, rank: { type: "integer" } })],
      { appliedMigrationIds: CANONICAL_MIGRATIONS.map(({ id }) => id) },
    );
    expect(additive.sourceFingerprint).not.toBe(additive.targetFingerprint);
    expect(additive.migrations.some(({ id }) => id.startsWith("000"))).toBe(false);
    expect(additive.migrations.some(({ sql }) => sql.includes('ADD COLUMN "title"'))).toBe(false);
    await expect(verifySqliteMigrationArtifact(additive)).resolves.toBeUndefined();

    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE _migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)");
    apply(db, initial);
    db.prepare(`INSERT INTO "posts"(
      _mantle_id, _mantle_status, _mantle_version, _mantle_author_id,
      _mantle_created_at, _mantle_updated_at, title
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run("post-1", "published", 3, "owner-1", 10, 20, "Keep me");
    apply(db, additive);
    expect(db.prepare('PRAGMA table_info("posts")').all().map((column) => column.name)).toContain("rank");
    expect(db.prepare('SELECT * FROM "posts" WHERE _mantle_id = ?').get("post-1")).toMatchObject({
      _mantle_status: "published",
      _mantle_version: 3,
      _mantle_author_id: "owner-1",
      _mantle_created_at: 10,
      _mantle_updated_at: 20,
      title: "Keep me",
      rank: null,
    });
    expect(db.prepare("SELECT fingerprint FROM _mantle_storage_state WHERE id = 1").get()?.fingerprint)
      .toBe(additive.targetFingerprint);
    expect(db.prepare("PRAGMA quick_check").get()?.quick_check).toBe("ok");
    db.close();
  });

  it("does not replay canonical migrations already applied through 0004", async () => {
    const db = new DatabaseSync(":memory:");
    const applied = CANONICAL_MIGRATIONS.slice(0, -2);
    for (const migration of applied) db.exec(migration.sql);
    const upgrade = await buildSqliteMigrationArtifact([], [], {
      appliedMigrationIds: applied.map(({ id }) => id),
    });
    expect(upgrade.migrations.map(({ id }) => id)).toEqual(["0005-store-instance-id", "0006-managed-runtime-version"]);
    db.exec(upgrade.migrations[0]!.sql);
    expect(db.prepare("PRAGMA table_info('_mantle_boot_state')").all().map((row) => row.name))
      .toContain("store_instance_id");
    db.close();
  });

  it("renders guarded managed migrations without advancing a mismatched marker", async () => {
    const db = new DatabaseSync(":memory:");
    const first = await buildSqliteMigrationArtifact([], [schema({ title: { type: "string" } })]);
    db.exec(renderSqliteManagedMigration(first));
    const second = await buildSqliteMigrationArtifact(
      [schema({ title: { type: "string" } })],
      [schema({ title: { type: "string" }, rank: { type: "integer" } })],
      { appliedMigrationIds: first.migrations.map(({ id }) => id) },
    );
    db.exec(renderSqliteManagedMigration(second, { canonicalVersion: first.targetCanonicalVersion }));
    expect(db.prepare("SELECT fingerprint FROM _mantle_storage_state WHERE id=1").get()?.fingerprint)
      .toBe(second.targetFingerprint);
    db.exec("UPDATE _mantle_storage_state SET fingerprint='unexpected' WHERE id=1");
    expect(() => db.exec(renderSqliteManagedMigration(second, { canonicalVersion: first.targetCanonicalVersion })))
      .toThrow();
    expect(db.prepare("SELECT fingerprint FROM _mantle_storage_state WHERE id=1").get()?.fingerprint).toBe("unexpected");
    db.close();
  });

  it("marks unsupported conversions for rebuild and detects mutation", async () => {
    const before = schema({ title: { type: "string" } });
    const after = schema({ title: { type: "integer" } });
    const artifact = await buildSqliteMigrationArtifact([before], [after]);
    expect(artifact.destructive).toBe(true);
    expect((await buildSqliteMigrationArtifact([before], [after], { reviewUniqueIndexes: true })).destructive).toBe(true);
    expect((await buildSqliteMigrationArtifact([before], [])).destructive).toBe(true);
    expect((await buildSqliteMigrationArtifact([before], [schema({})])).destructive).toBe(true);
    await expect(verifySqliteMigrationArtifact({ ...artifact, migrations: [{ ...artifact.migrations[0]!, sql: "SELECT 1" }] }))
      .rejects.toThrow("checksum mismatch");
  });

  it("reviews unique tuple replacement without dropping rows or silently accepting duplicates", async () => {
    const fields = { userId: { type: "string" as const }, providerSubscriptionId: { type: "string" as const } };
    const before = { ...schema(fields), spec: { ...schema(fields).spec, uniqueIndexes: [["userId"]] } } as SchemaManifest;
    const after = { ...schema(fields), spec: { ...schema(fields).spec, uniqueIndexes: [["providerSubscriptionId"]] } } as SchemaManifest;
    const initial = await buildSqliteMigrationArtifact([], [before]);
    const ordinary = await buildSqliteMigrationArtifact([before], [after], { appliedMigrationIds: initial.migrations.map(({ id }) => id) });
    expect(ordinary.destructive).toBe(true);
    const reviewed = await buildSqliteMigrationArtifact([before], [after], {
      appliedMigrationIds: initial.migrations.map(({ id }) => id), reviewUniqueIndexes: true,
    });
    expect(reviewed.destructive).toBe(false);
    expect(reviewed.reviewedUniqueIndexes).toEqual([{ schema: "posts", removed: [["userId"]], added: [["providerSubscriptionId"]] }]);
    await expect(verifySqliteMigrationArtifact(reviewed)).resolves.toBeUndefined();
    const makeDb = () => {
      const db = new DatabaseSync(":memory:");
      db.exec(renderSqliteManagedMigration(initial));
      return db;
    };
    const insert = (db: DatabaseSync, id: string, user: string, subscription: string) => db.prepare(`INSERT INTO posts
      (_mantle_id,_mantle_status,_mantle_version,_mantle_created_at,_mantle_updated_at,userId,providerSubscriptionId)
      VALUES (?, 'operational', 1, 1, 1, ?, ?)`).run(id, user, subscription);
    const conflicted = makeDb();
    insert(conflicted, "a", "u1", "same");
    insert(conflicted, "b", "u2", "same");
    expect(() => conflicted.exec(`BEGIN;${renderSqliteManagedMigration(reviewed, { canonicalVersion: initial.targetCanonicalVersion })}COMMIT;`)).toThrow();
    conflicted.exec("ROLLBACK");
    expect(conflicted.prepare("SELECT fingerprint FROM _mantle_storage_state WHERE id=1").get()?.fingerprint).toBe(initial.targetFingerprint);
    expect(conflicted.prepare("SELECT name FROM sqlite_schema WHERE type='index' AND name LIKE '%unique%'").all()).toHaveLength(1);
    conflicted.close();
    const valid = makeDb();
    insert(valid, "a", "u1", "s1");
    valid.exec(`BEGIN;${renderSqliteManagedMigration(reviewed, { canonicalVersion: initial.targetCanonicalVersion })}COMMIT;`);
    insert(valid, "b", "u1", "s2");
    expect(() => insert(valid, "c", "u3", "s2")).toThrow();
    expect(valid.prepare("SELECT COUNT(*) AS n FROM posts").get()?.n).toBe(2);
    expect(valid.prepare("SELECT fingerprint FROM _mantle_storage_state WHERE id=1").get()?.fingerprint).toBe(reviewed.targetFingerprint);
    valid.close();
  });

  it("normalizes property order and fingerprints codecs, nullability, and unions", async () => {
    const a = schema({ title: { type: "string" }, rank: { type: "integer" } });
    const reordered = schema({ rank: { type: "integer" }, title: { type: "string" } });
    expect((await buildSqliteMigrationArtifact([a], [reordered])).sourceFingerprint)
      .toBe((await buildSqliteMigrationArtifact([a], [reordered])).targetFingerprint);
    expect((await buildSqliteMigrationArtifact([a], [schema({ title: { type: "string" }, rank: { type: "boolean" } })])).destructive).toBe(true);
    expect((await buildSqliteMigrationArtifact([a], [schema({ title: { type: "string", nullable: true }, rank: { type: "integer" } })])).destructive).toBe(true);
    expect((await buildSqliteMigrationArtifact([a], [schema({ title: { type: ["string", "integer"] }, rank: { type: "integer" } })])).destructive).toBe(true);
  });

  it("rejects SQLite namespace collisions before emitting DDL", async () => {
    await expect(buildSqliteMigrationArtifact([], [{ ...schema({ title: { type: "string" } }), metadata: { name: "entries" } }]))
      .rejects.toThrow("reserved SQLite table");
    await expect(buildSqliteMigrationArtifact([], [{ ...schema({ title: { type: "string" } }), metadata: { name: "session" } }]))
      .rejects.toThrow("reserved SQLite table");
    await expect(buildSqliteMigrationArtifact([], [{ ...schema({ title: { type: "string" } }), metadata: { name: "sites_users" } }]))
      .rejects.toThrow("reserved SQLite table");
    await expect(buildSqliteMigrationArtifact([], [{ ...schema({ title: { type: "string" } }), metadata: { name: "d1_migrations" } }]))
      .rejects.toThrow("reserved SQLite table");
    await expect(buildSqliteMigrationArtifact([], [schema({ _mantle_id: { type: "string" } })]))
      .rejects.toThrow("reserved SQLite namespace");
    await expect(buildSqliteMigrationArtifact([], [schema({ Title: { type: "string" }, title: { type: "string" } })]))
      .rejects.toThrow("reserved SQLite namespace");
  });

  it("splits scripts without breaking semicolons in identifiers, values, or comments", () => {
    expect(splitSqlStatements(`CREATE TABLE "part;code" (value TEXT DEFAULT ';'); -- ;\nINSERT INTO "part;code" VALUES ('a;''b');`))
      .toEqual([`CREATE TABLE "part;code" (value TEXT DEFAULT ';')`, `-- ;\nINSERT INTO "part;code" VALUES ('a;''b')`]);
  });
});

function apply(db: DatabaseSync, artifact: Awaited<ReturnType<typeof buildSqliteMigrationArtifact>>) {
  for (const migration of artifact.migrations) {
    if (db.prepare("SELECT 1 FROM _migrations WHERE id = ?").get(migration.id)) continue;
    db.exec("BEGIN");
    try {
      db.exec(migration.sql);
      db.prepare("INSERT INTO _migrations(id, applied_at) VALUES (?, ?)").run(migration.id, Date.now());
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  for (const item of artifact.projections) {
    db.prepare("INSERT INTO _mantle_schema_tables(name, projection) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET projection=excluded.projection")
      .run(item.name, item.projection);
  }
  db.prepare("INSERT INTO _mantle_storage_state(id, fingerprint) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET fingerprint=excluded.fingerprint")
    .run(artifact.targetFingerprint);
}

function schema(properties: NonNullable<SchemaManifest["spec"]["schema"]["properties"]>): SchemaManifest {
  return {
    apiVersion: "cms.mantle.aotter.net/v1",
    kind: "Schema",
    metadata: { name: "posts" },
    spec: { title: "Posts", schema: { type: "object", properties } },
  };
}
