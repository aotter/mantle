// @ts-nocheck test code over loosely typed plans and rows
/** ADR-0037 decision 3: a View reads an internal View; its native CTE retains policy and every check. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalD1 } from "../../src/cloudflare/testing/d1.js";
import { compilePlan } from "../../src/spec/index.js";
import { createMantleRuntime, type Caller } from "../../src/core/index.js";
import { sqliteStorage } from "../../src/d1/index.js";
import * as pgCompile from "../../src/postgres/compile/index.js";

const doc = (kind: string, name: string, spec: string) => `apiVersion: cms.mantle.aotter.net/v2\nkind: ${kind}\nmetadata: { name: ${name} }\nspec:\n${spec}`;
const NOTES = doc("Schema", "notes", `  title: Notes
  lifecycle: operational
  scope: { owner: auth.uid() }
  schema:
    type: object
    required: [owner]
    properties: { owner: { type: string }, title: { type: string }, due: { type: string, format: date-time } }
  indexes: [[owner]]`);
const view = (name: string, sql: string, extra = "  surface: internal\n") => doc("View", name, `${extra}  sql: "${sql}"`);
const compile = (...docs: string[]) => compilePlan({ sources: [{ sourceId: "memory:refs", text: [NOTES, ...docs].join("\n---\n") }] });
const user = (subject: string): Caller => ({ kind: "user", subject, role: null, scopes: [], credential: "session", credentialId: null, clientId: null });

describe("View references", () => {
  let d1: LocalD1;
  beforeAll(async () => { d1 = await LocalD1.create(); }, 60_000);
  afterAll(() => d1.dispose());

  it("shares an internal View through a native CTE, under the caller's scope, keeping its outputs' types", async () => {
    const res = await compile(
      view("open-notes", "SELECT id, title, due FROM notes WHERE title <> 'done'"),
      view("next-notes", "SELECT o.id, o.title, o.due FROM open_notes o ORDER BY o.due", "  surface: public\n  requires: { auth: { all: [ctx.user] } }\n"),
    );
    expect(res.ok, JSON.stringify(res.diagnostics)).toBe(true);
    expect(JSON.stringify(res.plan.views["next-notes"].stmts)).toContain('"CommonTableExpr"');
    expect(res.plan.views["next-notes"].columns?.due).toEqual({ schema: "notes", field: "due" });
    const rt = await createMantleRuntime({ plan: res.plan, handlers: {}, storage: sqliteStorage(d1) });
    for (const [owner, title, due] of [["a", "write", "2026-01-02T00:00:00Z"], ["a", "done", "2026-01-01T00:00:00Z"], ["b", "theirs", "2026-01-01T00:00:00Z"], ["a", "read", "2026-01-01T00:00:00Z"]])
      await rt.store.as(user(owner)).write([{ insert: "notes", values: { title, due } }]);
    const rows = (await rt.store.as(user("a")).view("next-notes")).rows;
    expect(rows.map((r) => [r.title, r.due])).toEqual([["read", "2026-01-01T00:00:00.000000Z"], ["write", "2026-01-02T00:00:00.000000Z"]]);
  });

  it("refuses a public View, a View with an input, a cycle and a write; a Schema keeps its name", async () => {
    const errors = async (...docs: string[]) => { const r = await compile(...docs); expect(r.ok).toBe(false); return r.diagnostics.map((d) => d.message).join("\n"); };
    expect(await errors(view("all-notes", "SELECT id FROM notes", "  surface: public\n"), view("x", "SELECT a.id FROM all_notes a"))).toMatch(/all_notes is a public View: FROM reads only an internal View/);
    expect(await errors(doc("View", "by-title", "  surface: internal\n  input: { type: object, properties: { t: { type: string } } }\n  sql: \"SELECT id FROM notes WHERE title = input.t\""), view("x", "SELECT b.id FROM by_title b")))
      .toMatch(/by_title is a View with an input/);
    expect(await errors(view("a", "SELECT x.id FROM b x"), view("b", "SELECT y.id FROM a y"))).toMatch(/reads itself: a -> b -> a/);
    expect(await errors(view("open", "SELECT id FROM notes"), doc("Procedure", "p", "  input: { type: object }\n  output: { type: object }\n  handler: { sql: \"DELETE FROM open\" }"))).toMatch(/open is a View: a View is read, never written/);
    // a CTE named like a View is the CTE, not a dependency: no false cycle
    const ctePlan = await compilePlan({ sources: [{ sourceId: "memory:refs", text: [NOTES, view("cyc-a", "WITH cyc_b AS (SELECT id FROM notes) SELECT id FROM cyc_b"), view("cyc-b", "SELECT x.id FROM cyc_a x")].join("\n---\n") }] }, pgCompile);
    expect(ctePlan.ok, JSON.stringify(ctePlan.diagnostics)).toBe(true);
    // a View named like a Schema is fine; the name reads the Schema
    expect((await compile(view("notes", "SELECT id FROM notes"), view("y", "SELECT n.id FROM notes n"))).ok).toBe(true);
  });
});
