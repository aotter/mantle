import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { linkManifestSet, parseManifestSources } from "@aotter/mantle-spec";
import { compileRuntimePlan, type HandlerContext } from "@aotter/mantle-runtime";
import { createBunMantle } from "../src/index.js";

const source = `apiVersion: cms.mantle.aotter.net/v1
kind: Schema
metadata: { name: events }
spec:
  title: Events
  lifecycle: operational
  ttl: { field: expiresAt, expireAfterSeconds: 0 }
  schema:
    type: object
    properties:
      label: { type: string }
      expiresAt: { type: string, format: date-time, nullable: true }
---
apiVersion: cms.mantle.aotter.net/v1
kind: View
metadata: { name: current-events }
spec:
  surface: public
  from: events
  fields: [id, label]
---
apiVersion: cms.mantle.aotter.net/v1
kind: Procedure
metadata: { name: sweep-events }
spec:
  input: { type: object }
  output: { type: object }
  handler: { kind: ref, ref: sweepEvents }
`;

test("Bun TTL hides expired rows before an explicit bounded, resumable sweep", async () => {
  const parsed = parseManifestSources({ sources: [{ sourceId: "ttl", text: source }] });
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
  const linked = linkManifestSet(parsed.value);
  if (!linked.ok) throw new Error(JSON.stringify(linked.diagnostics));
  const compiled = compileRuntimePlan(linked.value);
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
  const database = new Database(":memory:");
  const now = Date.now();
  const mantle = createBunMantle({
    plan: compiled.value, database,
    ports: { clock: { now: () => now } },
    handlers: { sweepEvents: async (_input: unknown, ctx: HandlerContext) =>
      ctx.store!.sweepExpired({ collection: "events", limit: 1 }) },
  });
  const runtime = await mantle.getRuntime();
  const rows = [];
  for (const [label, expiresAt] of [
    ["past", new Date(now - 1_000).toISOString()],
    ["boundary", new Date(now).toISOString()],
    ["future", new Date(now + 60_000).toISOString()],
    ["missing", undefined],
    ["null", null],
  ] as const) {
    rows.push(await runtime.createDraft.execute({ collection: "events", data: { label, ...(expiresAt !== undefined ? { expiresAt } : {}) }, authorId: null }));
  }
  expect((await runtime.listEntries.execute({ collection: "events" })).map((row) => row.data.label).sort())
    .toEqual(["future", "missing", "null"]);
  expect(await runtime.entries.readById({ collection: "events", id: rows[0]!.id })).toBeNull();
  const view = await runtime.executeView({ view: "current-events" });
  expect(view.ok && view.result.rows.map((row) => row.label).sort()).toEqual(["future", "missing", "null"]);
  const preview = await runtime.invokeProcedure({ procedure: "sweep-events", input: {}, ctx: { user: null, staff: null, env: {} } });
  expect(preview).toMatchObject({ ok: true, data: { scanned: 1, removed: 0 } });
  expect(database.query("SELECT count(*) AS count FROM events").get()).toEqual({ count: 5 });
  const first = await runtime.store.sweepExpired({ collection: "events", limit: 1, delete: true });
  expect(first).toMatchObject({ scanned: 1, removed: 1 });
  expect(first.nextCursor).toBeTruthy();
  const second = await runtime.store.sweepExpired({ collection: "events", limit: 1, delete: true, cursor: first.nextCursor });
  expect(second).toMatchObject({ scanned: 1, removed: 1 });
  expect(database.query("SELECT count(*) AS count FROM events").get()).toEqual({ count: 3 });
  expect((await runtime.listEntries.execute({ collection: "events" })).map((row) => row.data.label).sort())
    .toEqual(["future", "missing", "null"]);
  database.query('UPDATE events SET "expiresAt" = ? WHERE "_mantle_id" = ?').run("legacy-invalid", rows[2]!.id);
  expect(await runtime.entries.readById({ collection: "events", id: rows[2]!.id })).not.toBeNull();
  expect((await runtime.store.sweepExpired({ collection: "events", delete: true })).removed).toBe(0);
  database.close();
});

test("a very long TTL does not hide valid dates", async () => {
  const parsed = parseManifestSources({ sources: [{ sourceId: "long-ttl", text: source.replace(
    "expireAfterSeconds: 0", "expireAfterSeconds: 9000000000000",
  ) }] });
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
  const linked = linkManifestSet(parsed.value);
  if (!linked.ok) throw new Error(JSON.stringify(linked.diagnostics));
  const compiled = compileRuntimePlan(linked.value);
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
  const database = new Database(":memory:");
  const runtime = await createBunMantle({ plan: compiled.value, database,
    handlers: { sweepEvents: async () => ({}) },
  }).getRuntime();
  await runtime.createDraft.execute({ collection: "events", data: {
    label: "still live", expiresAt: "2020-01-01T00:00:00.000Z",
  }, authorId: null });
  expect((await runtime.listEntries.execute({ collection: "events" })).map((row) => row.data.label))
    .toEqual(["still live"]);
  expect((await runtime.store.sweepExpired({ collection: "events", delete: true })).removed).toBe(0);
  database.close();
});
