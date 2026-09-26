import { describe, expect, it } from "vitest";
import { linkManifestSet, parseManifestSources, type Manifest, type SchemaManifest } from "@aotter/mantle-spec";
import { compileRuntimePlan, createMantleRuntime, prepareDeployment, SqliteMantleStorageAdapter, type MantleRuntime } from "../src/index.js";
import type { AnyHandler, HandlerContext } from "../src/domain/model/HandlerContext.js";
import { BootValidationError } from "../src/usecase/boot/index.js";
import { InMemoryDatabase } from "./fakes/database.js";

/** InMemoryDatabase with atomic batches, like D1 and Bun. */
class AtomicDatabase extends InMemoryDatabase {
  readonly supportsAtomicEntryWrites = true as const;
}

const schema = (name: string, properties: Record<string, unknown>, required: string[] = []): SchemaManifest => ({
  apiVersion: "cms.mantle.aotter.net/v1", kind: "Schema", metadata: { name },
  spec: { title: name, lifecycle: "operational", schema: { type: "object", properties, required } },
} as SchemaManifest);

const sessions = schema("sessions", { ownerId: { type: "string" }, note: { type: "string" } }, ["ownerId"]);
const blocks = schema("blocks", { sessionId: { type: "string" }, exercise: { type: "string" } }, ["sessionId"]);
const sets = schema("sets", { blockId: { type: "string" }, reps: { type: "integer" } }, ["blockId"]);
const audited = schema("audited", { name: { type: "string" } });
const auditTrigger = {
  apiVersion: "cms.mantle.aotter.net/v1", kind: "Trigger", metadata: { name: "audit-delete" },
  spec: { source: { kind: "lifecycle", schema: "audited", on: ["before_delete"] }, target: { procedure: "audit" } },
} as Manifest;
const procedure = (name: string, ref = name) => ({
  apiVersion: "cms.mantle.aotter.net/v1", kind: "Procedure", metadata: { name },
  spec: { input: { type: "object", properties: {} }, output: { type: "object", properties: {} }, handler: { kind: "ref", ref } },
} as Manifest);

async function runtime(db: InMemoryDatabase, extra: readonly Manifest[] = [], handlers: Record<string, AnyHandler> = {}): Promise<MantleRuntime> {
  const parsed = parseManifestSources({
    sources: [sessions, blocks, sets, audited, auditTrigger, procedure("audit"), ...extra]
      .map((manifest, index) => ({ sourceId: `t:${index}`, text: JSON.stringify(manifest) })),
  });
  if (!parsed.ok) throw new BootValidationError(parsed.diagnostics);
  const linked = linkManifestSet(parsed.value);
  if (!linked.ok) throw new BootValidationError(linked.diagnostics);
  const compiled = compileRuntimePlan(linked.value);
  if (!compiled.ok) throw new BootValidationError(compiled.diagnostics);
  const prepared = await prepareDeployment(compiled.value, new SqliteMantleStorageAdapter(db), { handlerNames: ["audit", ...Object.keys(handlers)] });
  return createMantleRuntime({ prepared, handlers: { audit: () => ({}), ...handlers } });
}

async function workout(rt: MantleRuntime) {
  const sessionId = rt.store.id();
  const blockIds = [rt.store.id(), rt.store.id()];
  const results = await rt.store.write([
    { insert: "sessions", id: sessionId, values: { ownerId: "a" } },
    ...blockIds.map((id, i) => ({ insert: "blocks", id, values: { sessionId, exercise: `e${i}` } })),
    ...blockIds.flatMap((blockId) => [1, 2, 3].map((reps) => ({ insert: "sets", values: { blockId, reps } }))),
  ]);
  return { sessionId, blockIds, results };
}

const count = async (rt: MantleRuntime, from: string) => (await rt.store.select({ from, limit: 500 })).rows.length;

describe("store.write (#1151)", () => {
  it("inserts, updates and deletes atomically and reports per-op results", async () => {
    const rt = await runtime(new AtomicDatabase());
    const { sessionId, results } = await workout(rt);
    expect(results[0]).toEqual({ id: sessionId, version: 1 });
    expect(results).toHaveLength(9);
    const [updated] = await rt.store.write([{ update: "sessions", set: { note: "felt good" }, where: { id: sessionId }, lock: 1 }]);
    expect(updated).toEqual({ id: sessionId, version: 2 });
    const [row] = (await rt.store.select({ from: "sessions", where: { id: sessionId } })).rows;
    expect(row).toMatchObject({ ownerId: "a", note: "felt good", version: 2 });
  });

  it("cascades a workout delete in a handful of statements with set-based deletes", async () => {
    const db = new AtomicDatabase();
    const rt = await runtime(db);
    const { sessionId } = await workout(rt);
    const before = db.executions.length;
    const results = await rt.store.write([
      { delete: "sets", where: { blockId: { in: { select: "id", from: "blocks", where: { sessionId } } } } },
      { delete: "blocks", where: { sessionId }, expect: 2 },
      { delete: "sessions", where: { id: sessionId }, lock: 1 },
    ]);
    const statements = db.executions.length - before;
    expect(results).toEqual([{ deleted: 6 }, { deleted: 2 }, { deleted: 1 }]);
    expect(await count(rt, "sets")).toBe(0);
    expect(await count(rt, "blocks")).toBe(0);
    expect(await count(rt, "sessions")).toBe(0);
    // Whatever the workout size: one target read for the locked row, then one batch of
    // delete, delete, guard, delete, guard, cleanup.
    expect(statements).toBe(7);
  });

  it("rolls everything back when a lock is stale", async () => {
    const rt = await runtime(new AtomicDatabase());
    const { sessionId } = await workout(rt);
    await expect(rt.store.write([
      { delete: "sets", where: { reps: 1 } },
      { delete: "sessions", where: { id: sessionId }, lock: 9 },
    ])).rejects.toMatchObject({ diagnostic: { code: "CONFLICT" } });
    expect(await count(rt, "sets")).toBe(6);
    expect(await count(rt, "sessions")).toBe(1);
  });

  it("refuses a set-based delete whose where has an undefined value instead of widening it", async () => {
    const rt = await runtime(new AtomicDatabase());
    await rt.store.write([
      { insert: "sessions", values: { ownerId: "a", note: "shared" } },
      { insert: "sessions", values: { ownerId: "b", note: "shared" } },
    ]);
    const ownerId: string | undefined = undefined;
    await expect(rt.store.write([{ delete: "sessions", where: { ownerId, note: "shared" } }]))
      .rejects.toMatchObject({ diagnostic: { code: "INPUT_VALIDATION_FAILED", message: expect.stringMatching(/'ownerId' is undefined/) } });
    expect(await count(rt, "sessions")).toBe(2);
  });

  it("rolls everything back when an expect count does not hold", async () => {
    const rt = await runtime(new AtomicDatabase());
    await workout(rt);
    await expect(rt.store.write([
      { delete: "sets", where: { reps: 1 }, expect: 5 },
    ])).rejects.toMatchObject({ diagnostic: { code: "CONFLICT", message: expect.stringMatching(/expected number of rows/) } });
    expect(await count(rt, "sets")).toBe(6);
  });

  it("refuses set-based deletes on a Schema with delete lifecycle Triggers, but allows locked row deletes", async () => {
    const rt = await runtime(new AtomicDatabase());
    const [created] = await rt.store.write([{ insert: "audited", values: { name: "x" } }]);
    const id = (created as { id: string }).id;
    await expect(rt.store.write([{ delete: "audited", where: { name: "x" } }]))
      .rejects.toMatchObject({ diagnostic: { code: "INPUT_VALIDATION_FAILED", message: expect.stringMatching(/lifecycle Triggers/) } });
    await expect(rt.store.write([{ delete: "audited", where: { id } }]))
      .rejects.toMatchObject({ diagnostic: { code: "INPUT_VALIDATION_FAILED" } });
    expect(await rt.store.write([{ delete: "audited", where: { id }, lock: 1 }])).toEqual([{ deleted: 1 }]);
  });

  it.each([
    [[{ insert: "sessions", values: { ownerId: 1 } }], /./],
    [[{ insert: "nope", values: {} }], /./],
    [[{ update: "sessions", set: {}, where: { ownerId: "a" }, lock: 1 }], /exactly \{ id \}/],
    [[{ update: "sessions", set: {}, where: { id: "x" } }], /lock/],
    [[{ delete: "sessions", where: { ownerId: "a" }, lock: 1 }], /lock needs where to be exactly/],
    [[{ delete: "nope", where: { id: "x" } }], /Unknown Schema/],
    [[{ delete: "sets", where: { reps: 1 }, expect: -1 }], /non-negative integer/],
    [[{ insert: "sessions", values: {}, update: "sessions" }], /exactly one of/],
    [[{ insert: "sessions", values: {}, returning: ["id"] }], /unknown key 'returning'/],
    [[{ delete: "sets", where: { reps: { in: Array.from({ length: 101 }, (_, i) => i) } } }], /at most 100/],
  ])("rejects %j", async (ops, message) => {
    const rt = await runtime(new AtomicDatabase());
    await expect(rt.store.write(ops as never)).rejects.toMatchObject({
      diagnostic: { code: expect.stringMatching(/INPUT_VALIDATION_FAILED|ENTRY_VALIDATION_FAILED|NOT_FOUND|UNKNOWN/), message: expect.stringMatching(message) },
    });
  });

  it("sets authorId from the caller and gives guard Procedures a read-only Store", async () => {
    const seen: unknown[] = [];
    const rt = await runtime(new AtomicDatabase(), [
      procedure("writer"),
      {
        apiVersion: "cms.mantle.aotter.net/v1", kind: "Procedure", metadata: { name: "guarded" },
        spec: {
          input: { type: "object", properties: {} }, output: { type: "object", properties: {} },
          handler: { kind: "ref", ref: "writer" }, requires: { guard: { procedure: "guard" } },
        },
      } as Manifest,
      {
        apiVersion: "cms.mantle.aotter.net/v1", kind: "Procedure", metadata: { name: "guard" },
        spec: { input: { type: "object", properties: {} }, output: { type: "object", properties: {} }, handler: { kind: "ref", ref: "guard" } },
      } as Manifest,
    ], {
      writer: async (_input, ctx: HandlerContext) => {
        const [row] = await ctx.store!.write([{ insert: "sessions", values: { ownerId: "a" } }]);
        seen.push((await ctx.store!.select({ from: "sessions", where: { id: (row as { id: string }).id } })).rows[0]?.["authorId"]);
        return {};
      },
      guard: async (_input, ctx: HandlerContext) => {
        seen.push(await ctx.store!.write([{ insert: "sessions", values: { ownerId: "guard" } }]).catch((error: { diagnostic?: { message: string } }) => error.diagnostic?.message));
        seen.push(await ctx.store!.sweepExpired({ collection: "sessions" }).catch((error: { diagnostic?: { message: string } }) => error.diagnostic?.message));
        seen.push((await ctx.store!.select({ from: "sessions" })).rows.length);
        return {};
      },
    });
    const ctx = { user: { id: "u1" }, staff: null, env: {} };
    expect((await rt.invokeProcedure({ procedure: "writer", input: {}, ctx })).ok).toBe(true);
    expect(seen[0]).toBe("u1");
    await rt.invokeProcedure({ procedure: "guarded", input: {}, ctx });
    expect(seen[1]).toMatch(/read-only/);
    expect(seen[2]).toMatch(/host-only/);
    expect(seen[3]).toBe(1);
  });

  it("reserves TTL sweeping for the host even in a writable Procedure", async () => {
    let message: string | undefined;
    const rt = await runtime(new AtomicDatabase(), [procedure("writer")], {
      writer: async (_input, ctx: HandlerContext) => {
        message = await ctx.store!.sweepExpired({ collection: "sessions" })
          .then(() => "allowed", (error: { diagnostic?: { message: string } }) => error.diagnostic?.message);
        return {};
      },
    });
    await rt.invokeProcedure({ procedure: "writer", input: {}, ctx: { user: { id: "u1" }, staff: null, env: {} } });
    expect(message).toMatch(/host-only/);
  });

  it("reports storage without atomic writes before touching it", async () => {
    const rt = await runtime(new InMemoryDatabase());
    await expect(rt.store.write([{ insert: "sessions", values: { ownerId: "a" } }]))
      .rejects.toMatchObject({ diagnostic: { code: "RESOURCE_UNAVAILABLE" } });
    expect(await count(rt, "sessions")).toBe(0);
  });
});

describe("store.write set-based delete guards (#1151)", () => {
  const define = (name: string, spec: object) => ({ apiVersion: "cms.mantle.aotter.net/v1", kind: "Schema", metadata: { name }, spec: { title: name, ...spec } }) as SchemaManifest;
  const posts = define("posts", { lifecycle: "publishing", schema: { type: "object", properties: { title: { type: "string" } } } });
  const events = define("events", {
    lifecycle: "operational", ttl: { field: "expiresAt", expireAfterSeconds: 0 },
    schema: { type: "object", properties: { label: { type: "string" }, expiresAt: { type: "string", format: "date-time", nullable: true } } },
  });
  const notes = define("notes", { lifecycle: "operational", schema: { type: "object", properties: { n: { type: "string" } } } });
  const noteTrigger = {
    apiVersion: "cms.mantle.aotter.net/v1", kind: "Trigger", metadata: { name: "note-create" },
    spec: { source: { kind: "lifecycle", schema: "notes", on: ["before_create"] }, target: { procedure: "onNote" } },
  } as Manifest;

  it("refuses set-based deletes on a publishing Schema, whose published entries only row deletes may guard", async () => {
    const db = new AtomicDatabase();
    const rt = await runtime(db, [posts]);
    db.seedEntry({ id: "p1", collection: "posts", status: "published", version: 1, data: { title: "live" }, authorId: null, createdAt: 1, updatedAt: 1, locale: null } as never);
    await expect(rt.store.write([{ delete: "posts", where: { id: "p1" }, lock: 1 }])).rejects.toMatchObject({ diagnostic: { code: "CONFLICT" } });
    await expect(rt.store.write([{ delete: "posts", where: { title: "live" } }]))
      .rejects.toMatchObject({ diagnostic: { code: "INPUT_VALIDATION_FAILED", message: expect.stringMatching(/publishing lifecycle/) } });
    expect(db.entryCount("posts")).toBe(1);
  });

  it("counts only live rows, like select, and leaves expired rows to the sweeper", async () => {
    const rt = await runtime(new AtomicDatabase(), [events]);
    await rt.store.write([
      { insert: "events", values: { label: "x", expiresAt: "2999-01-01T00:00:00.000Z" } },
      { insert: "events", values: { label: "x", expiresAt: "2000-01-01T00:00:00.000Z" } },
    ]);
    expect((await rt.store.select({ from: "events", where: { label: "x" } })).rows).toHaveLength(1);
    expect(await rt.store.write([{ delete: "events", where: { label: "x" }, expect: 1 }])).toEqual([{ deleted: 1 }]);
    expect(await rt.store.sweepExpired({ collection: "events", delete: true })).toMatchObject({ removed: 1 });
  });

  it("rejects an invalid set-based where before any before_* hook runs", async () => {
    const fired: string[] = [];
    const rt = await runtime(new AtomicDatabase(), [events, notes, noteTrigger, procedure("onNote")], {
      onNote: (_input: unknown, ctx: HandlerContext) => { fired.push(String(ctx.event?.hook)); return {}; },
    });
    await expect(rt.store.write([{ insert: "notes", values: { n: "a" } }, { delete: "events", where: { nosuchcolumn: 1 } }]))
      .rejects.toMatchObject({ diagnostic: { code: "INPUT_VALIDATION_FAILED" } });
    expect(fired).toEqual([]);
  });

  it("rejects expect on a locked row delete", async () => {
    const rt = await runtime(new AtomicDatabase());
    await expect(rt.store.write([{ delete: "sessions", where: { id: "x" }, lock: 1, expect: 1 } as never]))
      .rejects.toMatchObject({ diagnostic: { code: "INPUT_VALIDATION_FAILED", message: expect.stringMatching(/set-based delete/) } });
  });
});
