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
