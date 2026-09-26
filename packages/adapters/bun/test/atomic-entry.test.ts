import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { linkManifestSet, parseManifestSources, runtimeDiagnostic } from "@aotter/mantle-spec";
import { compileRuntimePlan, InvokeFailure, type HandlerContext, type MantleStore } from "@aotter/mantle-runtime";
import { createBunMantle } from "../src/index.js";

const source = `apiVersion: cms.mantle.aotter.net/v1
kind: Schema
metadata: { name: sessions }
spec:
  title: Sessions
  lifecycle: publishing
  schema:
    type: object
    required: [name]
    properties: { name: { type: string } }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Schema
metadata: { name: blocks }
spec:
  title: Blocks
  lifecycle: operational
  schema:
    type: object
    required: [name, sessionId]
    properties: { name: { type: string }, sessionId: { type: string } }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Schema
metadata: { name: receipts }
spec:
  title: Receipts
  lifecycle: operational
  uniqueIndexes: [[token]]
  schema:
    type: object
    required: [token]
    properties: { token: { type: string } }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Procedure
metadata: { name: record-session }
spec:
  input:
    type: object
    required: [name, token]
    properties: { name: { type: string }, token: { type: string } }
  output: { type: object }
  handler: { kind: ref, ref: recordSession }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Procedure
metadata: { name: audit-session }
spec:
  input: { type: object }
  output: { type: object }
  handler: { kind: ref, ref: auditSession }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Trigger
metadata: { name: 010-before-session }
spec:
  source: { kind: lifecycle, schema: sessions, on: [before_create] }
  target: { procedure: audit-session }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Trigger
metadata: { name: 020-after-session }
spec:
  source: { kind: lifecycle, schema: sessions, on: [after_create], errorPolicy: continue }
  target: { procedure: audit-session }
`;

test("Bun commits semantic multi-Schema writes and rolls back duplicate receipt and stale last update", async () => {
  const parsed = parseManifestSources({ sources: [{ sourceId: "atomic", text: source }] });
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
  const linked = linkManifestSet(parsed.value);
  if (!linked.ok) throw new Error(JSON.stringify(linked.diagnostics));
  const compiled = compileRuntimePlan(linked.value);
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
  const database = new Database(":memory:");
  const events: string[] = [];
  const mantle = createBunMantle({
    plan: compiled.value,
    database,
    handlers: {
      auditSession: (input: { name?: string }, ctx: HandlerContext) => {
        events.push(ctx.event!.hook);
        if (input.name === "veto") throw new InvokeFailure(runtimeDiagnostic({
          code: "CONFLICT", severity: "error", path: "test/veto", message: "veto",
        }));
        return {};
      },
      recordSession: async (input: { name: string; token: string }, ctx: HandlerContext) => {
        const sessionId = crypto.randomUUID();
        const rows = await ctx.store!.write([
          { insert: "sessions", id: sessionId, values: { name: input.name } },
          { insert: "blocks", values: { name: `${input.name}-block`, sessionId } },
          { insert: "receipts", values: { token: input.token } },
        ]);
        const session = rows[0];
        return { sessionId: session && "id" in session ? session.id : undefined };
      },
    },
    ports: { onPublishingContentChange: async () => { events.push("invalidate"); } },
  });
  const runtime = await mantle.getRuntime();
  const ctx: HandlerContext = { user: null, staff: null, env: {} };
  const first = await runtime.invokeProcedure<{ sessionId: string }>({
    procedure: "record-session", input: { name: "A", token: "once" }, ctx,
  });
  expect(first.ok).toBe(true);
  expect(events).toEqual(["before_create", "after_create", "invalidate"]);
  expect(await runtime.listEntries.execute({ collection: "sessions" })).toHaveLength(1);

  await expect(runtime.store.write([
    { insert: "sessions", values: { name: "veto" } },
    { insert: "receipts", values: { token: "veto" } },
  ])).rejects.toThrow();
  expect(events).toEqual(["before_create", "after_create", "invalidate", "before_create"]);
  events.length = 3;
  expect(await runtime.listEntries.execute({ collection: "sessions" })).toHaveLength(1);
  expect(await runtime.listEntries.execute({ collection: "receipts" })).toHaveLength(1);
  expect(await runtime.listEntries.execute({ collection: "blocks" })).toHaveLength(1);
  expect((await runtime.listEntries.execute({ collection: "blocks" }))[0]?.data.sessionId).toBe(first.ok ? first.data.sessionId : "");
  const duplicate = await runtime.invokeProcedure({
    procedure: "record-session", input: { name: "B", token: "once" }, ctx,
  });
  expect(duplicate).toMatchObject({ ok: false, diagnostic: { code: "CONFLICT" } });
  expect(events).toEqual(["before_create", "after_create", "invalidate", "before_create"]);
  expect(await runtime.listEntries.execute({ collection: "sessions" })).toHaveLength(1);
  expect(await runtime.listEntries.execute({ collection: "blocks" })).toHaveLength(1);

  await expect(runtime.store.write([
    { insert: "sessions", values: { name: "batch-duplicate" } },
    { insert: "receipts", values: { token: "batch-duplicate" } },
    { insert: "receipts", values: { token: "batch-duplicate" } },
  ])).rejects.toMatchObject({ diagnostic: { code: "CONFLICT" } });
  expect((await runtime.listEntries.execute({ collection: "sessions" })).some((row) => row.data.name === "batch-duplicate")).toBe(false);

  const firstReceipt = (await runtime.listEntries.execute({ collection: "receipts" }))[0]!;
  const swapped = await runtime.store.write([
    { delete: "receipts", where: { id: firstReceipt.id }, lock: firstReceipt.version },
    { insert: "receipts", values: { token: "once" } },
  ]);
  expect(swapped[0]).toEqual({ deleted: 1 });
  expect(swapped[1]).toMatchObject({ version: 1 });
  expect(await runtime.listEntries.execute({ collection: "receipts" })).toHaveLength(1);

  await expect(runtime.store.write([
    { insert: "sessions", values: { name: "validated" } },
    { insert: "blocks", values: { name: 42, sessionId: "invalid" } },
  ])).rejects.toMatchObject({ diagnostics: [{ code: "INPUT_VALIDATION_FAILED" }] });
  expect(await runtime.listEntries.execute({ collection: "sessions" })).toHaveLength(1);

  const existing = await runtime.createDraft.execute({ collection: "sessions", data: { name: "old" }, authorId: null });
  await runtime.updateDraft.execute({ collection: "sessions", id: existing.id, expectedVersion: 1, data: { name: "new" } });
  await expect(runtime.store.write([{
    updte: "sessions", set: { name: "typo" }, where: { id: existing.id }, lock: 2,
  } as unknown as Parameters<MantleStore["write"]>[0][number]])).rejects.toMatchObject({ diagnostic: { code: "INPUT_VALIDATION_FAILED" } });
  expect((await runtime.getEntry.execute({ collection: "sessions", id: existing.id })).data.name).toBe("new");
  const effectsBeforeStale = events.length;
  // A set-based delete whose expected count is not met rolls back the whole group.
  await expect(runtime.store.write([
    { insert: "receipts", values: { token: "count-mismatch" } },
    { delete: "blocks", where: { name: "no such block" }, expect: 1 },
  ])).rejects.toMatchObject({ diagnostic: { code: "CONFLICT" } });
  expect(await runtime.listEntries.execute({ collection: "receipts" })).toHaveLength(1);
  await expect(runtime.store.write([
    { insert: "receipts", values: { token: "second" } },
    { update: "sessions", set: { name: "stale" }, where: { id: existing.id }, lock: 1 },
  ])).rejects.toMatchObject({ diagnostic: { code: "CONFLICT" } });
  expect(await runtime.listEntries.execute({ collection: "receipts" })).toHaveLength(1);
  expect((await runtime.getEntry.execute({ collection: "sessions", id: existing.id })).data.name).toBe("new");
  expect(events).toHaveLength(effectsBeforeStale);

  await expect(runtime.store.write([
    { insert: "receipts", values: { token: "third" } },
    { delete: "sessions", where: { id: existing.id }, lock: 1 },
  ])).rejects.toMatchObject({ diagnostic: { code: "CONFLICT" } });
  expect(await runtime.listEntries.execute({ collection: "receipts" })).toHaveLength(1);
  await runtime.store.write([
    { delete: "sessions", where: { id: existing.id }, lock: 2 },
    { insert: "receipts", values: { token: "third" } },
  ]);
  expect(await runtime.listEntries.execute({ collection: "receipts" })).toHaveLength(2);
  expect(events.filter((event) => event === "invalidate")).toHaveLength(4);
  database.close();
});

test("Bun enforces caller scope in real SQLite select and set delete", async () => {
  const scopedSource = `apiVersion: cms.mantle.aotter.net/v1
kind: Schema
metadata: { name: privateSessions }
spec:
  title: Private sessions
  lifecycle: operational
  scope: { ownerId: $ctx.user.id }
  indexes: [[ownerId]]
  schema:
    type: object
    required: [ownerId]
    properties: { ownerId: { type: string }, label: { type: string } }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Procedure
metadata: { name: clear-mine }
spec:
  input: { type: object }
  output: { type: object }
  handler: { kind: ref, ref: clearMine }
`;
  const parsed = parseManifestSources({ sources: [{ sourceId: "scope", text: scopedSource }] });
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
  const linked = linkManifestSet(parsed.value);
  if (!linked.ok) throw new Error(JSON.stringify(linked.diagnostics));
  const compiled = compileRuntimePlan(linked.value);
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
  const database = new Database(":memory:");
  const runtime = await createBunMantle({ plan: compiled.value, database, handlers: {
    clearMine: async (_input: unknown, ctx: HandlerContext) => {
      const before = (await ctx.store!.select({ from: "privateSessions" })).rows.map((row) => row["id"]);
      const deleted = await ctx.store!.write([{ delete: "privateSessions", where: { label: "old" } }]);
      return { before, deleted };
    },
  } }).getRuntime();
  await runtime.store.write([
    { insert: "privateSessions", id: "a", values: { ownerId: "a", label: "old" } },
    { insert: "privateSessions", id: "b", values: { ownerId: "b", label: "old" } },
  ]);
  const result = await runtime.invokeProcedure({ procedure: "clear-mine", input: {}, ctx: { user: { id: "a" }, staff: null, env: {} } });
  expect(result).toMatchObject({ ok: true, data: { before: ["a"], deleted: [{ deleted: 1 }] } });
  expect((await runtime.store.select({ from: "privateSessions" })).rows.map((row) => row["id"])).toEqual(["b"]);
  database.close();
});
