import { describe, expect, it } from "vitest";
import { compilePlan, planFingerprint, type RuntimePlan } from "../../src/spec/index.js";
import { DiagnosticError, verifyPlan } from "../../src/core/index.js";
import { sqliteStorage } from "../../src/d1/index.js";
import { postgresStorage } from "../../src/postgres/index.js";
import * as pgCompile from "../../src/postgres/compile/index.js";

const MANIFESTS = `apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: { name: items }
spec:
  title: Items
  lifecycle: operational
  scope: { owner: auth.uid() }
  indexes: [[owner]]
  schema:
    type: object
    required: [owner]
    properties: { owner: { type: string }, name: { type: string }, stock: { type: integer } }
---
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: { name: stock }
spec:
  surface: staff
  sql: "SELECT name, sum(stock) OVER (ORDER BY name) AS running FROM items ORDER BY name"
---
apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: { name: add-item }
spec:
  requires: { auth: { all: [ctx.user] } }
  input: { type: object, required: [name], properties: { name: { type: string } } }
  output: { type: object, required: [results] }
  handler: { sql: "INSERT INTO items (name, stock) VALUES (input.name, 0) RETURNING id" }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: { name: audit }
spec:
  input: { type: object }
  output: { type: object }
  handler: { ref: audit }
`;

const compile = async (dialect?: typeof pgCompile) => {
  const r = await compilePlan({ sources: [{ sourceId: "memory:verify", text: MANIFESTS }] }, ...(dialect ? [dialect] : []));
  if (!r.ok) throw new Error(JSON.stringify(r.diagnostics));
  return r.plan;
};
const reseal = async (plan: RuntimePlan, change: (p: Omit<RuntimePlan, "fingerprint">) => Omit<RuntimePlan, "fingerprint">): Promise<RuntimePlan> => {
  const { fingerprint: _old, ...body } = plan;
  const next = change(structuredClone(body));
  return { ...next, fingerprint: await planFingerprint(next) } as RuntimePlan;
};
// only the dialect is read: no driver call may happen
const d1 = (options = {}) => sqliteStorage({} as never, options);
const pg = (options = {}) => postgresStorage({ connect: () => { throw new Error("unreachable"); }, ...options });

describe("verifyPlan", () => {
  it("passes a plan as compiled, on its own dialect, without handlers or a database", async () => {
    expect(await verifyPlan(await compile(), d1())).toEqual([]);
    expect(await verifyPlan(await compile(pgCompile), pg())).toEqual([]);
  });

  it("refuses what boot refuses: a plan changed after it was sealed, or compiled for another dialect", async () => {
    const plan = await compile();
    const tampered = { ...plan, views: {} };
    expect((await verifyPlan(tampered, d1())).map((d) => d.code)).toEqual(["PLAN_FINGERPRINT_MISMATCH"]);
    expect((await verifyPlan(await compile(pgCompile), d1())).map((d) => d.code)).toEqual(["PLAN_FINGERPRINT_MISMATCH"]);
  });

  it("checks every program's IR: a resealed plan that claims a dialect its IR does not pass is refused, with the program's path", async () => {
    const plan = await compile();
    // the uploader rewrote a View's IR and resealed: what the CLI compiled no longer matters, the IR is checked
    const lying = await reseal(plan, (p) => ({ ...p, views: { ...p.views, stock: { ...p.views.stock!, stmts: [{ SelectStmt: { targetList: [{ ResTarget: { val: { FuncCall: { funcname: [{ String: { sval: "pg_read_file" } }], args: [{ A_Const: { sval: { sval: "/etc/passwd" } } }] } } } }], limitOption: "LIMIT_OPTION_DEFAULT", op: "SETOP_NONE" } }] } } }));
    const out = await verifyPlan(lying, d1());
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((d) => d.path === "plan#/views/stock")).toBe(true);
  });

  it("runs the operator's restrict on every program", async () => {
    const restrict = () => [{ code: "CLOUD_REFUSED", message: "no window functions here" }];
    const out = await verifyPlan(await compile(), d1({ restrict }));
    expect(out.map((d) => d.path).sort()).toEqual(["plan#/procedures/add-item", "plan#/views/stock"]);
    expect(out.every((d) => d.message.includes("CLOUD_REFUSED"))).toBe(true);
  });
});

describe("DiagnosticError across bundles", () => {
  it("matches a copy of the class from another bundle by its brand, and nothing else", () => {
    // what a closed-module handler throws: its own bundled copy of the class
    const Copy = class extends Error { readonly [Symbol.for("net.aotter.mantle.DiagnosticError")] = true; diagnostics = []; };
    expect(new Copy() instanceof DiagnosticError).toBe(true);
    expect(new Error("x") instanceof DiagnosticError).toBe(false);
    expect(null instanceof DiagnosticError).toBe(false);
    class Narrower extends DiagnosticError {}
    expect(new DiagnosticError([]) instanceof Narrower).toBe(false);
  });
});
