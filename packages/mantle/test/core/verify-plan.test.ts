import { describe, expect, it } from "vitest";
import { compilePlan, fieldTypes, planFingerprint, type RuntimePlan } from "../../src/spec/index.js";
import { DiagnosticError, PLAN_LIMITS, createMantleRuntime, verifyPlan } from "../../src/core/index.js";
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
  it("refuses search, unique and index columns storage does not create: boot would fail on the missing column", async () => {
    const plan = await compile();
    const messages = async (change: (s: RuntimePlan["schemas"][string]) => void) =>
      (await verifyPlan(await reseal(plan, (p) => { change(p.schemas.items!); return p; }), d1())).map((d) => d.message).join("\n");
    const geo = (s: RuntimePlan["schemas"][string]) => {
      s.schema = { ...s.schema, properties: { ...s.schema.properties, loc: { type: "object", format: "geo" } } } as typeof s.schema;
      s.fields = fieldTypes(s.schema); s.names = { ...s.names, loc: "loc" };
    };
    // an operational Schema has no status column; a geo field is two columns; search reads text
    expect(await messages((s) => { s.indexes = [["owner"], ["status"]]; })).toMatch(/unique and index columns/);
    expect(await messages((s) => { s.search = ["status"]; })).toMatch(/search columns are declared text fields/);
    expect(await messages((s) => { s.search = ["stock"]; })).toMatch(/search columns are declared text fields/);
    expect(await messages((s) => { geo(s); s.indexes = [["owner"], ["loc"]]; })).toMatch(/unique and index columns/);
    expect(await messages((s) => { geo(s); s.search = ["loc"]; })).toMatch(/search columns/);
    expect(await messages((s) => { s.search = ["name"]; s.indexes = [["owner"], ["created_at"]]; })).toBe("");
    // a field may not be a column storage creates for something else
    expect(await messages((s) => { geo(s); s.schema = { ...s.schema, properties: { ...s.schema.properties, loc_lat: { type: "number" } } } as typeof s.schema; s.fields = fieldTypes(s.schema); s.names = { ...s.names, loc_lat: "loc_lat" }; })).toMatch(/"loc_lat" is a column storage creates/);
  });

  it("refuses a check that calls what storage cannot print into DDL: the CLI, verifyPlan and boot agree", async () => {
    const withCheck = (c: string) => MANIFESTS.replace('checks: ["stock >= 0"]', `checks: [${JSON.stringify(c)}]`);
    for (const c of ["name <> auth.uid()", "auth.role() IS NULL", "stock < extract(year from now())", "name::text <> ''",
      // columns this Schema's storage does not have, a qualified one, and calls DDL cannot run
      "value > 0", "status <> 'x'", "items.stock >= 0", "lower(DISTINCT name) <> 'x'", "abs(name) > 0", "length(stock) > 0", "upper(name, name) <> ''"]) {
      const r = await compilePlan({ sources: [{ sourceId: "memory:verify", text: withCheck(c) }] });
      expect([c, r.ok ? [] : r.diagnostics.map((d) => d.code)]).toEqual([c, ["SQL_SHAPE"]]);
    }
    const ok = await compilePlan({ sources: [{ sourceId: "memory:verify", text: withCheck("length(lower(name)) > 0") }] });
    if (!ok.ok) throw new Error(JSON.stringify(ok.diagnostics));
    expect(await verifyPlan(ok.plan, d1())).toEqual([]);
    await createMantleRuntime({ plan: ok.plan, handlers: { audit: () => ({}) }, storage: sqliteStorage(await LocalD1.create()) });
    // a resealed check calling auth.uid(): verify refuses it, and boot names the problem instead of a driver syntax error
    const uid = { A_Expr: { kind: "AEXPR_OP", name: [{ String: { sval: "<>" } }], lexpr: { ColumnRef: { fields: [{ String: { sval: "name" } }] } }, rexpr: { FuncCall: { funcname: [{ String: { sval: "auth" } }, { String: { sval: "uid" } }] } } } };
    const sealed = await reseal(ok.plan, (p) => { p.schemas.items!.checks = [uid as never]; return p; });
    expect((await verifyPlan(sealed, d1())).map((d) => d.message).join()).toMatch(/a check may call only lower, upper, length, abs: auth\.uid\(\)/);
    await expect(createMantleRuntime({ plan: sealed, handlers: { audit: () => ({}) }, storage: sqliteStorage(await LocalD1.create()) })).rejects.toThrow(/a check may call only/);
    const star = { ...uid, A_Expr: { ...uid.A_Expr, rexpr: { FuncCall: { funcname: [{ String: { sval: "lower" } }], agg_star: true } } } };
    expect((await verifyPlan(await reseal(ok.plan, (p) => { p.schemas.items!.checks = [star as never]; return p; }), d1())).map((d) => d.message).join()).toMatch(/takes one argument/);
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
  // a field and its JSON Schema property, as the CLI writes both
  const PROPERTY: Record<string, object> = { text: { type: "string" }, integer: { type: "integer" }, timestamptz: { type: "string", format: "date-time" }, date: { type: "string", format: "date" }, geo: { type: "object", format: "geo" } };
  const schema = (fields: Record<string, string>, extra: object = {}) => ({ name: "", fields, names: Object.fromEntries(Object.keys(fields).map((f) => [f, f])), schema: { type: "object", properties: Object.fromEntries(Object.entries(fields).map(([f, t]) => [f, PROPERTY[t]])) }, ...extra });
  /** the Schema `items` with one more field, typed `type`, whose JSON Schema property is `property` */
  const withField = (s: RuntimePlan["schemas"][string], field: string, type: string, property: object = PROPERTY[type] ?? { type: "number" }) =>
    ({ ...s, fields: { ...s.fields, [field]: type }, names: { ...s.names, [field]: field }, schema: { ...s.schema, properties: { ...s.schema.properties, [field]: property } } });

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
    const paging = await reseal(base, (p) => ({ ...p, views: { ...p.views, stock: { ...p.views.stock!, input: { type: "object", properties: { cursor: { type: "string" } } }, inputs: { cursor: "text" } } } }));
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

  it("checks field types as the CLI types them: each is its JSON Schema property's type, one storage takes", async () => {
    const base = await plan();
    const typed = (t: string, property?: object) => reseal(base, (p) => ({ ...p, schemas: { ...p.schemas, items: withField(p.schemas.items!, "price", t, property) } }));
    for (const t of ["date", "geo", "timestamptz", "integer"]) expect(await verifyPlan(await typed(t), d1())).toEqual([]);
    // numeric(p, s) has no manifest spelling: the CLI never writes one
    for (const t of ["numeric(15, 2)", "numeric(16, 2)", "numeric(0, 0)", "numeric(3, 4)", "varchar", "Text"]) expect(new Set(await paths(await typed(t)))).toEqual(new Set(["plan#/schemas/items"]));
    // a type its property does not have, a property no field has, a field no property has
    expect(await paths(await typed("integer", { type: "string" }))).toEqual(["plan#/schemas/items"]);
    const extraProperty = await reseal(base, (p) => ({ ...p, schemas: { ...p.schemas, items: { ...p.schemas.items!, schema: { ...p.schemas.items!.schema, properties: { ...p.schemas.items!.schema.properties, note: { type: "string" } } } } } }));
    const extraField = await reseal(base, (p) => ({ ...p, schemas: { ...p.schemas, items: { ...p.schemas.items!, fields: { ...p.schemas.items!.fields, note: "text" }, names: { ...p.schemas.items!.names, note: "note" } } } }));
    // two properties that fold to one column
    const folded = await reseal(base, (p) => ({ ...p, schemas: { ...p.schemas, items: { ...p.schemas.items!, schema: { ...p.schemas.items!.schema, properties: { ...p.schemas.items!.schema.properties, Name: { type: "string" } } } } } }));
    for (const p of [extraProperty, extraField, folded]) expect(new Set(await paths(p))).toEqual(new Set(["plan#/schemas/items"]));
  });

  it("checks a program's inputs against its input schema, as the CLI types them", async () => {
    const base = await plan();
    const retyped = await reseal(base, (p) => ({ ...p, procedures: { ...p.procedures, bump: { ...p.procedures.bump!, inputs: { id: "integer" } } } }));
    const viewInputs = await reseal(base, (p) => ({ ...p, views: { ...p.views, stock: { ...p.views.stock!, inputs: { q: "text" } } } }));
    expect(await paths(retyped)).toEqual(["plan#/procedures/bump/inputs"]);
    expect(await paths(viewInputs)).toEqual(["plan#/views/stock/inputs"]);
  });

  it("refuses a TTL every read would fail on: ttl and ttlSeconds together, a whole number of seconds", async () => {
    const base = await plan();
    const ttl = (extra: object) => reseal(base, (p) => ({ ...p, schemas: { ...p.schemas, items: { ...withField(p.schemas.items!, "expires", "timestamptz"), ...extra } } }));
    for (const ok of [{ ttl: "expires", ttlSeconds: 60 }, { ttl: "expires", ttlSeconds: 0 }]) expect(await verifyPlan(await ttl(ok), d1())).toEqual([]);
    // a TTL on a native or non-date column (`version` is never a recent time: every row would expire and be swept at once)
    for (const bad of [{ ttl: "version", ttlSeconds: 60 }, { ttl: "created_at", ttlSeconds: 60 }, { ttl: "name", ttlSeconds: 60 }, { ttl: "stock", ttlSeconds: 60 }])
      expect(await paths(await ttl(bad))).toEqual(["plan#/schemas/items"]);
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

describe("verifyPlan: what the CLI refuses of a manifest, refused of the plan", () => {
  const WITH_HOOKS = `${MANIFESTS}---
apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: { name: Notes }
spec:
  title: Notes
  lifecycle: operational
  schema: { type: object, properties: { body: { type: string } } }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Trigger
metadata: { name: on-note }
spec:
  source: { kind: lifecycle, schema: Notes, on: [after_create] }
  target: { procedure: audit }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Trigger
metadata: { name: audit-http }
spec:
  source: { kind: http, method: POST, path: /api/audit }
  target: { procedure: audit }
`;
  const plan = async () => {
    const r = await compilePlan({ sources: [{ sourceId: "memory:verify", text: WITH_HOOKS }] });
    if (!r.ok) throw new Error(JSON.stringify(r.diagnostics));
    return r.plan;
  };
  const codes = async (p: RuntimePlan) => (await verifyPlan(p, d1())).map((d) => [d.code, d.path]);
  const withProcedure = (base: RuntimePlan, input: object) => reseal(base, (p) => ({ ...p, procedures: { ...p.procedures, audit: { ...p.procedures.audit!, input, inputs: fieldTypes(input) } } }));

  it("bounds the plan before any other check: counts of each kind, fields, checks and each program's IR", async () => {
    const base = await plan();
    expect(await verifyPlan(base, d1())).toEqual([]);
    const many = (n: number, f: (i: number) => [string, unknown]) => Object.fromEntries(Array.from({ length: n }, (_, i) => f(i)));
    const schemas = await reseal(base, (p) => ({ ...p, schemas: { ...p.schemas, ...many(PLAN_LIMITS.schemas, (i) => [`s${i}`, { ...p.schemas.items!, name: `s${i}` }]) } }));
    const fields = await reseal(base, (p) => ({ ...p, schemas: { ...p.schemas, items: { ...p.schemas.items!, fields: many(PLAN_LIMITS.fieldsPerSchema + 1, (i) => [`f${i}`, "text"]) } } }));
    const checks = await reseal(base, (p) => ({ ...p, schemas: { ...p.schemas, items: { ...p.schemas.items!, checks: Array(PLAN_LIMITS.checksPerSchema + 1).fill(p.schemas.items!.checks![0]) } } }));
    const triggers = await reseal(base, (p) => ({ ...p, triggers: many(PLAN_LIMITS.triggers + 1, (i) => [`t${i}`, { source: { kind: "mcp", surface: "staff" }, procedure: "audit" }]) as never }));
    const deep = { BoolExpr: { boolop: "OR_EXPR", args: Array(PLAN_LIMITS.programIrValues / 2).fill({ A_Const: { boolval: { boolval: true } } }) } };
    const ir = await reseal(base, (p) => ({ ...p, schemas: { ...p.schemas, items: { ...p.schemas.items!, checks: [deep as never] } } }));
    expect(await codes(schemas)).toEqual([["RESOURCE_EXHAUSTED", "plan#/schemas"]]);
    expect(await codes(fields)).toEqual([["RESOURCE_EXHAUSTED", "plan#/schemas/items/fields"]]);
    expect(await codes(checks)).toEqual([["RESOURCE_EXHAUSTED", "plan#/schemas/items/checks"]]);
    expect(await codes(triggers)).toEqual([["RESOURCE_EXHAUSTED", "plan#/triggers"]]);
    expect(await codes(ir)).toEqual([["RESOURCE_EXHAUSTED", "plan#/schemas/items/checks/0"]]);
  });

  it("checks a plan at its limits in linear time: what the allowlist reads off every Schema is read once per plan", async () => {
    const base = await plan();
    // as many Schemas of as many fields as a plan may have, and a View per Schema: each View's columns are checked against them all
    const width = PLAN_LIMITS.fieldsPerSchema;
    const big = await reseal(base, (p) => {
      const schemas: Record<string, unknown> = { ...p.schemas };
      const views: Record<string, unknown> = { ...p.views };
      for (let i = 0; i < PLAN_LIMITS.schemas - 2; i++) {
        const fields = Object.fromEntries(Array.from({ length: width }, (_, j) => [`c${i}_${j}`, "text"]));
        schemas[`s${i}`] = { name: `s${i}`, title: "S", publishing: false, fields, names: Object.fromEntries(Object.keys(fields).map((f) => [f, f])), schema: { type: "object", properties: Object.fromEntries(Object.keys(fields).map((f) => [f, { type: "string" }])) } };
        views[`v${i}`] = { ...p.views.stock!, stmts: [{ SelectStmt: { targetList: Object.keys(fields).slice(0, 100).map((f) => ({ ResTarget: { val: { ColumnRef: { fields: [{ String: { sval: f } }] } } } })), fromClause: [{ RangeVar: { relname: `s${i}`, inh: true, relpersistence: "p", mantle: "table" } }], limitOption: "LIMIT_OPTION_DEFAULT", op: "SETOP_NONE" } }], columns: undefined, uiSchema: undefined };
      }
      return { ...p, schemas, views } as never;
    });
    const started = Date.now();
    expect(await verifyPlan(big, d1())).toEqual([]);
    expect(Date.now() - started).toBeLessThan(6_000);
  }, 30_000);

  it("refuses a TTL on a native column: sweepExpired would delete every owner's rows", async () => {
    const base = await plan();
    const ttl = await reseal(base, (p) => ({ ...p, schemas: { ...p.schemas, items: { ...p.schemas.items!, ttl: "version", ttlSeconds: 60 } } }));
    expect(await codes(ttl)).toEqual([["INPUT_VALIDATION_FAILED", "plan#/schemas/items"]]);
  });

  it("checks every JSON Schema as the CLI does: a $ref cycle that reads no value is refused, and a recursive tree is not", async () => {
    const base = await plan();
    const cycle = { type: "object", $defs: { a: { $ref: "#/$defs/b" }, b: { oneOf: [{ $ref: "#/$defs/a" }, { type: "string" }] } }, properties: { x: { $ref: "#/$defs/a" } } };
    const tree = { type: "object", $defs: { node: { type: "object", properties: { children: { type: "array", items: { $ref: "#/$defs/node" } } } } }, properties: { root: { $ref: "#/$defs/node" } } };
    expect(await verifyPlan(await withProcedure(base, tree), d1())).toEqual([]);
    const refused = await codes(await withProcedure(base, cycle));
    expect(refused.length).toBe(1);
    expect(refused[0]![1]).toMatch(/^plan#\/procedures\/audit\/input\//);
    expect(refused[0]![0]).toBe("INPUT_VALIDATION_FAILED");
    // the output, a View's input and a Schema's schema are checked too
    const output = await reseal(base, (p) => ({ ...p, procedures: { ...p.procedures, audit: { ...p.procedures.audit!, output: cycle } } }));
    const viewInput = await reseal(base, (p) => ({ ...p, views: { ...p.views, stock: { ...p.views.stock!, input: { type: "object", properties: { q: { type: "string", pattern: "^(a+)+$" } } }, inputs: { q: "text" } } } }));
    const schema = await reseal(base, (p) => ({ ...p, schemas: { ...p.schemas, items: { ...p.schemas.items!, schema: { ...p.schemas.items!.schema, properties: { ...p.schemas.items!.schema.properties, name: { type: "string", enum: Array.from({ length: 1001 }, (_, i) => `v${i}`) } } } } } }));
    expect((await codes(output)).map((x) => x[1])).toEqual([expect.stringMatching(/^plan#\/procedures\/audit\/output\//)]);
    expect((await codes(viewInput)).map((x) => x[1])).toEqual(["plan#/views/stock/input/properties/q/pattern"]);
    expect((await codes(schema)).map((x) => x[1])).toEqual(["plan#/schemas/items/schema/properties/name/enum"]);
  });

  it("refuses a pattern that backtracks exponentially: the isolate would stall on a short caller string", async () => {
    const base = await plan();
    for (const pattern of ["^(a+)+$", "(a|aa)*", "^(\\w+\\s?)*$", "((ab)*c)+", "(a*){20}"]) {
      const p = await withProcedure(base, { type: "object", properties: { s: { type: "string", pattern } } });
      expect(await codes(p)).toEqual([["INPUT_VALIDATION_FAILED", "plan#/procedures/audit/input/properties/s/pattern"]]);
    }
  });

  it("refuses a pattern whose adjacent variable quantifiers backtrack past the work bound, or that declares no maxLength", async () => {
    const base = await plan();
    for (const [pattern, maxLength] of [["^a*a*a*a*a*a*a*a*a*a*a*a*$", 31], ["\\w*\\w*\\w*\\w*\\w*\\w*\\w*\\w*$", 100], ["(a*)(a*)(a*)(a*)", 100], ["^[a-z0-9-]+$", undefined]] as const) {
      const p = await withProcedure(base, { type: "object", properties: { s: { type: "string", pattern, ...(maxLength === undefined ? {} : { maxLength }) } } });
      expect(await codes(p)).toEqual([["INPUT_VALIDATION_FAILED", "plan#/procedures/audit/input/properties/s/pattern"]]);
    }
    const email = await withProcedure(base, { type: "object", properties: { s: { type: "string", maxLength: 254, pattern: "^[^@]+@[^@]+$" } } });
    expect(await codes(email)).toEqual([]);
  });

  it("refuses an http Trigger outside /api/ or on a route another Trigger has: the CLI's graph check", async () => {
    const base = await plan();
    const outside = await reseal(base, (p) => ({ ...p, triggers: { ...p.triggers, "audit-http": { source: { kind: "http", method: "POST", path: "/admin/audit" }, procedure: "audit" } as never } }));
    const twice = await reseal(base, (p) => ({ ...p, triggers: { ...p.triggers, again: { source: { kind: "http", method: "POST", path: "/api/audit" }, procedure: "audit" } as never } }));
    expect(await codes(outside)).toEqual([["TRIGGER_PATH_INVALID", "plan#/triggers/audit-http/source/path"]]);
    expect(await codes(twice)).toEqual([["TRIGGER_PATH_COLLISION", "plan#/triggers/again/source"]]);
  });

  it("refuses a lifecycle Trigger that names its Schema in another case: the deferred after hook would be refused on every delivery", async () => {
    const base = await plan();
    expect(base.schemas.notes!.name).toBe("Notes");
    for (const schema of ["notes", "NOTES"]) {
      const folded = await reseal(base, (p) => ({ ...p, triggers: { ...p.triggers, "on-note": { source: { kind: "lifecycle", schema, on: ["after_create"] }, procedure: "audit" } as never } }));
      expect(await codes(folded)).toEqual([["LIFECYCLE_SCHEMA_UNKNOWN", "plan#/triggers/on-note"]]);
      // boot itself refuses it, verified or not
      const booted = await createMantleRuntime({ plan: folded, handlers: { audit: () => ({}) }, storage: sqliteStorage(await LocalD1.create()) }).then(() => undefined, (e) => e);
      expect((booted as DiagnosticError).diagnostics?.[0]?.code).toBe("LIFECYCLE_SCHEMA_UNKNOWN");
    }
    await createMantleRuntime({ plan: base, handlers: { audit: () => ({}) }, storage: sqliteStorage(await LocalD1.create()) });
  });
});

describe("the runtime's schema checks", () => {
  it("turn a validator that throws into a diagnostic: a plan nobody verified with a $ref cycle fails one call, not the isolate", async () => {
    const r = await compilePlan({ sources: [{ sourceId: "memory:verify", text: MANIFESTS }] });
    if (!r.ok) throw new Error(JSON.stringify(r.diagnostics));
    const cycle = { type: "object", $defs: { a: { $ref: "#/$defs/a" } }, properties: { x: { $ref: "#/$defs/a" } } };
    const plan = await reseal(r.plan, (p) => ({ ...p, procedures: { ...p.procedures, audit: { ...p.procedures.audit!, input: cycle } } }));
    const runtime = await createMantleRuntime({ plan, handlers: { audit: () => ({}) }, storage: sqliteStorage(await LocalD1.create()) });
    const e = await runtime.invokeProcedure({ procedure: "audit", input: { x: 1 }, caller: { kind: "user", subject: "u", role: null, scopes: [], credential: "session", credentialId: null, clientId: null }, cause: { kind: "http", id: "t" } }).then(() => undefined, (x) => x);
    expect(e).toBeInstanceOf(DiagnosticError);
    expect((e as DiagnosticError).diagnostics[0]!.code).toBe("INPUT_VALIDATION_FAILED");
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
