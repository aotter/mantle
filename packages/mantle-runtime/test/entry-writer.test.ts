import { describe, expect, it } from "vitest";
import {
  EntryStatusConflict,
  EntryVersionConflict,
} from "../src/domain/model/EntryRow.js";
import { DatabaseEntryRepository } from "../src/infrastructure/persistence/DatabaseEntryRepository.js";
import { InMemoryDatabase } from "./fakes/database.js";

describe("DatabaseEntryRepository against in-memory DatabaseDriver", () => {
  it("create + get round-trips data", async () => {
    const db = new InMemoryDatabase();
    const repo = new DatabaseEntryRepository(db);
    const created = await repo.create({
      id: "p1",
      collection: "posts",
      status: "draft",
      data: { title: "Hi" },
      authorId: "u1",
      now: 1,
    });
    expect(created.data).toEqual({ title: "Hi" });
    expect(await repo.get("p1")).toEqual({
      id: "p1",
      collection: "posts",
      locale: undefined,
      status: "draft",
      version: 1,
      data: { title: "Hi" },
      authorId: "u1",
      createdAt: 1,
      updatedAt: 1,
    });
  });

  it("create lifts data.locale to top-level locale", async () => {
    const db = new InMemoryDatabase();
    const repo = new DatabaseEntryRepository(db);
    const created = await repo.create({
      id: "p1",
      collection: "posts",
      status: "draft",
      data: { title: "Hi", locale: "en-US" },
      authorId: null,
      now: 1,
    });
    expect(created.locale).toBe("en-US");
    const fetched = await repo.get("p1");
    expect(fetched?.locale).toBe("en-US");
  });

  it("update bumps version + persists data", async () => {
    const db = new InMemoryDatabase();
    const repo = new DatabaseEntryRepository(db);
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
    expect(updated.data).toEqual({ title: "v2" });
  });

  it("update with stale version throws EntryVersionConflict", async () => {
    const db = new InMemoryDatabase();
    const repo = new DatabaseEntryRepository(db);
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
    const db = new InMemoryDatabase();
    const repo = new DatabaseEntryRepository(db);
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
    const db = new InMemoryDatabase();
    const repo = new DatabaseEntryRepository(db);
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
    const db = new InMemoryDatabase();
    const repo = new DatabaseEntryRepository(db);
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
    const db = new InMemoryDatabase();
    const repo = new DatabaseEntryRepository(db);
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
    expect(await repo.get("p1")).toBeNull();
  });

  it("delete keeps parent and children when the loaded snapshot is stale", async () => {
    const db = new InMemoryDatabase();
    const repo = new DatabaseEntryRepository(db);
    await repo.create({
      id: "p1",
      collection: "posts",
      status: "draft",
      data: {},
      authorId: null,
      now: 1,
    });
    db.revisions.set("r1", { entry_id: "p1" });
    db.approvals.set("a1", { entry_id: "p1" });
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
    expect(await repo.get("p1")).not.toBeNull();
    expect(db.revisions.has("r1")).toBe(true);
    expect(db.approvals.has("a1")).toBe(true);
  });

  it("list orders by updated_at DESC and respects status filter", async () => {
    const db = new InMemoryDatabase();
    const repo = new DatabaseEntryRepository(db);
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

  it("findByDataField finds a matching row with optional status filter", async () => {
    const db = new InMemoryDatabase();
    const repo = new DatabaseEntryRepository(db);
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
