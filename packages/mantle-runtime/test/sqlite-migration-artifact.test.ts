import type { SchemaManifest } from "@aotter/mantle-spec";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  buildSqliteMigrationArtifact,
  verifySqliteMigrationArtifact,
} from "../src/infrastructure/storage/SqliteMigrationArtifact.js";

describe("SQLite migration artifacts", () => {
  it("emits deterministic initial and additive artifacts", async () => {
    const initial = await buildSqliteMigrationArtifact([], [schema({ title: { type: "string" } })]);
    const same = await buildSqliteMigrationArtifact([], [schema({ title: { type: "string" } })]);
    expect(initial).toEqual(same);
    expect(initial.destructive).toBe(false);
    expect(initial.migrations.some(({ sql }) => sql.includes('CREATE TABLE "posts"'))).toBe(true);

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

  it("requires reviewed SQL for destructive changes and detects mutation", async () => {
    const before = schema({ title: { type: "string" } });
    const after = schema({ title: { type: "integer" } });
    await expect(buildSqliteMigrationArtifact([before], [after])).rejects.toThrow("explicit reviewed");
    const artifact = await buildSqliteMigrationArtifact([before], [after], {
      id: "app:posts-title-integer",
      description: "Rebuild posts with integer title",
      sql: 'CREATE TABLE "posts_next" ("id" TEXT PRIMARY KEY);',
    });
    expect(artifact.destructive).toBe(true);
    expect(artifact.migrations.some(({ sql }) => sql.includes("DO UPDATE SET projection"))).toBe(true);
    await expect(verifySqliteMigrationArtifact({ ...artifact, migrations: [{ ...artifact.migrations[0]!, sql: "SELECT 1" }] }))
      .rejects.toThrow("checksum mismatch");
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
}

function schema(properties: NonNullable<SchemaManifest["spec"]["schema"]["properties"]>): SchemaManifest {
  return {
    apiVersion: "cms.mantle.aotter.net/v1",
    kind: "Schema",
    metadata: { name: "posts" },
    spec: { title: "Posts", schema: { type: "object", properties } },
  };
}
