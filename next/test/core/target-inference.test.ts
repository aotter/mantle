import { describe, expect, it } from "vitest";
import { classify, compilePlan, compileSql, type SqlNode } from "../../src/spec/index.js";
import { StoreJson } from "../../src/core/store/json.js";
import type { StoreWriteOp } from "../../src/core/store.js";

const SCHEMAS = { notes: { scope: "owner", fields: { title: "text", n: "integer", at: "timestamptz" } } };
const classOf = async (sql: string): Promise<string> => {
  const r = await compileSql(sql, { schemas: SCHEMAS, inputs: { id: "text", v: "integer", t: "text" }, kind: "procedure" });
  if (!r.ok) throw new Error(r.diagnostic.message);
  return classify(r.plan.stmts[0] as SqlNode);
};

describe("Procedure.target inference agrees with Store (ADR-0032 decision 2)", () => {
  // the same statement, written as SQL and as a Store op, is the same class
  it.each<[string, string, StoreWriteOp]>([
    ["id alone", "UPDATE notes SET title = input.t WHERE id = input.id", { update: "notes", set: { title: "x" }, where: { id: "a" } }],
    ["id with more conditions", "UPDATE notes SET title = input.t WHERE id = input.id AND n >= 0", { update: "notes", set: { title: "x" }, where: { id: "a", n: { gte: 0 } } }],
    ["id as eq", "UPDATE notes SET title = input.t WHERE id = 'a'", { update: "notes", set: { title: "x" }, where: { id: { eq: "a" } } }],
    ["another column", "UPDATE notes SET title = input.t WHERE title = 'x'", { update: "notes", set: { title: "x" }, where: { title: "x" } }],
    ["id in a list", "UPDATE notes SET title = input.t WHERE id IN ('a', 'b')", { update: "notes", set: { title: "x" }, where: { id: { in: ["a", "b"] } } }],
    ["delete by id", "DELETE FROM notes WHERE id = input.id", { delete: "notes", where: { id: "a" } }],
    ["delete by column", "DELETE FROM notes WHERE n = 1", { delete: "notes", where: { n: 1 } }],
    ["a one-row insert", "INSERT INTO notes (title) VALUES (input.t)", { insert: "notes", values: { title: "x" } }],
    ["an upsert", "INSERT INTO notes (title) VALUES (input.t) ON CONFLICT (title) DO NOTHING", { insert: "notes", values: { title: "x" }, onConflict: "ignore" }],
  ])("%s", async (_name, sql, op) => {
    expect(await classOf(sql)).toBe(StoreJson.isRowOp(op) ? "row" : "set");
  });

  it("an input named id is a value, not the entry's id, in both readings", async () => {
    expect(await classOf("UPDATE notes SET title = input.t WHERE input.id = id")).toBe("row");
    expect(await classOf("UPDATE notes SET title = input.t WHERE input.id = input.t")).toBe("set");
  });
});

const MANIFEST = `apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: { name: notes }
spec:
  title: Notes
  lifecycle: operational
  scope: { owner: auth.uid() }
  indexes: [[owner]]
  schema:
    type: object
    required: [owner]
    properties: { owner: { type: string }, title: { type: string }, at: { type: string, format: date-time } }
`;
const procedure = (name: string, sql: string, extra = "") => `---
apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: { name: ${name} }
spec:
  input: { type: object, required: [id], properties: { id: { type: string }, t: { type: string }, v: { type: integer } } }
  output: { type: object }
  ${extra}
  handler: { sql: "${sql}" }
`;
const plan = async (text: string) => {
  const r = await compilePlan({ sources: [{ sourceId: "memory:t", text: MANIFEST + text }] });
  if (!r.ok) throw new Error(JSON.stringify(r.diagnostics));
  return r.plan;
};

describe("compilePlan infers a target", () => {
  it("from exactly one row op that pins id to an input, with the version when it is locked", async () => {
    const p = await plan(procedure("locked", "UPDATE notes SET title = input.t WHERE id = input.id AND version = input.v") + procedure("plain", "DELETE FROM notes WHERE id = input.id"));
    expect(p.procedures["locked"]!.target).toEqual({ schema: "notes", id: "id", version: "v" });
    expect(p.procedures["plain"]!.target).toEqual({ schema: "notes", id: "id" });
  });

  it("not when the id is a literal, not pinned, or there is more than one row op; an explicit target wins", async () => {
    const p = await plan(
      procedure("literal", "UPDATE notes SET title = input.t WHERE id = 'a'")
      + procedure("bulk", "UPDATE notes SET title = input.t WHERE title = input.t")
      + procedure("two", "UPDATE notes SET title = input.t WHERE id = input.id; DELETE FROM notes WHERE id = input.id")
      + procedure("explicit", "UPDATE notes SET title = input.t WHERE id = input.id", "target: { schema: notes, id: id }"),
    );
    expect(["literal", "bulk", "two"].map((n) => p.procedures[n]!.target)).toEqual([undefined, undefined, undefined]);
    expect(p.procedures["explicit"]!.target).toEqual({ schema: "notes", id: "id" });
  });
});

describe("a text literal in a typed column", () => {
  it("is refused at compile time, not left to fail as a 500 on a STRICT table", async () => {
    for (const sql of ["INSERT INTO notes (at) VALUES ('tomorrow')", "UPDATE notes SET at = '2026-01-01' WHERE id = input.id"]) {
      const r = await compilePlan({ sources: [{ sourceId: "memory:t", text: MANIFEST + procedure("bad", sql) }] });
      if (r.ok) throw new Error("accepted");
      expect(r.diagnostics[0]).toMatchObject({ code: "SQL_TYPE" });
    }
    expect((await plan(procedure("ok", "INSERT INTO notes (at, title) VALUES (CAST('2026-01-01T00:00:00Z' AS timestamptz), 'x')"))).procedures["ok"]).toBeDefined();
  });
});
