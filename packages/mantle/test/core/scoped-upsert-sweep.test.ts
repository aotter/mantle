// Regressions found upgrading Swolhalla to 0.2: an ON CONFLICT target that names the scope field, which unique op a
// CONFLICT came from, and TTL maintenance from a schedule Trigger's handler.
import { afterAll, beforeAll, expect, it } from "vitest";
import { LocalD1 } from "../../src/cloudflare/testing/d1.js";
import { compilePlan, DiagnosticError } from "../../src/spec/index.js";
import { createMantleRuntime, systemCaller, type Caller, type MantleRuntime } from "../../src/core/index.js";
import { sqliteStorage } from "../../src/d1/index.js";

const MANIFESTS = `apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: { name: workouts }
spec:
  title: Workouts
  lifecycle: operational
  scope: { ownerId: auth.uid() }
  schema:
    type: object
    required: [ownerId, clientKey]
    properties: { ownerId: { type: string }, clientKey: { type: string }, note: { type: string } }
  uniqueIndexes: [[ownerId, clientKey]]
---
apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: { name: receipts }
spec:
  title: Receipts
  lifecycle: operational
  scope: { ownerId: auth.uid() }
  ttl: { field: expiresAt, expireAfterSeconds: 0 }
  schema:
    type: object
    required: [ownerId, requestKey]
    properties: { ownerId: { type: string }, requestKey: { type: string }, expiresAt: { type: string, format: date-time } }
  uniqueIndexes: [[ownerId, requestKey]]
---
apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: { name: log-named }
spec:
  requires: { auth: { all: [ctx.user] } }
  input: { type: object, required: [clientKey], properties: { clientKey: { type: string }, note: { type: string } } }
  output: { type: object }
  handler: { sql: "INSERT INTO workouts (clientKey, note) VALUES (input.clientKey, input.note) ON CONFLICT (ownerId, clientKey) DO NOTHING RETURNING id" }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: { name: log-implied }
spec:
  requires: { auth: { all: [ctx.user] } }
  input: { type: object, required: [clientKey], properties: { clientKey: { type: string }, note: { type: string } } }
  output: { type: object }
  handler: { sql: "INSERT INTO workouts (clientKey, note) VALUES (input.clientKey, input.note) ON CONFLICT (clientKey) DO UPDATE SET note = EXCLUDED.note RETURNING id" }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: { name: sweep }
spec:
  input: { type: object }
  output: { type: object }
  handler: { ref: sweep }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Trigger
metadata: { name: sweep-daily }
spec: { source: { kind: schedule, cron: "0 3 * * *" }, target: { procedure: sweep } }
`;
const user = (subject: string): Caller => ({ kind: "user", subject, role: null, scopes: [], credential: "session", credentialId: null, clientId: null });
let rt: MantleRuntime;
let d1: LocalD1;
let seen: { sweep?: unknown } = {};
beforeAll(async () => {
  const res = await compilePlan({ sources: [{ sourceId: "memory:scoped-upsert", text: MANIFESTS }] });
  if (!res.ok) throw new Error(JSON.stringify(res.diagnostics));
  d1 = await LocalD1.create();
  rt = await createMantleRuntime({ plan: res.plan, storage: sqliteStorage(d1), schedules: true, handlers: {
    sweep: async (_input: unknown, ctx: { caller: Caller; store: { sweepExpired?: (r: { collection: string }) => Promise<unknown> } }) => {
      seen = { sweep: typeof ctx.store.sweepExpired };
      return ctx.caller.kind === "system" && ctx.store.sweepExpired ? ctx.store.sweepExpired({ collection: "receipts" }) : {};
    },
  } });
}, 60_000);
afterAll(() => d1.dispose());
const call = (procedure: string, input: unknown, caller: Caller) => rt.invokeProcedure({ procedure, input, caller, cause: { kind: "http", id: `${procedure}-${Math.random()}` } });

it("an ON CONFLICT target that names the scope field, or leaves it out, is the scope-led unique index either way", async () => {
  await call("log-named", { clientKey: "k1", note: "first" }, user("a"));
  await call("log-named", { clientKey: "k1", note: "second" }, user("a")); // DO NOTHING: the retry changes nothing
  await call("log-named", { clientKey: "k1", note: "other owner" }, user("b")); // the same key is another owner's own row
  await call("log-implied", { clientKey: "k1", note: "updated" }, user("a"));
  const notes = async (s: string) => (await rt.store.as(user(s)).db.workouts.find({ columns: ["note"] })).rows.map((r) => r.note);
  expect(await notes("a")).toEqual(["updated"]);
  expect(await notes("b")).toEqual(["other owner"]);
});

it("a unique CONFLICT names the operation when exactly one operation of the write targets the violated table", async () => {
  const store = rt.store.as(user("c"));
  await store.write([{ insert: "workouts", values: { clientKey: "dup" } }]);
  const failed = await store.write([
    { insert: "receipts", values: { requestKey: "r1" } },
    { insert: "workouts", values: { clientKey: "dup" } },
  ]).catch((e: unknown) => e);
  expect(failed).toBeInstanceOf(DiagnosticError);
  expect((failed as DiagnosticError).diagnostic.conflict).toEqual({ reason: "unique", opIndex: 1 });
  // two operations on the violated table: the engine cannot say which, so the index is left out
  const ambiguous = await store.write([
    { insert: "workouts", values: { clientKey: "fresh" } },
    { insert: "workouts", values: { clientKey: "dup" } },
  ]).catch((e: unknown) => e);
  expect((ambiguous as DiagnosticError).diagnostic.conflict).toEqual({ reason: "unique" });
});

it("a schedule Trigger's handler, run as the system caller, sweeps expired rows; a member's ctx.store cannot", async () => {
  await rt.store.as(user("d")).write([{ insert: "receipts", values: { requestKey: "old", expiresAt: "2000-01-01T00:00:00Z" } }]);
  await rt.invokeProcedure({ procedure: "sweep", input: {}, caller: user("d"), cause: { kind: "http", id: "member-sweep" } });
  expect(seen.sweep).toBe("undefined");
  const swept = await rt.invokeProcedure({ procedure: "sweep", input: {}, caller: systemCaller("schedule"),
    cause: { kind: "schedule", id: "sweep-daily:0", trigger: "sweep-daily", cron: "0 3 * * *", scheduledTime: 0 } });
  expect(seen.sweep).toBe("function");
  expect(swept).toEqual({ scanned: 1, removed: 1 });
});
