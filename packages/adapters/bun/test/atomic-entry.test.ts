import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { linkManifestSet, parseManifestSources, runtimeDiagnostic } from "@aotter/mantle-spec";
import { compileRuntimePlan, InvokeFailure, type AtomicDraftOperation, type HandlerContext } from "@aotter/mantle-runtime";
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
        const rows = await ctx.writeAtomically!([
          { kind: "create", id: sessionId, request: { collection: "sessions", data: { name: input.name }, authorId: null, ctx } },
          { kind: "create", request: { collection: "blocks", data: { name: `${input.name}-block`, sessionId }, authorId: null, ctx } },
          { kind: "create", request: { collection: "receipts", data: { token: input.token }, authorId: null, ctx } },
        ]);
        return { sessionId: rows[0]?.id };
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

  await expect(runtime.writeAtomically.execute([
    { kind: "create", request: { collection: "sessions", data: { name: "veto" }, authorId: null, originalInput: { name: "veto" } } },
    { kind: "create", request: { collection: "receipts", data: { token: "veto" }, authorId: null } },
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

  await expect(runtime.writeAtomically.execute([
    { kind: "create", request: { collection: "sessions", data: { name: "batch-duplicate" }, authorId: null } },
    { kind: "create", request: { collection: "receipts", data: { token: "batch-duplicate" }, authorId: null } },
    { kind: "create", request: { collection: "receipts", data: { token: "batch-duplicate" }, authorId: null } },
  ])).rejects.toMatchObject({ diagnostic: { code: "CONFLICT" } });
  expect((await runtime.listEntries.execute({ collection: "sessions" })).some((row) => row.data.name === "batch-duplicate")).toBe(false);

  const firstReceipt = (await runtime.listEntries.execute({ collection: "receipts" }))[0]!;
  await runtime.writeAtomically.execute([
    { kind: "delete", request: { collection: "receipts", id: firstReceipt.id, expectedVersion: firstReceipt.version } },
    { kind: "create", request: { collection: "receipts", data: { token: "once" }, authorId: null } },
  ]);
  expect(await runtime.listEntries.execute({ collection: "receipts" })).toHaveLength(1);

  await expect(runtime.writeAtomically.execute([
    { kind: "create", request: { collection: "sessions", data: { name: "validated" }, authorId: null } },
    { kind: "create", request: { collection: "blocks", data: { name: 42, sessionId: "invalid" }, authorId: null } },
  ])).rejects.toMatchObject({ diagnostics: [{ code: "INPUT_VALIDATION_FAILED" }] });
  expect(await runtime.listEntries.execute({ collection: "sessions" })).toHaveLength(1);

  const existing = await runtime.createDraft.execute({ collection: "sessions", data: { name: "old" }, authorId: null });
  await runtime.updateDraft.execute({ collection: "sessions", id: existing.id, expectedVersion: 1, data: { name: "new" } });
  await expect(runtime.writeAtomically.execute([{
    kind: "updte", request: { collection: "sessions", id: existing.id, expectedVersion: 2, data: { name: "typo" } },
  } as unknown as AtomicDraftOperation])).rejects.toMatchObject({ diagnostic: { code: "INPUT_VALIDATION_FAILED" } });
  expect((await runtime.getEntry.execute({ collection: "sessions", id: existing.id })).data.name).toBe("new");
  const effectsBeforeStale = events.length;
  await expect(runtime.writeAtomically.execute([
    { kind: "create", request: { collection: "receipts", data: { token: "status-mismatch" }, authorId: null } },
    { kind: "delete", request: { collection: "sessions", id: existing.id, expectedVersion: 2, expectedStatus: "published" } },
  ])).rejects.toMatchObject({ diagnostic: { code: "CONFLICT" } });
  expect(await runtime.listEntries.execute({ collection: "receipts" })).toHaveLength(1);
  await expect(runtime.writeAtomically.execute([
    { kind: "create", request: { collection: "receipts", data: { token: "second" }, authorId: null } },
    { kind: "update", request: { collection: "sessions", id: existing.id, expectedVersion: 1, data: { name: "stale" } } },
  ])).rejects.toMatchObject({ diagnostic: { code: "CONFLICT" } });
  expect(await runtime.listEntries.execute({ collection: "receipts" })).toHaveLength(1);
  expect((await runtime.getEntry.execute({ collection: "sessions", id: existing.id })).data.name).toBe("new");
  expect(events).toHaveLength(effectsBeforeStale);

  await expect(runtime.writeAtomically.execute([
    { kind: "create", request: { collection: "receipts", data: { token: "third" }, authorId: null } },
    { kind: "delete", request: { collection: "sessions", id: existing.id, expectedVersion: 1 } },
  ])).rejects.toMatchObject({ diagnostic: { code: "CONFLICT" } });
  expect(await runtime.listEntries.execute({ collection: "receipts" })).toHaveLength(1);
  await runtime.writeAtomically.execute([
    { kind: "delete", request: { collection: "sessions", id: existing.id, expectedVersion: 2 } },
    { kind: "create", request: { collection: "receipts", data: { token: "third" }, authorId: null } },
  ]);
  expect(await runtime.listEntries.execute({ collection: "receipts" })).toHaveLength(2);
  expect(events.filter((event) => event === "invalidate")).toHaveLength(4);
  database.close();
});
