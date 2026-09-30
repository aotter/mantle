import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PG_GRAMMAR, compilePlan } from "../../src/spec/index.js";

const fixture = readFileSync(fileURLToPath(new URL("./fixtures/pipeline/valid.yaml", import.meta.url)), "utf8");

const SCHEMA = `apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: { name: notes }
spec:
  title: Notes
  lifecycle: operational
  indexes: [[ownerId]]
  scope: { ownerId: auth.uid() }
  schema:
    type: object
    required: [ownerId]
    properties: { ownerId: { type: string }, body: { type: string } }
`;
const view = (sql: string) => `---
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: { name: v }
spec: { surface: staff, sql: "${sql}", input: { type: object, properties: { q: { type: string } } } }
`;
const procedure = (sql: string) => `---
apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: { name: p }
spec:
  input: { type: object, properties: { text: { type: string } } }
  output: { type: object }
  handler: { sql: "${sql}" }
`;
const compile = (text: string) => compilePlan({ sources: [{ sourceId: "memory:plan", text }] });

describe("compilePlan", () => {
  it("compiles every View and inline Procedure of the example manifests to IR", async () => {
    const res = await compile(fixture);
    if (!res.ok) throw new Error(JSON.stringify(res.diagnostics));
    expect(Object.keys(res.plan.views)).toEqual(["open-orders"]);
    expect(res.plan.views["open-orders"]).toMatchObject({ grammar: PG_GRAMMAR, stmts: [{ SelectStmt: expect.any(Object) }] });
    expect(res.plan.procedures["cancel-order"]!.handler).toMatchObject({ sql: { grammar: PG_GRAMMAR } });
    expect(res.plan).toMatchObject({ version: 6, fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/) });
  });

  it("carries Schema checks as IR, and the fingerprint follows the plan", async () => {
    const withCheck = (c: string) => SCHEMA.replace("  lifecycle: operational", `  lifecycle: operational\n  checks: ["${c}"]`);
    const a = await compile(withCheck("length(body) > 0"));
    const same = await compile(withCheck("length(body) > 0"));
    const other = await compile(withCheck("length(body) > 1"));
    if (!a.ok || !same.ok || !other.ok) throw new Error("did not compile");
    expect(a.plan.schemas["notes"]!.checks).toHaveLength(1);
    expect(a.plan.schemas["notes"]!.checks![0]).toHaveProperty("A_Expr");
    expect([a.plan.fingerprint === same.plan.fingerprint, a.plan.fingerprint === other.plan.fingerprint]).toEqual([true, false]);
    const sub = await compile(withCheck("body IN (SELECT body FROM notes)"));
    if (sub.ok) throw new Error("accepted a subquery in a check");
    expect(sub.diagnostics[0]).toMatchObject({ code: "SQL_SHAPE", source: { path: "/spec/checks/0" } });
  });

  // ponytail: one row per way the context reaches the SQL compiler; the dialect itself is tested in sql-compile.
  it.each([
    ["View sql past the subset", view("SELECT id FROM notes ORDER BY id OFFSET 2"), "SQL_UNSUPPORTED", "/spec/sql", 1],
    ["undeclared Schema", procedure("DELETE FROM nope WHERE id = input.text"), "SQL_RELATION", "/spec/handler/sql", 1],
    ["undeclared input", view("SELECT id FROM notes WHERE body = input.zzz"), "SQL_COLUMN", "/spec/sql", 1],
    ["declared input (camel case folds)", view("SELECT id FROM notes WHERE body = input.Q"), undefined],
    ["the scope column, from the Schema's scope", procedure("INSERT INTO notes (ownerId, body) VALUES (input.text, input.text)"), "SQL_WRITE", "/spec/handler/sql", 1],
    ["a declared field", procedure("INSERT INTO notes (body) VALUES (input.text)"), undefined],
  ] as const)("%s", async (_name, doc, code, pointer, line) => {
    const res = await compile(SCHEMA + doc);
    if (!code) return expect(res.ok).toBe(true);
    if (res.ok) throw new Error("accepted");
    expect(res.diagnostics).toHaveLength(1);
    expect(res.diagnostics[0]).toMatchObject({
      code,
      severity: "error",
      path: `memory:plan#/1${pointer}`,
      source: { sourceId: "memory:plan", documentIndex: 1, path: pointer },
      value: { line },
    });
    expect(res.diagnostics[0]!.message).toMatch(/^SQL \d+:\d+/);
  });

  it("returns manifest diagnostics before compiling; a 0.1.x manifest names mantle-update", async () => {
    const res = await compile(SCHEMA.replace("/v2", "/v1"));
    if (res.ok) throw new Error("accepted");
    expect(res.diagnostics[0]?.message).toContain("mantle-update");
  });

  it("refuses an inline program as a lifecycle hook target (it would write inside a before hook)", async () => {
    const trigger = `---
apiVersion: cms.mantle.aotter.net/v2
kind: Trigger
metadata: { name: audit }
spec: { source: { kind: lifecycle, schema: notes, on: [before_update] }, target: { procedure: p } }
`;
    const res = await compile(SCHEMA + procedure("INSERT INTO notes (body) VALUES (input.text)") + trigger);
    if (res.ok) throw new Error("accepted an inline hook target");
    expect(res.diagnostics[0]).toMatchObject({ code: "LIFECYCLE_TARGET_NOT_REF" });
  });
});
