import { afterAll, beforeAll, expect, it } from "vitest";
import { LocalD1 } from "../../src/cloudflare/testing/d1.js";
import { compilePlan } from "../../src/spec/index.js";
import { createMantleRuntime, type Caller, type MantleRuntime } from "../../src/core/index.js";
import { sqliteStorage } from "../../src/d1/index.js";

const MANIFESTS = `apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: { name: sessions }
spec:
  title: Sessions
  lifecycle: operational
  scope: { owner: auth.uid() }
  indexes: [[owner]]
  ttl: { field: seenAt, expireAfterSeconds: 60 }
  schema:
    type: object
    required: [owner]
    properties: { owner: { type: string }, label: { type: string }, seenAt: { type: string, format: date-time } }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: { name: touch }
spec:
  requires: { auth: { all: [ctx.user] } }
  input: { type: object, required: [label, at], properties: { label: { type: string }, at: { type: string, format: date-time } } }
  output: { type: object }
  handler: { sql: "INSERT INTO sessions (label, seenAt) VALUES (input.label, input.at)" }
`;
const user: Caller = { kind: "user", subject: "o1", role: null, scopes: [], credential: "session", credentialId: null, clientId: null };
const NOW = Date.parse("2026-09-30T12:00:00Z") * 1000;
let rt: MantleRuntime;
let d1: LocalD1;
beforeAll(async () => {
  const res = await compilePlan({ sources: [{ sourceId: "memory:ttl", text: MANIFESTS }] });
  if (!res.ok) throw new Error(JSON.stringify(res.diagnostics));
  d1 = await LocalD1.create();
  rt = await createMantleRuntime({ plan: res.plan, handlers: {}, storage: sqliteStorage(d1), now: () => NOW });
}, 60_000);
afterAll(() => d1.dispose());

it("the TTL field is an author-written timestamp: a row is invisible once it is expireAfterSeconds old, a NULL never expires, and the sweep removes it", async () => {
  const at = (secondsAgo: number) => new Date(NOW / 1000 - secondsAgo * 1000).toISOString();
  for (const [label, ago] of [["fresh", 10], ["edge", 59], ["old", 61], ["older", 3600]] as const) await rt.invokeProcedure({ procedure: "touch", input: { label, at: at(ago) }, caller: user, cause: { kind: "http", id: label } });
  await rt.store.as(user).write([{ insert: "sessions", values: { label: "never" } }]);
  const labels = async () => (await rt.store.as(user).select({ from: "sessions", columns: ["label"], orderBy: { label: "asc" } })).rows.map((r) => r.label);
  expect(await labels()).toEqual(["edge", "fresh", "never"]);
  expect(await rt.store.sweepExpired({ collection: "sessions", delete: false })).toEqual({ scanned: 2, removed: 0 });
  expect(await rt.store.sweepExpired({ collection: "sessions" })).toEqual({ scanned: 2, removed: 2 });
  expect((await d1.all("SELECT count(*) AS c FROM sessions"))[0]).toEqual({ c: 3 });
});


it("a suppressed native delete preserves candidate scanned count and the full-page cursor", async () => {
  const at = new Date(NOW / 1000 - 120_000).toISOString();
  for (const label of ["remove-1", "remove-2", "keep-last", "next-page"])
    await rt.invokeProcedure({ procedure: "touch", input: { label, at }, caller: user, cause: { kind: "http", id: label } });
  await d1.exec("CREATE TRIGGER keep_expired BEFORE DELETE ON sessions WHEN old.label = 'keep-last' BEGIN SELECT RAISE(IGNORE); END");
  try {
    const preview = await rt.store.sweepExpired({ collection: "sessions", limit: 3, delete: false });
    expect(preview).toMatchObject({ scanned: 3, removed: 0, nextCursor: expect.any(String) });
    const removed = await rt.store.sweepExpired({ collection: "sessions", limit: 3 });
    expect(removed).toEqual({ ...preview, removed: 2 });
    expect(await rt.store.sweepExpired({ collection: "sessions", limit: 3, cursor: removed.nextCursor })).toEqual({ scanned: 1, removed: 1 });
    expect(await d1.all("SELECT label FROM sessions WHERE label = 'keep-last'")).toEqual([{ label: "keep-last" }]);
  } finally { await d1.exec("DROP TRIGGER keep_expired"); }
});
