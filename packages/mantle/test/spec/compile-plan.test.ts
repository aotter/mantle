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
    expect(res.plan).toMatchObject({ version: 6, dialect: { name: "@aotter/mantle/d1", version: "1" }, fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/) });
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

  it("carries what Admin and MCP show, unchanged, and a plan without it is unchanged", async () => {
    const plain = await compilePlan({ sources: [{ sourceId: "m", text: SCHEMA + view("SELECT id FROM notes") }] });
    const rich = await compilePlan({ sources: [{ sourceId: "m", text: SCHEMA.replace("title: Notes", "title: { en: Notes, zh-TW: 筆記 }\n  description: My notes\n  localized: false\n  uiSchema: { list: { columns: [body] } }") + view("SELECT id FROM notes").replace("surface: staff,", "surface: staff, title: Mine, description: Mine only, uiSchema: { list: { columns: [id] } },") }] });
    if (!plain.ok || !rich.ok) throw new Error("compile");
    expect(plain.plan.schemas.notes).toMatchObject({ name: "notes", title: "Notes" });
    expect(plain.plan.schemas.notes).not.toHaveProperty("uiSchema");
    expect(rich.plan.schemas.notes).toMatchObject({ name: "notes", title: { en: "Notes", "zh-TW": "筆記" }, description: "My notes", uiSchema: { list: { columns: ["body"] } } });
    expect(rich.plan.views.v).toMatchObject({ title: "Mine", description: "Mine only", uiSchema: { list: { columns: ["id"] } } });
    expect(rich.plan.fingerprint).not.toBe(plain.plan.fingerprint);
  });

  it("returns manifest diagnostics before compiling; a 0.1.x manifest names the upgrade guide", async () => {
    const res = await compile(SCHEMA.replace("/v2", "/v1"));
    if (res.ok) throw new Error("accepted");
    expect(res.diagnostics[0]?.message).toContain("upgrade-0.1-to-0.2.md");
  });

  it("refuses a uiSchema.list.searchFields or filterFields name the View's SELECT does not output (ADR-0032 decision 5)", async () => {
    const withList = (list: string) => SCHEMA + view("SELECT id, body AS text FROM notes ORDER BY id").replace("surface: staff,", `surface: staff, uiSchema: { list: { ${list} } },`);
    expect((await compile(withList("searchFields: [text], filterFields: [ID]"))).ok).toBe(true);
    const bad = await compile(withList("searchFields: [body], filterFields: [ownerId]"));
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.diagnostics.map((d) => [d.code, d.value])).toEqual([["VIEW_UI_INVALID", "body"], ["VIEW_UI_INVALID", "ownerId"]]);
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

describe("names that differ only by case", () => {
  const codes = async (text: string) => { const r = await compile(text); return r.ok ? [] : r.diagnostics.map((d) => d.code); };
  it("two fields are FIELD_NAME_CASE_COLLISION, not one column", async () => {
    expect(await codes(SCHEMA.replace("body: { type: string } }", "body: { type: string }, Body: { type: integer } }"))).toEqual(["FIELD_NAME_CASE_COLLISION"]);
  });
  it("two inputs of a Procedure are FIELD_NAME_CASE_COLLISION, not one input", async () => {
    const text = SCHEMA + procedure("INSERT INTO notes (body) VALUES (input.text)").replace("text: { type: string }", "text: { type: string }, Text: { type: string }");
    expect(await codes(text)).toEqual(["FIELD_NAME_CASE_COLLISION"]);
    // a ref handler reads the JS object, where they are two keys
    expect(await codes(text.replace('handler: { sql: "INSERT INTO notes (body) VALUES (input.text)" }', "handler: { ref: p }"))).toEqual([]);
  });
  it("two Schemas are SCHEMA_NAME_CASE_COLLISION, not one table", async () => {
    expect(await codes(`${SCHEMA}---\n${SCHEMA.replace("name: notes", "name: Notes")}`)).toEqual(["SCHEMA_NAME_CASE_COLLISION"]);
  });
});
