import { afterAll, beforeAll, expect, it } from "vitest";
import { LocalD1 } from "../../src/cloudflare/testing/d1.js";
import { compilePlan, DiagnosticError } from "../../src/spec/index.js";
import { createMantleRuntime, type MantleRuntime } from "../../src/core/index.js";
import { sqliteStorage } from "../../src/d1/index.js";

const M = `apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: { name: Events }
spec:
  title: Events
  lifecycle: operational
  schema:
    type: object
    properties: { title: { type: string }, startsAt: { type: string, format: date-time }, day: { type: string, format: date }, done: { type: boolean }, meta: { type: object } }
---
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: { name: star }
spec: { surface: internal, sql: "SELECT * FROM events ORDER BY id" }
---
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: { name: picked }
spec: { surface: internal, sql: "SELECT e.id, e.startsAt AS startsAt, e.done AS finished, e.meta, e.title || '!' AS shout FROM events e ORDER BY e.id" }
`;

let d1: LocalD1;
let rt: MantleRuntime;
beforeAll(async () => {
  const r = await compilePlan({ sources: [{ sourceId: "m.yaml", text: M }] });
  if (!r.ok) throw new Error(JSON.stringify(r.diagnostics));
  d1 = await LocalD1.create();
  rt = await createMantleRuntime({ plan: r.plan, handlers: {}, storage: sqliteStorage(d1) });
  await rt.store.write([{ insert: "Events", values: { title: "a", startsAt: "2026-09-30T01:02:03.456Z", day: "2026-09-30", done: true, meta: { k: [1] } } }]);
}, 60_000);
afterAll(() => d1.dispose());

it("a View returns Schema fields decoded and named as select does, paged or not", async () => {
  const [entry] = (await rt.store.db.events.find({ columns: ["id", "title", "startsAt", "day", "done", "meta"] })).rows;
  for (const limit of [undefined, 10]) {
    const opts = limit ? { limit } : {};
    expect((await rt.store.view("star", opts)).rows).toEqual([{ title: "a", startsAt: entry!.startsAt, day: entry!.day, done: true, meta: { k: [1] } }]);
    // an alias that is the field's own name takes the declared name; another alias keeps its own; an expression is untouched
    expect((await rt.store.view("picked", opts)).rows).toEqual([{ id: entry!.id, startsAt: entry!.startsAt, finished: true, meta: { k: [1] }, shout: "a!" }]);
  }
  expect(entry!.done).toBe(true);
});

it("a View named after an Object.prototype member is unknown", async () => {
  const e = await rt.store.view("constructor").then(() => undefined, (x) => x);
  expect(e).toBeInstanceOf(DiagnosticError);
  expect((e as DiagnosticError).diagnostic.message).toBe("Unknown View 'constructor'.");
});
