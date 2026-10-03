import { describe, expect, it } from "vitest";
import { compilePlan, planFingerprint, type RuntimePlan } from "../../src/spec/index.js";
import { DiagnosticError, verifyPlan } from "../../src/core/index.js";
import { sqliteStorage } from "../../src/d1/index.js";
import { postgresStorage } from "../../src/postgres/index.js";
import * as pgCompile from "../../src/postgres/compile/index.js";
import { LocalD1 } from "../../src/cloudflare/testing/d1.js";
import { convergeStorage } from "../../src/d1/storage.js";

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
    const emptyBound = { A_Expr: { ...oneBound.A_Expr, rexpr: { List: { items: [zero, {}] } } } };
    const emptyIn = { A_Expr: { kind: "AEXPR_IN", name: [{ String: { sval: "=" } }], lexpr: col, rexpr: { List: { items: [{}] } } } };
    const castOf = (names: string[]) => ({ A_Expr: { kind: "AEXPR_OP", name: [{ String: { sval: ">" } }], lexpr: col, rexpr: { TypeCast: { arg: { A_Const: { sval: { sval: "1" } } }, typeName: { names: names.map((sval) => ({ String: { sval } })), typemod: -1 } } } } });
    for (const where of [oneBound, not2, emptyBound, emptyIn, castOf(["inpg_catalog", "terval"]), castOf(["pg_catalog.timestamptz"])]) {
      const p2 = await reseal(plan, (p) => ({ ...p, schemas: { ...p.schemas, items: { ...p.schemas.items!, checks: [where] } } }));
      expect((await verifyPlan(p2, d1())).map((d) => d.path)).toEqual(["plan#/schemas/items/checks/0"]);
    }
  });

  it("reads a check's subquery by structure: a string 'SubLink' is not one", async () => {
    const r = await compilePlan({ sources: [{ sourceId: "memory:verify", text: MANIFESTS.replace('checks: ["stock >= 0"]', `checks: ["stock >= 0", "name <> 'SubLink'"]`) }] });
    if (!r.ok) throw new Error(JSON.stringify(r.diagnostics));
    expect(await verifyPlan(r.plan, d1())).toEqual([]);
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

  it("refuses Schema names that are not the CLI's: one layer folds them and another does not", async () => {
    const plan = await compile();
    const twin = await reseal(plan, (p) => ({ ...p, schemas: { ...p.schemas, Items: { ...p.schemas.items!, name: "Items", scope: undefined } } }));
    const scope = await reseal(plan, (p) => ({ ...p, schemas: { ...p.schemas, items: { ...p.schemas.items!, scope: "Owner", fields: { ...p.schemas.items!.fields, Owner: "text" } } } }));
    const index = await reseal(plan, (p) => ({ ...p, schemas: { ...p.schemas, items: { ...p.schemas.items!, indexes: [["nope"]] } } }));
    for (const p of [twin, scope, index]) expect((await verifyPlan(p, d1())).some((d) => d.path.startsWith("plan#/schemas/"))).toBe(true);
    expect((await verifyPlan(plan, d1())).length).toBe(0);
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

describe("verifyPlan: the plan's other fields", () => {
  const WRITES = `${MANIFESTS}---
apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: { name: bump }
spec:
  input: { type: object, required: [id], properties: { id: { type: string } } }
  output: { type: object, required: [results] }
  handler: { sql: "UPDATE items SET stock = stock + 1 WHERE id = input.id" }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: { name: drop }
spec:
  input: { type: object, required: [id], properties: { id: { type: string } } }
  output: { type: object, required: [results] }
  handler: { sql: "DELETE FROM items WHERE id = input.id" }
`;
  const plan = async () => {
    const r = await compilePlan({ sources: [{ sourceId: "memory:verify", text: WRITES }] });
    if (!r.ok) throw new Error(JSON.stringify(r.diagnostics));
    return r.plan;
  };
  const paths = async (p: RuntimePlan) => (await verifyPlan(p, d1())).map((d) => d.path);
  const schema = (fields: Record<string, string>, extra: object = {}) => ({ name: "", fields, names: Object.fromEntries(Object.keys(fields).map((f) => [f, f])), schema: { type: "object" }, ...extra });

  it("refuses a write target or relation that is not lower case: hooks and publishing are keyed by the folded name", async () => {
    const base = await plan();
    expect(await verifyPlan(base, d1())).toEqual([]);
    for (const name of ["bump", "drop"]) {
      const upper = await reseal(base, (p) => {
        const handler = structuredClone(p.procedures[name]!.handler) as { sql: { stmts: any[] } };
        const stmt = handler.sql.stmts[0];
        (stmt.UpdateStmt ?? stmt.DeleteStmt).relation.relname = "ITEMS";
        return { ...p, procedures: { ...p.procedures, [name]: { ...p.procedures[name]!, handler } as never } };
      });
      expect(await paths(upper)).toEqual([`plan#/procedures/${name}`]);
    }
    const read = await reseal(base, (p) => {
      const stmt = structuredClone(p.views.stock!.stmts[0]!) as any;
      stmt.SelectStmt.fromClause[0].RangeVar.relname = "Items";
      return { ...p, views: { ...p.views, stock: { ...p.views.stock!, stmts: [stmt] } } };
    });
    expect(await paths(read)).toEqual(["plan#/views/stock"]);
  });

  it("refuses a Trigger whose Procedure is not in the plan, and MCP tools a surface cannot build", async () => {
    const base = await plan();
    const missing = await reseal(base, (p) => ({ ...p, triggers: { t: { source: { kind: "mcp", surface: "public" }, procedure: "nope" } } }));
    expect((await verifyPlan(missing, d1())).map((d) => [d.code, d.path])).toEqual([["TRIGGER_TARGET_PROCEDURE_UNKNOWN", "plan#/triggers/t"]]);
    const proto = await reseal(base, (p) => ({ ...p, triggers: { t: { source: { kind: "http", method: "POST", path: "/x" }, procedure: "toString" } } }));
    expect((await verifyPlan(proto, d1())).map((d) => d.code)).toEqual(["TRIGGER_TARGET_PROCEDURE_UNKNOWN"]);
    const twins = await reseal(base, (p) => ({
      ...p, procedures: { ...p.procedures, add_item: p.procedures["add-item"]! },
      triggers: { a: { source: { kind: "mcp", surface: "staff" }, procedure: "add-item" }, b: { source: { kind: "mcp", surface: "staff" }, procedure: "add_item" } },
    }));
    expect(await paths(twins)).toEqual(["plan#/mcp/staff"]);
    const paging = await reseal(base, (p) => ({ ...p, views: { ...p.views, stock: { ...p.views.stock!, input: { type: "object", properties: { cursor: { type: "string" } } } } } }));
    expect(await paths(paging)).toEqual(["plan#/mcp/staff"]);
  });

  it("refuses a lifecycle Trigger whose hooks are not hook names, or whose Schema is not in the plan: it would bind nothing", async () => {
    const base = await plan();
    const hook = (source: object) => reseal(base, (p) => ({ ...p, triggers: { h: { source: { kind: "lifecycle", schema: "items", on: ["before_create"], ...source }, procedure: "audit" } as never } }));
    expect(await verifyPlan(await hook({}), d1())).toEqual([]);
    for (const source of [{ on: ["before_creat"] }, { on: "before_create" }, { on: [] }, { schema: "nope" }, { schema: 1 }])
      expect((await paths(await hook(source))).every((x) => x.startsWith("plan#/triggers/h"))).toBe(true);
    for (const source of [{ on: ["before_creat"] }, { schema: "nope" }]) expect((await paths(await hook(source))).length).toBe(1);
  });

  it("refuses geo fields whose R*Trees would name one table, here and in D1 storage", async () => {
    const base = await plan();
    const geo = (schemas: Record<string, ReturnType<typeof schema>>) => reseal(base, (p) => ({ ...p, schemas: { ...p.schemas, ...Object.fromEntries(Object.entries(schemas).map(([k, v]) => [k, { ...v, name: k }])) } as never }));
    expect(await verifyPlan(await geo({ a: schema({ b: "geo" }), a_b: schema({ c: "geo" }) }), d1())).toEqual([]);
    for (const c of [{ a: schema({ b_c: "geo" }), a_b: schema({ c: "geo" }) }, { a: schema({ g: "geo", g_node: "geo" }) }, { a: schema({ g: "geo", g_rowid: "geo" }) }]) {
      expect((await paths(await geo(c))).some((x) => x.startsWith("plan#/schemas/a"))).toBe(true);
      // the CLI's path: D1 storage blocks it before it creates a table
      const r = await convergeStorage(await LocalD1.create(), Object.fromEntries(Object.entries(c).map(([k, v]) => [k, { ...v, name: k }])) as never, { fingerprint: "f" });
      expect(r.blocked.map((b) => b.code)).toContain("STORAGE_CHANGE_BLOCKED");
    }
  });

  it("checks field types as storage takes them: a numeric precision storage refuses is refused here", async () => {
    const base = await plan();
    const typed = (t: string) => reseal(base, (p) => ({ ...p, schemas: { ...p.schemas, items: { ...p.schemas.items!, fields: { ...p.schemas.items!.fields, price: t } } } }));
    for (const t of ["numeric(15, 2)", "numeric(5,0)", "date", "geo"]) expect(await verifyPlan(await typed(t), d1())).toEqual([]);
    for (const t of ["numeric(16, 2)", "numeric(0, 0)", "numeric(3, 4)", "varchar", "Text"]) expect(await paths(await typed(t))).toEqual(["plan#/schemas/items"]);
  });

  it("refuses a TTL every read would fail on: ttl and ttlSeconds together, a whole number of seconds", async () => {
    const base = await plan();
    const ttl = (extra: object) => reseal(base, (p) => ({ ...p, schemas: { ...p.schemas, items: { ...p.schemas.items!, fields: { ...p.schemas.items!.fields, expires: "timestamptz" }, ...extra } } }));
    for (const ok of [{ ttl: "expires", ttlSeconds: 60 }, { ttl: "expires", ttlSeconds: 0 }]) expect(await verifyPlan(await ttl(ok), d1())).toEqual([]);
    for (const bad of [{ ttl: "expires" }, { ttlSeconds: 60 }, { ttl: "expires", ttlSeconds: -1 }, { ttl: "expires", ttlSeconds: 1.5 }, { ttl: "expires", ttlSeconds: "60" }, { ttl: "expires", ttlSeconds: 1e15 }])
      expect(await paths(await ttl(bad))).toEqual(["plan#/schemas/items"]);
  });

  it("checks a View's columns against the plan's Schemas: Store decodes and Admin labels by them", async () => {
    const base = await plan();
    expect(base.views.stock!.columns).toEqual({ name: { schema: "items", field: "name" } });
    const cols = (columns: unknown) => reseal(base, (p) => ({ ...p, views: { ...p.views, stock: { ...p.views.stock!, columns } as never } }));
    expect(await verifyPlan(await cols({ name: { schema: "items", field: "name" }, at: { schema: "items", field: "created_at" } }), d1())).toEqual([]);
    for (const bad of [{ name: { schema: "nope", field: "name" } }, { name: { schema: "items", field: "nope" } }, { name: { schema: "toString", field: "name" } }, { name: null }, { name: "items.name" }])
      expect(await paths(await cols(bad))).toEqual(["plan#/views/stock/columns"]);
  });

  it("checks a View's uiSchema.list as the CLI does: lists of the View's outputs", async () => {
    const base = await plan();
    const ui = (uiSchema: unknown) => reseal(base, (p) => ({ ...p, views: { ...p.views, stock: { ...p.views.stock!, uiSchema } as never } }));
    expect(await verifyPlan(await ui({ list: { columns: ["name"], searchFields: ["name"], filterFields: ["running", "NAME"] } }), d1())).toEqual([]);
    for (const bad of [{ list: { searchFields: "name" } }, { list: { filterFields: [1] } }, { list: { searchFields: ["stock"] } }, { list: { filterFields: ["nope"] } }, { list: [] }])
      expect((await paths(await ui(bad))).every((x) => x.startsWith("plan#/views/stock/uiSchema"))).toBe(true);
    for (const bad of [{ list: { searchFields: "name" } }, { list: { searchFields: ["stock"] } }]) expect((await paths(await ui(bad))).length).toBe(1);
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
