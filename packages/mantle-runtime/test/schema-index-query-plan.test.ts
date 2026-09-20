import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { SchemaManifest, ViewManifest } from "@aotter/mantle-spec";
import { CANONICAL_MIGRATIONS } from "../src/infrastructure/boot/index.js";
import { DatabaseEntryRepository } from "../src/infrastructure/persistence/DatabaseEntryRepository.js";
import { compileView } from "../src/infrastructure/storage/SqliteViewCompiler.js";
import { schemaTableMigrations } from "../src/infrastructure/storage/SqliteSchemaTables.js";
import { InMemoryDatabase } from "./fakes/database.js";

const schema: SchemaManifest = {
  apiVersion: "cms.mantle.aotter.net/v1",
  kind: "Schema",
  metadata: { name: "account-members" },
  spec: {
    title: "Account members",
    schema: {
      type: "object",
      properties: {
        userId: { type: "string" },
        state: { type: "string", enum: ["sale", "return"] },
        accountId: { type: "string" },
        active: { type: "boolean" },
      },
    },
    indexes: [["userId", "state", "accountId"], ["state"]],
    uniqueIndexes: [["accountId", "userId"]],
    lifecycle: "operational",
    uiSchema: { list: { filterField: "state" } },
  },
};

function apply(db: DatabaseSync): void {
  for (const migration of CANONICAL_MIGRATIONS) db.exec(migration.sql);
  for (const migration of schemaTableMigrations([schema])) db.exec(migration.sql);
}

describe("native Schema tables", () => {
  it("creates real typed columns and no generic entries table", () => {
    const db = new DatabaseSync(":memory:");
    try {
      apply(db);
      const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all() as Array<{ name: string }>;
      expect(tables.map(({ name }) => name)).toContain("account-members");
      expect(tables.map(({ name }) => name)).not.toContain("entries");
      expect(db.prepare(`PRAGMA table_info("account-members")`).all()).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "userId", type: "TEXT" }),
        expect.objectContaining({ name: "active", type: "INTEGER" }),
      ]));
    } finally {
      db.close();
    }
  });

  it("uses a declared composite index for a native-column View", () => {
    const db = new DatabaseSync(":memory:");
    try {
      apply(db);
      const manifest: ViewManifest = {
        apiVersion: "cms.mantle.aotter.net/v1",
        kind: "View",
        metadata: { name: "member" },
        spec: {
          surface: "public",
          from: "account-members",
          filter: { and: [
            { eq: { field: "userId", value: "u1" } },
            { eq: { field: "state", value: "active" } },
          ] },
        },
      };
      const compiled = compileView(manifest, {}, schema);
      const plan = db.prepare(`EXPLAIN QUERY PLAN ${compiled.sql}`)
        .all(...compiled.params as SQLInputValue[]) as Array<{ detail: string }>;
      expect(compiled.sql).toContain(`FROM "account-members"`);
      expect(compiled.sql).not.toContain("json_extract");
      expect(plan.some(({ detail }) => /SEARCH account-members USING INDEX/.test(detail))).toBe(true);
    } finally {
      db.close();
    }
  });

  it("enforces declared native unique indexes", () => {
    const db = new DatabaseSync(":memory:");
    try {
      apply(db);
      const insert = db.prepare(`INSERT INTO "account-members"
        (_mantle_id, _mantle_status, _mantle_version, _mantle_created_at, _mantle_updated_at, accountId, userId)
        VALUES (?, 'draft', 1, 1, 1, 'a1', 'u1')`);
      insert.run("one");
      expect(() => insert.run("two")).toThrow(/UNIQUE constraint failed/);
    } finally {
      db.close();
    }
  });

  it("keeps creation statistics on the Schema table", async () => {
    const db = new InMemoryDatabase();
    await db.migrations.runAll(CANONICAL_MIGRATIONS);
    await db.migrations.runAll(schemaTableMigrations([schema]));
    const repository = new DatabaseEntryRepository(db, new Map([[schema.metadata.name, schema]]));
    for (const [id, state, createdAt] of [["a", "sale", 1], ["b", "sale", 2], ["c", "return", 11]] as const) {
      await repository.create({ id, collection: schema.metadata.name, status: "draft", data: { state }, authorId: null, now: createdAt });
    }
    expect(await repository.readCreationStatistics({
      collection: schema.metadata.name,
      from: 0,
      to: 20,
      bucketMs: 10,
    })).toEqual({ total: 3, buckets: [
      { bucket: 0, subtype: "sale", count: 2 },
      { bucket: 1, subtype: "return", count: 1 },
    ] });
  });
});
