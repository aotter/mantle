import { describe, expect, it } from "vitest";
import {
  linkManifestSet,
  parseManifestSources,
  type Manifest,
  type SchemaManifest,
} from "@aotter/mantle-spec";
import { compileRuntimePlan, createMantleRuntime, prepareDeployment, SqliteMantleStorageAdapter, type MantleRuntime } from "../src/index.js";
import type { AnyHandler } from "../src/domain/model/HandlerContext.js";
import type { EntryRow } from "../src/domain/model/EntryRow.js";
import { createStore } from "../src/usecase/store/createStore.js";
import { BootValidationError } from "../src/usecase/boot/index.js";
import { InMemoryDatabase } from "./fakes/database.js";

const schema = (name: string, properties: Record<string, unknown>, extra: Record<string, unknown> = {}, required: string[] = []): SchemaManifest => ({
  apiVersion: "cms.mantle.aotter.net/v1",
  kind: "Schema",
  metadata: { name },
  spec: { title: name, lifecycle: "operational", schema: { type: "object", properties, required }, ...extra },
} as SchemaManifest);

const sessions = schema("sessions", {
  ownerId: { type: "string" },
  performedAt: { type: "string" },
  rpe: { type: ["integer", "null"] },
  done: { type: "boolean" },
  tags: { type: "array", items: { type: "string" } },
  ref: { type: "string" },
}, {}, ["ownerId", "performedAt"]);
const blocks = schema("blocks", { sessionId: { type: "string" }, exercise: { type: "string" } }, {}, ["sessionId", "exercise"]);
const receipts = schema("receipts", { key: { type: "string" }, expiresAt: { type: "string", format: "date-time" } },
  { ttl: { field: "expiresAt", expireAfterSeconds: 0 } });

async function runtime(db: InMemoryDatabase, extra: readonly Manifest[] = [], handlers: Record<string, AnyHandler> = {}): Promise<MantleRuntime> {
  const parsed = parseManifestSources({
    sources: [sessions, blocks, receipts, ...extra].map((manifest, index) => ({ sourceId: `t:${index}`, text: JSON.stringify(manifest) })),
  });
  if (!parsed.ok) throw new BootValidationError(parsed.diagnostics);
  const linked = linkManifestSet(parsed.value);
  if (!linked.ok) throw new BootValidationError(linked.diagnostics);
  const compiled = compileRuntimePlan(linked.value);
  if (!compiled.ok) throw new BootValidationError(compiled.diagnostics);
  const prepared = await prepareDeployment(compiled.value, new SqliteMantleStorageAdapter(db), { handlerNames: Object.keys(handlers) });
  return createMantleRuntime({ prepared, handlers });
}

let clock = 1_000;
const row = (collection: string, id: string, data: Record<string, unknown>): EntryRow => ({
  id, collection, status: "published", version: 1, data, authorId: null, createdAt: clock, updatedAt: clock++,
});

async function seeded() {
  const db = new InMemoryDatabase();
  const rt = await runtime(db);
  db.seedEntry(row("sessions", "s1", { ownerId: "a", performedAt: "2026-09-01", rpe: 7, done: true, tags: ["x"] }));
  db.seedEntry(row("sessions", "s2", { ownerId: "a", performedAt: "2026-09-02", rpe: null, done: false }));
  db.seedEntry(row("sessions", "s3", { ownerId: "b", performedAt: "2026-09-03", rpe: 9, done: true }));
  db.seedEntry(row("blocks", "b1", { sessionId: "s1", exercise: "squat" }));
  db.seedEntry(row("blocks", "b2", { sessionId: "s2", exercise: "bench" }));
  db.seedEntry(row("blocks", "b3", { sessionId: "s3", exercise: "deadlift" }));
  db.entryCount("sessions");
  return { db, rt };
}

const ids = (result: { rows: readonly Record<string, unknown>[] }) => result.rows.map((r) => r["id"]);

describe("store.select (#1151)", () => {
  it("returns flat rows, equality shorthand and the default updatedAt desc order", async () => {
    const { rt } = await seeded();
    const result = await rt.store.select({ from: "sessions", where: { ownerId: "a" } });
    expect(ids(result)).toEqual(["s2", "s1"]);
    expect(result.rows[1]).toEqual({
      id: "s1", status: "published", version: 1, authorId: null, createdAt: expect.any(Number), updatedAt: expect.any(Number),
      ownerId: "a", performedAt: "2026-09-01", rpe: 7, done: true, tags: ["x"],
    });
    expect(result.nextCursor).toBeUndefined();
  });

  it("compiles comparisons, null handling, booleans, and/or/not", async () => {
    const { rt } = await seeded();
    const q = (where: object) => rt.store.select({ from: "sessions", where: where as never, orderBy: { performedAt: "asc" } }).then(ids);
    expect(await q({ rpe: { gte: 7, lt: 9 } })).toEqual(["s1"]);
    expect(await q({ rpe: { ne: 7 } })).toEqual(["s3"]);
    expect(await q({ rpe: null })).toEqual(["s2"]);
    expect(await q({ rpe: { isNull: false } })).toEqual(["s1", "s3"]);
    expect(await q({ done: false })).toEqual(["s2"]);
    expect(await q({ id: { in: ["s1", "s3"] } })).toEqual(["s1", "s3"]);
    expect(await q({ id: { notIn: ["s1"] } })).toEqual(["s2", "s3"]);
    expect(await q({ id: { in: [] } })).toEqual([]);
    expect(await q({ or: [{ ownerId: "b" }, { rpe: null }] })).toEqual(["s2", "s3"]);
    expect(await q({ not: { ownerId: "a" } })).toEqual(["s3"]);
    expect(await q({ version: 1, status: "published", performedAt: { gt: "2026-09-01" } })).toEqual(["s2", "s3"]);
  });

  it("filters through an in-subquery across Schemas", async () => {
    const { rt } = await seeded();
    const result = await rt.store.select({
      from: "blocks",
      where: { sessionId: { in: { select: "id", from: "sessions", where: { ownerId: "a" } } } },
      orderBy: { exercise: "asc" },
    });
    expect(ids(result)).toEqual(["b2", "b1"]);
  });

  it("paginates with a keyset cursor and projects columns", async () => {
    const { rt } = await seeded();
    const first = await rt.store.select({ from: "sessions", orderBy: { performedAt: "asc" }, limit: 2, columns: ["id", "rpe"] });
    expect(first.rows).toEqual([{ id: "s1", rpe: 7 }, { id: "s2", rpe: null }]);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await rt.store.select({ from: "sessions", orderBy: { performedAt: "asc" }, limit: 2, columns: ["id", "rpe"], cursor: first.nextCursor });
    expect(second.rows).toEqual([{ id: "s3", rpe: 9 }]);
    expect(second.nextCursor).toBeUndefined();
    await expect(rt.store.select({ from: "sessions", orderBy: { performedAt: "desc" }, cursor: first.nextCursor }))
      .rejects.toMatchObject({ diagnostic: { code: "INPUT_VALIDATION_FAILED" } });
  });

  it("pages through desc order on a required field and through the default order", async () => {
    const { rt } = await seeded();
    const pages = async (query: object) => {
      const seen: unknown[] = [];
      let cursor: string | undefined;
      do {
        const page = await rt.store.select({ ...(query as object), from: "sessions", limit: 1, ...(cursor ? { cursor } : {}) } as never);
        seen.push(...ids(page));
        cursor = page.nextCursor;
      } while (cursor);
      return seen;
    };
    expect(await pages({ orderBy: { performedAt: "desc" } })).toEqual(["s3", "s2", "s1"]);
    expect(await pages({})).toEqual(["s3", "s2", "s1"]);
    expect(await pages({ orderBy: { id: "asc" } })).toEqual(["s1", "s2", "s3"]);
  });

  it.each(["asc", "desc"] as const)("pages over a nullable column without losing rows (%s); NULLs sort last", async (direction) => {
    const { rt } = await seeded();
    const seen: unknown[] = [];
    let cursor: string | undefined;
    do {
      const page = await rt.store.select({ from: "sessions", orderBy: { rpe: direction }, limit: 1, ...(cursor ? { cursor } : {}) });
      seen.push(...ids(page));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toEqual(direction === "asc" ? ["s1", "s3", "s2"] : ["s3", "s1", "s2"]);
  });

  it("rejects a cursor minted for another Schema or column", async () => {
    const { rt } = await seeded();
    const page = await rt.store.select({ from: "sessions", orderBy: { rpe: "asc" }, limit: 1 });
    await expect(rt.store.select({ from: "blocks", orderBy: { rpe: "asc" } as never, cursor: page.nextCursor }))
      .rejects.toMatchObject({ diagnostic: { code: "INPUT_VALIDATION_FAILED" } });
    await expect(rt.store.select({ from: "sessions", orderBy: { performedAt: "asc" }, cursor: page.nextCursor }))
      .rejects.toMatchObject({ diagnostic: { message: expect.stringMatching(/cursor/) } });
  });

  it("keeps notIn subqueries total when the subquery column holds NULL", async () => {
    const { db, rt } = await seeded();
    db.seedEntry(row("sessions", "s4", { ownerId: "c", performedAt: "2026-09-04", done: false }));
    db.entryCount("sessions");
    // s4.ref is NULL; blocks whose sessionId is not any session's ref must still come back.
    const result = await rt.store.select({ from: "blocks", where: { sessionId: { notIn: { select: "ref", from: "sessions" } } } });
    expect(ids(result).sort()).toEqual(["b1", "b2", "b3"]);
  });

  it("binds outer TTL, where, inner TTL subquery and cursor in order", async () => {
    const db = new InMemoryDatabase();
    const rt = await runtime(db);
    for (const [id, expiresAt] of [["r1", "2999-01-01T00:00:00.000Z"], ["r2", "2999-01-01T00:00:00.000Z"], ["r3", "2000-01-01T00:00:00.000Z"]]) {
      db.seedEntry(row("receipts", id!, { key: `k-${id}`, expiresAt }));
      db.seedEntry(row("blocks", `b-${id}`, { sessionId: id!, exercise: `e-${id}` }));
    }
    db.entryCount("receipts");
    const query = {
      from: "receipts",
      where: { key: { ne: "nope" }, id: { in: { select: "sessionId", from: "blocks", where: { exercise: { gte: "e-" } } } } },
      orderBy: { id: "asc" as const },
      limit: 1,
    };
    const first = await rt.store.select(query);
    const second = await rt.store.select({ ...query, cursor: first.nextCursor });
    expect([...ids(first), ...ids(second)]).toEqual(["r1", "r2"]);
    expect(second.nextCursor).toBeUndefined();
  });

  it("hides TTL-expired rows, including inside subqueries", async () => {
    const db = new InMemoryDatabase();
    const rt = await runtime(db);
    db.seedEntry(row("receipts", "r1", { key: "old", expiresAt: "2000-01-01T00:00:00.000Z" }));
    db.seedEntry(row("receipts", "r2", { key: "new", expiresAt: "2999-01-01T00:00:00.000Z" }));
    db.seedEntry(row("blocks", "b1", { sessionId: "r1", exercise: "x" }));
    db.seedEntry(row("blocks", "b2", { sessionId: "r2", exercise: "y" }));
    db.entryCount("receipts");
    expect(ids(await rt.store.select({ from: "receipts" }))).toEqual(["r2"]);
    expect(ids(await rt.store.select({ from: "blocks", where: { sessionId: { in: { select: "id", from: "receipts" } } } }))).toEqual(["b2"]);
  });

  it.each([
    [{ from: "nope" }, /Unknown Schema/],
    [{ from: "sessions", where: { missing: 1 } }, /has no column 'missing'/],
    [{ from: "sessions", where: { tags: "x" } }, /not a scalar/],
    [{ from: "sessions", where: { rpe: "7" } }, /expects a value of type integer/],
    [{ from: "sessions", where: {} }, /must not be empty/],
    [{ from: "sessions", where: { rpe: { like: 1 } } }, /Unknown Store operator 'like'/],
    [{ from: "sessions", where: { rpe: { gt: null } } }, /cannot compare with null/],
    [{ from: "sessions", where: { and: [] } }, /non-empty array/],
    [{ from: "sessions", where: { id: { in: Array.from({ length: 101 }, (_, i) => `s${i}`) } } }, /at most 100/],
    [{ from: "sessions", orderBy: { performedAt: "asc", id: "asc" } }, /exactly one column/],
    [{ from: "sessions", orderBy: { tags: "asc" } }, /not a scalar/],
    [{ from: "sessions", where: { or: Array.from({ length: 60 }, () => ({ id: { in: { select: "id", from: "blocks" }, notIn: { select: "id", from: "blocks" } }, rpe: { isNull: true } })) } }, /more than 256 conditions/],
    [{ from: "sessions", columns: ["constructor"] }, /has no column 'constructor'/],
    [{ from: "sessions", where: { __proto__: 1 } }, /./],
    [{ from: "sessions", limit: 0 }, /limit must be an integer from 1 to 500/],
    [{ from: "sessions", limit: 501 }, /limit must be an integer from 1 to 500/],
    [{ from: "sessions", where: { or: Array.from({ length: 300 }, () => ({ rpe: { isNull: true } })) } }, /more than 256 conditions/],
    [{ from: "sessions", cursor: "garbage" }, /cursor/],
    [{ from: "sessions", where: { id: { in: { select: "id", from: "blocks", join: 1 } } } }, /Unknown subquery key/],
    [{ from: "sessions", groupBy: ["ownerId"] }, /Unknown Store select key/],
    [{ from: "sessions", columns: 42 }, /columns takes a non-empty array/],
    [{ from: "sessions", columns: "id" }, /columns takes a non-empty array/],
    // An undefined value must not silently drop its condition and widen the filter.
    [{ from: "sessions", where: { ownerId: undefined, rpe: 7 } }, /'ownerId' is undefined/],
    [{ from: "sessions", where: { rpe: { gte: 7, lte: undefined } } }, /'lte' on 'rpe' is undefined/],
    [{ from: "sessions", where: { id: { in: { select: "id", from: "blocks", where: { sessionId: undefined } } } } }, /'sessionId' is undefined/],
  ])("rejects %j", async (query, message) => {
    const { rt } = await seeded();
    await expect(rt.store.select(query as never)).rejects.toMatchObject({
      diagnostic: { code: "INPUT_VALIDATION_FAILED", message: expect.stringMatching(message) },
    });
  });

  it("binds a caller-bound store into ref Procedures with select, view and id", async () => {
    const db = new InMemoryDatabase();
    const seen: unknown[] = [];
    const rt = await runtime(db, [
      {
        apiVersion: "cms.mantle.aotter.net/v1", kind: "View", metadata: { name: "all-blocks" },
        spec: { surface: "internal", from: "blocks", fields: ["id", "exercise"] },
      } as Manifest,
      {
        apiVersion: "cms.mantle.aotter.net/v1", kind: "View", metadata: { name: "signed-in-blocks" },
        spec: { surface: "internal", from: "blocks", fields: ["id"], requires: { auth: { all: ["ctx.user"] } } },
      } as Manifest,
      {
        apiVersion: "cms.mantle.aotter.net/v1", kind: "Procedure", metadata: { name: "probe" },
        spec: { input: { type: "object", properties: {} }, output: { type: "object", properties: {} }, handler: { kind: "ref", ref: "probe" } },
      } as Manifest,
    ], {
      probe: async (_input, ctx) => {
        seen.push(ids(await ctx.store!.select({ from: "blocks" })));
        seen.push((await ctx.store!.view("all-blocks")).rows.map((r) => (r as { id: string }).id));
        seen.push((await ctx.store!.view("signed-in-blocks")).rows.map((r) => (r as { id: string }).id));
        seen.push(ctx.store!.id());
        return {};
      },
    });
    db.seedEntry(row("blocks", "b1", { sessionId: "s", exercise: "x" }));
    db.entryCount("blocks");
    const result = await rt.invokeProcedure({ procedure: "probe", input: {}, ctx: { user: { id: "u1" }, staff: null, env: {} } });
    expect(result.ok).toBe(true);
    expect(seen[0]).toEqual(["b1"]);
    expect(seen[1]).toEqual(["b1"]);
    // The caller's context reached the gated View.
    expect(seen[2]).toEqual(["b1"]);
    expect(seen[3]).toMatch(/^[0-9a-f-]{36}$/);
    // Host code without a caller context fails closed on the same View.
    await expect(rt.store.view("signed-in-blocks")).rejects.toMatchObject({ diagnostic: { code: expect.stringMatching(/UNAUTH|AUTH/) } });
    await expect(rt.store.view("missing")).rejects.toMatchObject({ diagnostic: { code: expect.stringMatching(/UNKNOWN|NOT_FOUND/) } });
  });

  it("reports adapters without the store capability", async () => {
    const unused = async (): Promise<never> => { throw new Error("unused"); };
    const store = createStore({
      idgen: { next: () => "x" }, write: unused, sweepExpired: unused,
      runView: async () => ({ ok: true, result: { rows: [], page: 1, show: 1, hasMore: false } }),
    });
    await expect(store.select({ from: "sessions" })).rejects.toMatchObject({ diagnostic: { code: "RESOURCE_UNAVAILABLE" } });
  });
});
