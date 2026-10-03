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
  checks: ["stock >= 0"]
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

  it("reports the policy rewrite's refusals as diagnostics, for a plan the CLI compiled as is", async () => {
    const r = await compilePlan({ sources: [{ sourceId: "memory:verify", text: MANIFESTS.replace("SELECT name, sum(stock) OVER (ORDER BY name) AS running FROM items ORDER BY name", "SELECT name FROM (SELECT name FROM items) s ORDER BY name") }] });
    if (!r.ok) throw new Error(JSON.stringify(r.diagnostics));
    const out = await verifyPlan(r.plan, d1());
    expect(out.map((d) => [d.code, d.path])).toEqual([["INPUT_VALIDATION_FAILED", "plan#/views/stock"]]);
  });

  it("checks a Schema's checks, which DDL runs on every write: a resealed check calling a function the dialect refuses is refused", async () => {
    const sleep = { FuncCall: { funcname: [{ String: { sval: "pg_sleep" } }], args: [{ A_Const: { ival: { ival: 1000000 } } }] } };
    const subquery = { SubLink: { subLinkType: "EXISTS_SUBLINK", subselect: {} } };
    for (const plan of [await compile(), await compile(pgCompile)]) {
      const storage = plan.dialect.name.includes("postgres") ? pg() : d1();
      const hostile = await reseal(plan, (p) => ({ ...p, schemas: { ...p.schemas, items: { ...p.schemas.items!, checks: [...p.schemas.items!.checks!, sleep, subquery] } } }));
      expect((await verifyPlan(hostile, storage)).map((d) => d.path)).toEqual(["plan#/schemas/items/checks/1", "plan#/schemas/items/checks/2"]);
    }
  });

  it("refuses a literal whose value is not of its type: a literal is printed as it is", async () => {
    const plan = await compile();
    const forged = { A_Const: { ival: { ival: "1 UNION SELECT email FROM user" } } };
    const where = { A_Expr: { kind: "AEXPR_OP", name: [{ String: { sval: ">" } }], lexpr: { ColumnRef: { fields: [{ String: { sval: "stock" } }] } }, rexpr: forged } };
    const view = await reseal(plan, (p) => ({ ...p, views: { ...p.views, stock: { ...p.views.stock!, stmts: [{ SelectStmt: { ...p.views.stock!.stmts[0]!.SelectStmt, whereClause: where } }] } } }));
    expect((await verifyPlan(view, d1())).map((d) => d.path)).toEqual(["plan#/views/stock"]);
    const check = await reseal(await compile(pgCompile), (p) => ({ ...p, schemas: { ...p.schemas, items: { ...p.schemas.items!, checks: [where] } } }));
    expect((await verifyPlan(check, pg())).map((d) => d.path)).toContain("plan#/schemas/items/checks/0");
    for (const ok of [{ ival: {} }, { ival: { ival: -3 } }, { fval: { fval: "1.5e3" } }, { sval: {} }, { boolval: {} }, { isnull: true }])
      expect(await verifyPlan(await reseal(plan, (p) => ({ ...p, schemas: { ...p.schemas, items: { ...p.schemas.items!, checks: [{ ...where, A_Expr: { ...where.A_Expr, rexpr: { A_Const: ok } } }] } } })), d1())).toEqual([]);
  });

  it("refuses a node the printer would join with what policy appends: a one-bound BETWEEN, a two-operand NOT", async () => {
    const plan = await compile();
    const col = { ColumnRef: { fields: [{ String: { sval: "stock" } }] } };
    const zero = { A_Const: { ival: {} } };
    const oneBound = { A_Expr: { kind: "AEXPR_BETWEEN", name: [{ String: { sval: "BETWEEN" } }], lexpr: col, rexpr: { List: { items: [zero] } } } };
    const not2 = { BoolExpr: { boolop: "NOT_EXPR", args: [oneBound.A_Expr ? { NullTest: { arg: col, nulltesttype: "IS_NULL" } } : zero, { NullTest: { arg: col, nulltesttype: "IS_NULL" } }] } };
    for (const where of [oneBound, not2]) {
      const p2 = await reseal(plan, (p) => ({ ...p, schemas: { ...p.schemas, items: { ...p.schemas.items!, checks: [where] } } }));
      expect((await verifyPlan(p2, d1())).map((d) => d.path)).toEqual(["plan#/schemas/items/checks/0"]);
    }
  });

  it("refuses a CTE name that is not a plain identifier: the PostgreSQL printer writes it as it is", async () => {
    const text = MANIFESTS.replace("SELECT name, sum(stock) OVER (ORDER BY name) AS running FROM items ORDER BY name", "WITH z AS (SELECT id, name FROM items) SELECT id, name FROM items ORDER BY name");
    const r = await compilePlan({ sources: [{ sourceId: "memory:verify", text }] }, pgCompile);
    if (!r.ok) throw new Error(JSON.stringify(r.diagnostics));
    expect(await verifyPlan(r.plan, pg())).toEqual([]);
    const injected = await reseal(r.plan, (p) => {
      const stmt = structuredClone(p.views.stock!.stmts[0]!) as any;
      stmt.SelectStmt.withClause.ctes[0].CommonTableExpr.ctename = "items as (select name, owner from items), z";
      return { ...p, views: { ...p.views, stock: { ...p.views.stock!, stmts: [stmt] } } };
    });
    expect((await verifyPlan(injected, pg())).map((d) => d.path)).toEqual(["plan#/views/stock"]);
  });

  it("refuses a node in a slot that does not take its type: the printers print any node, and policy wraps only a RangeVar in FROM", async () => {
    const plan = await compile(pgCompile);
    const view = (change: (stmt: any) => void) => reseal(plan, (p) => {
      const stmt = structuredClone(p.views.stock!.stmts[0]!) as any;
      change(stmt.SelectStmt);
      return { ...p, views: { ...p.views, stock: { ...p.views.stock!, stmts: [stmt] } } };
    });
    const proc = (change: (stmt: any) => void) => reseal(plan, (p) => {
      const handler = p.procedures["add-item"]!.handler as { sql: { stmts: any[] } };
      const stmt = structuredClone(handler.sql.stmts[0]);
      change(stmt.InsertStmt);
      return { ...p, procedures: { ...p.procedures, "add-item": { ...p.procedures["add-item"]!, handler: { ...handler, sql: { ...handler.sql, stmts: [stmt] } } } } };
    });
    const forged = [
      await view((s) => { s.fromClause = [{ String: { sval: "items" } }]; }), // a table read with no wrapper
      await view((s) => { s.limitCount = { List: { items: [{ A_Const: { ival: { ival: 2 } } }, { A_Const: { ival: { ival: 10 } } }] } }; }), // SQLite's LIMIT offset, count
      await view((s) => { s.whereClause = "1=1"; }),
      await proc((s) => { s.cols[0].ResTarget.name = { String: { sval: "status" } }; }),
      await proc((s) => { const v = s.selectStmt.SelectStmt.valuesLists[0].List.items; v[0] = { List: { items: [v[0], v[1]] } }; }),
    ];
    for (const p of forged) expect((await verifyPlan(p, pg())).length).toBeGreaterThan(0);
    const nonNode = await reseal(await compile(), (p) => ({ ...p, schemas: { ...p.schemas, items: { ...p.schemas.items!, checks: [null as never] } } }));
    expect((await verifyPlan(nonNode, d1())).map((d) => d.path)).toEqual(["plan#/schemas/items/checks/0"]);
  });

  it("refuses a malformed plan with a diagnostic, not an exception", async () => {
    const plan = await compile();
    for (const broken of [{ ...plan, procedures: { x: { handler: null } } }, { ...plan, procedures: undefined }, null])
      expect((await verifyPlan(broken as never, d1())).map((d) => d.code)).toEqual(["INVALID_MANIFEST_ENVELOPE"]);
  });

  it("runs the operator's restrict on every program", async () => {
    const restrict = () => [{ code: "CLOUD_REFUSED", message: "no window functions here" }];
    const out = await verifyPlan(await compile(), d1({ restrict }));
    expect(out.map((d) => d.path).sort()).toEqual(["plan#/procedures/add-item", "plan#/schemas/items/checks/0", "plan#/views/stock"]);
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
