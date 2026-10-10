import { afterAll, beforeAll, expect, it } from "vitest";
import { LocalD1 } from "../../src/cloudflare/testing/d1.js";
import { compilePlan, DiagnosticError } from "../../src/spec/index.js";
import { createMantleRuntime, type Caller, type MantleRuntime } from "../../src/core/index.js";
import { sqliteStorage } from "../../src/d1/index.js";

const MANIFESTS = `apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: { name: tickets }
spec:
  title: Tickets
  lifecycle: operational
  scope: { owner: auth.uid() }
  indexes: [[owner]]
  schema:
    type: object
    required: [owner, subject, priority]
    properties:
      owner: { type: string }
      subject: { type: string, minLength: 3 }
      priority: { type: string, enum: [low, high] }
      due: { type: string, format: date-time }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: { name: pages }
spec:
  title: Pages
  schema: { type: object, required: [title], properties: { title: { type: string }, body: { type: string } } }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: { name: stock }
spec:
  title: Stock
  lifecycle: operational
  uniqueIndexes: [[sku]]
  schema: { type: object, required: [sku, qty], properties: { sku: { type: string }, qty: { type: integer, minimum: 0 } } }
`;
const user: Caller = { kind: "user", subject: "o1", role: null, scopes: [], credential: "session", credentialId: null, clientId: null };
let rt: MantleRuntime;
let d1: LocalD1;
beforeAll(async () => {
  const res = await compilePlan({ sources: [{ sourceId: "memory:v", text: MANIFESTS }] });
  if (!res.ok) throw new Error(JSON.stringify(res.diagnostics));
  d1 = await LocalD1.create();
  rt = await createMantleRuntime({ plan: res.plan, handlers: {}, storage: sqliteStorage(d1) });
}, 60_000);
afterAll(() => d1.dispose());

const message = async (p: Promise<unknown>) => ((await p.then(() => undefined, (e) => e)) as DiagnosticError | undefined)?.diagnostic.message;

it("an insert must satisfy the Schema (the scope field is Store's to fill), an update checks only what it sets", async () => {
  const s = rt.store.as(user);
  const [row] = await s.write([{ insert: "tickets", values: { subject: "printer", priority: "high", due: "2026-10-01T00:00:00Z" } }]);
  expect(row).toMatchObject({ version: 1 });
  expect(await message(s.write([{ insert: "tickets", values: { priority: "high" } }]))).toMatch(/subject/);
  expect(await message(s.write([{ insert: "tickets", values: { subject: "printer", priority: "urgent" } }]))).toMatch(/priority/);
  expect(await message(s.write([{ insert: "tickets", values: { subject: "ab", priority: "low" } }]))).toMatch(/subject/);
  expect(await message(s.write([{ insert: "tickets", values: { subject: "printer", priority: "low", due: "tomorrow" } }]))).toMatch(/due/);
  const id = (row as { id: string }).id;
  expect(await s.write([{ update: "tickets", set: { priority: "low" }, where: { id } }])).toEqual([{ id, version: 2 }]);
  expect(await message(s.write([{ update: "tickets", set: { priority: "meh" }, where: { id } }]))).toMatch(/priority/);
});

it("a publishing Schema is not checked yet: drafts save incomplete, validated on publish", async () => {
  const [row] = await rt.store.as(user).write([{ insert: "pages", values: { body: "just a sketch" } }]);
  expect(row).toMatchObject({ version: 1 });
});

it("null clears a field the Schema does not require, and stays refused for one it requires", async () => {
  const s = rt.store.as(user);
  const [row] = await s.write([{ insert: "tickets", values: { subject: "toner", priority: "low", due: null } }]);
  const id = (row as { id: string }).id;
  await s.write([{ update: "tickets", set: { due: "2026-10-02T00:00:00Z" }, where: { id } }]);
  // a row read back and written whole, as an editor does: the unset field comes back null and goes back null
  await s.write([{ update: "tickets", set: { due: null, subject: "toner cartridge" }, where: { id } }]);
  expect((await s.db.tickets.find({ columns: ["subject", "due"], where: { id } })).rows).toEqual([{ subject: "toner cartridge", due: null }]);
  expect(await message(s.write([{ update: "tickets", set: { subject: null }, where: { id } }]))).toMatch(/subject/);
  expect(await message(s.write([{ insert: "tickets", values: { subject: "x-ray", priority: null } }]))).toMatch(/priority/);
});

it("a column named in another case is checked as declared, and an upsert's update is checked too", async () => {
  const s = rt.store.as(user);
  const [row] = await s.write([{ insert: "tickets", values: { subject: "scanner", priority: "low" } }]);
  const id = (row as { id: string }).id;
  expect(await message(s.write([{ update: "tickets", set: { SUBJECT: null }, where: { id } }]))).toMatch(/subject/);
  expect(await message(s.write([{ update: "tickets", set: { Subject: "ab" }, where: { id } }]))).toMatch(/subject/);
  expect(await message(s.write([{ insert: "tickets", values: { subject: "fax", priority: "low", Subject: null } }]))).toMatch(/twice/);
  const upsert = (update: Record<string, unknown>) => s.write([{ insert: "stock", values: { sku: "A", qty: 1 }, onConflict: { columns: ["sku"], update } }]);
  await upsert({ qty: 1 });
  expect(await message(upsert({ qty: null }))).toMatch(/qty/);
  expect(await message(upsert({ qty: -1 }))).toMatch(/qty/);
  await upsert({ qty: 5 });
  expect((await s.db.stock.find({ columns: ["qty"], where: { sku: "A" } })).rows).toEqual([{ qty: 5 }]);
});
