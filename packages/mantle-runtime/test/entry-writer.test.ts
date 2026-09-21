import { beforeEach, describe, expect, it } from "vitest";
import type { SchemaManifest } from "@aotter/mantle-spec";
import {
  EntryStatusConflict,
  EntryVersionConflict,
} from "../src/domain/model/EntryRow.js";
import { DatabaseEntryRepository } from "../src/infrastructure/persistence/DatabaseEntryRepository.js";
import { InMemoryDatabase } from "./fakes/database.js";
import { CANONICAL_MIGRATIONS } from "../src/infrastructure/boot/index.js";
import { schemaTableMigrations } from "../src/infrastructure/storage/SqliteSchemaTables.js";

const schema: SchemaManifest = {
  apiVersion: "cms.mantle.aotter.net/v1", kind: "Schema", metadata: { name: "posts" },
  spec: { title: "Posts", schema: { type: "object", properties: {
    title: { type: "string" }, locale: { type: ["string", "null"] },
    t: { type: "integer" }, slug: { type: "string" },
  } } },
};

describe("DatabaseEntryRepository against in-memory DatabaseDriver", () => {
  let db: InMemoryDatabase;
  let repo: DatabaseEntryRepository;

  beforeEach(async () => {
    db = new InMemoryDatabase();
    await db.migrations.runAll(CANONICAL_MIGRATIONS);
    await db.migrations.runAll(schemaTableMigrations([schema]));
    repo = new DatabaseEntryRepository(db, new Map([["posts", schema]]));
  });

  it("create + get round-trips data", async () => {
    const created = await repo.create({
      id: "p1",
      collection: "posts",
      status: "draft",
      data: { title: "Hi", locale: null },
      authorId: "u1",
      now: 1,
    });
    expect(created.data).toEqual({ title: "Hi", locale: null });
    expect(await repo.get({ id: "p1", collection: "posts" })).toEqual({
      id: "p1",
      collection: "posts",
      locale: undefined,
      status: "draft",
      version: 1,
      data: { title: "Hi", locale: null },
      authorId: "u1",
      createdAt: 1,
      updatedAt: 1,
    });
  });

  it("create lifts data.locale to top-level locale", async () => {
    const created = await repo.create({
      id: "p1",
      collection: "posts",
      status: "draft",
      data: { title: "Hi", locale: "en-US" },
      authorId: null,
      now: 1,
    });
    expect(created.locale).toBe("en-US");
    const fetched = await repo.get({ id: "p1", collection: "posts" });
    expect(fetched?.locale).toBe("en-US");
  });

  it("round-trips nullable native columns as null", async () => {
    await repo.create({
      id: "p1", collection: "posts", status: "draft",
      data: { title: "Hi", locale: null }, authorId: null, now: 1,
    });
    expect((await repo.get({ id: "p1", collection: "posts" }))?.data.locale).toBeNull();
  });

  it("round-trips union values and legacy nullable fields without changing their meaning", async () => {
    const flexible: SchemaManifest = {
      ...schema,
      metadata: { name: "flexible" },
      spec: { ...schema.spec, schema: { type: "object", properties: {
        value: { type: ["string", "integer"] },
        note: { type: "string", nullable: true },
      } } },
    };
    await db.migrations.runAll(schemaTableMigrations([flexible]));
    const flexibleRepo = new DatabaseEntryRepository(db, new Map([["flexible", flexible]]));
    await flexibleRepo.create({ id: "one", collection: "flexible", status: "draft", data: { value: 123, note: null }, authorId: null, now: 1 });
    await flexibleRepo.create({ id: "two", collection: "flexible", status: "draft", data: { value: "123" }, authorId: null, now: 2 });
    expect((await flexibleRepo.get({ id: "one", collection: "flexible" }))?.data).toEqual({ value: 123, note: null });
    expect((await flexibleRepo.get({ id: "two", collection: "flexible" }))?.data).toEqual({ value: "123", note: null });
  });

  it("materializes omitted nullable:true fields as null on SQLite get", async () => {
    const notes: SchemaManifest = {
      ...schema,
      metadata: { name: "notes" },
      spec: { title: "Notes", schema: { type: "object", properties: {
        title: { type: "string" },
        note: { type: "string", nullable: true },
      } } },
    };
    await db.migrations.runAll(schemaTableMigrations([notes]));
    const notesRepo = new DatabaseEntryRepository(db, new Map([["notes", notes]]));
    await notesRepo.create({
      id: "n1", collection: "notes", status: "draft",
      data: { title: "Hi" }, authorId: null, now: 1,
    });
    expect((await notesRepo.get({ id: "n1", collection: "notes" }))?.data).toEqual({
      title: "Hi", note: null,
    });
  });

  it("uses the authored id column for both ordering and cursor values", async () => {
    const authored: SchemaManifest = {
      ...schema,
      metadata: { name: "authored_ids" },
      spec: { ...schema.spec, schema: { type: "object", properties: { id: { type: "string" } } } },
    };
    await db.migrations.runAll(schemaTableMigrations([authored]));
    const authoredRepo = new DatabaseEntryRepository(db, new Map([["authored_ids", authored]]));
    await authoredRepo.create({ id: "a", collection: "authored_ids", status: "draft", data: { id: "z" }, authorId: null, now: 1 });
    await authoredRepo.create({ id: "b", collection: "authored_ids", status: "draft", data: { id: "y" }, authorId: null, now: 2 });
    const first = await authoredRepo.list({ collection: "authored_ids", limit: 1, sort: { field: "id", direction: "asc" } });
    const second = await authoredRepo.list({ collection: "authored_ids", limit: 1, sort: { field: "id", direction: "asc" }, cursor: first.nextCursor });
    expect(first.rows.map((row) => row.data.id)).toEqual(["y"]);
    expect(second.rows.map((row) => row.data.id)).toEqual(["z"]);
  });

  it("update bumps version + persists data", async () => {
    await repo.create({
      id: "p1",
      collection: "posts",
      status: "draft",
      data: { title: "v1" },
      authorId: null,
      now: 1,
    });
    const updated = await repo.update({
      id: "p1",
      collection: "posts",
      expectedVersion: 1,
      data: { title: "v2" },
      now: 2,
    });
    expect(updated.version).toBe(2);
    expect(updated.data).toEqual({ title: "v2", locale: null });
  });

  it("update with stale version throws EntryVersionConflict", async () => {
    await repo.create({
      id: "p1",
      collection: "posts",
      status: "draft",
      data: {},
      authorId: null,
      now: 1,
    });
    await expect(
      repo.update({ id: "p1", collection: "posts", expectedVersion: 99, data: {}, now: 2 }),
    ).rejects.toBeInstanceOf(EntryVersionConflict);
  });

  it("transitionStatus with expectedStatus enforces guard", async () => {
    await repo.create({
      id: "p1",
      collection: "posts",
      status: "draft",
      data: {},
      authorId: null,
      now: 1,
    });
    const published = await repo.transitionStatus({
      id: "p1",
      collection: "posts",
      to: "published",
      expectedStatus: "draft",
      now: 2,
    });
    expect(published.status).toBe("published");
    expect(published.version).toBe(2);
  });

  it("transitionStatus with wrong expectedStatus throws EntryStatusConflict", async () => {
    await repo.create({
      id: "p1",
      collection: "posts",
      status: "draft",
      data: {},
      authorId: null,
      now: 1,
    });
    await expect(
      repo.transitionStatus({
        id: "p1",
        collection: "posts",
        to: "archived",
        expectedStatus: "published",
        now: 2,
      }),
    ).rejects.toBeInstanceOf(EntryStatusConflict);
  });

  it("archive flips status to 'archived' and bumps version", async () => {
    await repo.create({
      id: "p1",
      collection: "posts",
      status: "draft",
      data: {},
      authorId: null,
      now: 1,
    });
    const archived = await repo.transitionStatus({
      id: "p1",
      collection: "posts",
      to: "archived",
      expectedVersion: 1,
      now: 2,
    });
    expect(archived.status).toBe("archived");
    expect(archived.version).toBe(2);
  });

  it("delete removes the row", async () => {
    await repo.create({
      id: "p1",
      collection: "posts",
      status: "draft",
      data: {},
      authorId: null,
      now: 1,
    });
    const result = await repo.delete({
      id: "p1",
      collection: "posts",
      expectedStatus: "draft",
      expectedVersion: 1,
    });
    expect(result.removed).toBe(true);
    expect(await repo.get({ id: "p1", collection: "posts" })).toBeNull();
  });

  it("delete keeps the row when the loaded snapshot is stale", async () => {
    await repo.create({
      id: "p1",
      collection: "posts",
      status: "draft",
      data: {},
      authorId: null,
      now: 1,
    });
    await repo.transitionStatus({
      id: "p1",
      collection: "posts",
      to: "published",
      expectedStatus: "draft",
      expectedVersion: 1,
      now: 2,
    });

    await expect(
      repo.delete({
        id: "p1",
        collection: "posts",
        expectedStatus: "draft",
        expectedVersion: 1,
      }),
    ).rejects.toBeInstanceOf(EntryVersionConflict);
    expect(await repo.get({ id: "p1", collection: "posts" })).not.toBeNull();
  });

  it("list orders by updated_at DESC and respects status filter", async () => {
    await repo.create({
      id: "p1",
      collection: "posts",
      status: "published",
      data: { t: 1 },
      authorId: null,
      now: 1,
    });
    await repo.create({
      id: "p2",
      collection: "posts",
      status: "draft",
      data: { t: 2 },
      authorId: null,
      now: 2,
    });
    await repo.create({
      id: "p3",
      collection: "posts",
      status: "published",
      data: { t: 3 },
      authorId: null,
      now: 3,
    });
    const all = await repo.list({ collection: "posts" });
    expect(all.rows.map((r) => r.id)).toEqual(["p3", "p2", "p1"]);
    const published = await repo.list({ collection: "posts", status: "published" });
    expect(published.rows.map((r) => r.id)).toEqual(["p3", "p1"]);
  });

  it("paginates equal timestamps without overlap", async () => {
    for (const id of ["p1", "p2", "p3", "p4", "p5"]) {
      await repo.create({
        id,
        collection: "posts",
        status: "draft",
        data: {},
        authorId: null,
        now: 1,
      });
    }
    const first = await repo.list({ collection: "posts", limit: 2 });
    const second = await repo.list({
      collection: "posts",
      limit: 2,
      cursor: first.nextCursor,
    });
    const third = await repo.list({
      collection: "posts",
      limit: 2,
      cursor: second.nextCursor,
    });
    expect([...first.rows, ...second.rows, ...third.rows].map((row) => row.id)).toEqual([
      "p5",
      "p4",
      "p3",
      "p2",
      "p1",
    ]);
    expect(first.nextCursor).toMatch(/^e:/);
    expect(third.nextCursor).toBeUndefined();
  });

  it("findByDataField finds a matching row with optional status filter", async () => {
    await repo.create({
      id: "p1",
      collection: "posts",
      status: "draft",
      data: { slug: "hello" },
      authorId: null,
      now: 1,
    });
    await repo.create({
      id: "p2",
      collection: "posts",
      status: "published",
      data: { slug: "hello" },
      authorId: null,
      now: 2,
    });

    await expect(repo.findByDataField({
      collection: "posts",
      status: "published",
      field: "slug",
      value: "hello",
    })).resolves.toMatchObject({ id: "p2" });
    await expect(repo.findByDataField({
      collection: "posts",
      status: "published",
      field: "slug",
      value: "ghost",
    })).resolves.toBeNull();
  });
});
