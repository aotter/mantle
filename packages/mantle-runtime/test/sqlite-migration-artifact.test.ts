import type { SchemaManifest } from "@aotter/mantle-spec";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  buildSqliteMigrationArtifact,
  verifySqliteMigrationArtifact,
} from "../src/infrastructure/storage/SqliteMigrationArtifact.js";
import { splitSqlStatements } from "../src/infrastructure/boot/SqliteMigrationRunner.js";

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
    );
    expect(additive.sourceFingerprint).not.toBe(additive.targetFingerprint);
    await expect(verifySqliteMigrationArtifact(additive)).resolves.toBeUndefined();

    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE _migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)");
    apply(db, initial);
    apply(db, additive);
    expect(db.prepare('PRAGMA table_info("posts")').all().map((column) => column.name)).toContain("rank");
    expect(db.prepare("SELECT fingerprint FROM _mantle_storage_state WHERE id = 1").get()?.fingerprint)
      .toBe(additive.targetFingerprint);
    expect(db.prepare("PRAGMA quick_check").get()?.quick_check).toBe("ok");
    db.close();
  });

  it("marks unsupported conversions for rebuild and detects mutation", async () => {
    const before = schema({ title: { type: "string" } });
    const after = schema({ title: { type: "integer" } });
    const artifact = await buildSqliteMigrationArtifact([before], [after]);
    expect(artifact.destructive).toBe(true);
    await expect(verifySqliteMigrationArtifact({ ...artifact, migrations: [{ ...artifact.migrations[0]!, sql: "SELECT 1" }] }))
      .rejects.toThrow("checksum mismatch");
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
    await expect(buildSqliteMigrationArtifact([], [{ ...schema({ title: { type: "string" } }), metadata: { name: "session" } }]))
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
