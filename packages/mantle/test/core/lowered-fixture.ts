// @ts-nocheck shared fixture of the generate-time lowering tests (ADR-0044)
import { compilePlan, planFingerprint, type RuntimePlan } from "../../src/spec/index.js";
import type { Caller, MantleHandlers } from "../../src/core/index.js";

/** A scoped Schema with a unique index, a public View with ORDER BY, a staff View with input and ORDER BY, inline insert and update Procedures, and an after_create hook on a ref handler. */
export const MANIFESTS = `apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: { name: items }
spec:
  title: Items
  lifecycle: operational
  scope: { owner: auth.uid() }
  indexes: [[owner]]
  uniqueIndexes: [[owner, name]]
  checks: ["stock >= 0"]
  schema:
    type: object
    required: [owner]
    properties: { owner: { type: string }, name: { type: string }, stock: { type: integer } }
---
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: { name: shelf }
spec:
  surface: public
  sql: "SELECT id, name, stock FROM items ORDER BY name"
---
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: { name: low-stock }
spec:
  surface: staff
  input: { type: object, properties: { max: { type: integer, default: 100 } } }
  sql: "SELECT id, name, stock FROM items WHERE stock <= input.max ORDER BY stock, id"
---
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: { name: everything }
spec:
  surface: staff
  sql: "SELECT id, name FROM items"
---
apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: { name: add-item }
spec:
  requires: { auth: { all: [ctx.user] } }
  input: { type: object, required: [name, stock], properties: { name: { type: string }, stock: { type: integer } } }
  output: { type: object, required: [results] }
  handler: { sql: "INSERT INTO items (name, stock) VALUES (input.name, input.stock) RETURNING id, name" }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: { name: take }
spec:
  requires: { auth: { all: [ctx.user] } }
  input: { type: object, required: [id, qty], properties: { id: { type: string }, qty: { type: integer } } }
  output: { type: object, required: [results] }
  handler: { sql: "UPDATE items SET stock = stock - input.qty WHERE id = input.id RETURNING id, stock" }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: { name: audit }
spec:
  input: { type: object }
  output: { type: object }
  handler: { ref: audit }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Trigger
metadata: { name: audit-create }
spec: { source: { kind: lifecycle, schema: items, on: [after_create] }, target: { procedure: audit } }
`;

export const handlers = { audit: () => ({}) } as unknown as MantleHandlers<never>;
export const user = (subject: string): Caller => ({ kind: "user", subject, role: null, scopes: [], credential: "session", credentialId: null, clientId: null });
export const anonymous: Caller = { kind: "anonymous" } as Caller;

export async function compile(dialect?: unknown, text = MANIFESTS): Promise<RuntimePlan> {
  const r = await compilePlan({ sources: [{ sourceId: "memory:lowered", text }] }, ...(dialect ? [dialect] : []));
  if (!r.ok) throw new Error(JSON.stringify(r.diagnostics));
  return r.plan;
}

/** The plan as it was, with a change, and a fingerprint that covers it. */
export async function reseal(plan: RuntimePlan, change: (p: Record<string, any>) => Record<string, any>): Promise<RuntimePlan> {
  const { fingerprint: _f, ...body } = plan;
  const next = change(structuredClone(body));
  return { ...next, fingerprint: await planFingerprint(next) } as RuntimePlan;
}

/** Deterministic ids and time, so two runtimes' rows compare equal. */
export const deterministic = () => {
  let n = 0;
  return { now: () => 1_800_000_000_000_000, newId: () => `id${String(++n).padStart(4, "0")}` };
};
