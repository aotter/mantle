// @ts-nocheck original inspectable SQL IR fixtures
import {expect,it} from "vitest";
import {compilePlan,compileSql} from "../compiler.js";
import * as pgCompile from "../../src/build/postgres/compile/index.js";
const doc = (kind, name, spec) => `apiVersion: cms.mantle.aotter.net/v2\nkind: ${kind}\nmetadata: { name: ${name} }\nspec:\n${spec}`;
const schema = doc("Schema", "notes", `  title: Notes
  lifecycle: operational
  scope: "owner = auth.uid()"
  schema:
    type: object
    required: [owner]
    properties: { owner: { type: string }, title: { type: string }, due: { type: string, format: date-time } }
  indexes: [[owner, title]]`);
const view = (name, sql, input = "") => doc("View", name, `  surface: internal\n${input}  sql: ${JSON.stringify(sql)}`);
const source = (...docs) => ({ sources: [{ sourceId: "memory:cte-regression", text: [schema, ...docs].join("\n---\n") }] });
const documents = [
  view("nested", "SELECT b.id, b.title FROM base_notes b WHERE EXISTS (WITH base_notes AS (SELECT id FROM notes WHERE title = 'same') SELECT id FROM base_notes WHERE id = b.id) ORDER BY b.id"),
  view("page", "SELECT _view_0.id, _view_0.title, _view_0.due, (SELECT count(*) FROM base_notes b WHERE b.title = _view_0.title) AS siblings FROM left_notes _view_0 WHERE _view_0.title <> input.omit ORDER BY _view_0.due DESC, _view_0.id LIMIT 5", "  input: { type: object, required: [omit], properties: { omit: { type: string } } }\n"),
  view("collision", "WITH notes AS (SELECT 'fake' AS id) SELECT b.id, b.title, (SELECT count(*) FROM notes) AS marker FROM base_notes b ORDER BY b.id"),
  view("own-cte", "WITH notes AS (SELECT id, title FROM notes) SELECT notes.id, notes.title FROM notes ORDER BY notes.id"),
  view("renamed-columns", "WITH notes(id, label, deadline) AS (SELECT id, title, due FROM notes) SELECT n.id, n.label, n.deadline FROM notes n ORDER BY n.id"),
  view("first-notes", "SELECT id, title FROM notes ORDER BY title, id LIMIT 2"),
  view("first-twice", "SELECT f.id, (SELECT count(*) FROM first_notes) AS n FROM first_notes f ORDER BY f.id"),
  view("left-notes", "SELECT id, title, due FROM base_notes WHERE title <> 'hidden'"),
  view("base-notes", "SELECT id, title, due FROM notes"),
];
for(const engine of ["sqlite","postgres"]) it(`${engine} compiles lexical CTE dependencies with column provenance`,async()=>{
    const result = await compilePlan(source(...documents), engine === "postgres" ? pgCompile : undefined);
    expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
    const plan = result.plan, select = plan.views.page.stmts[0].SelectStmt;
    if (engine === "sqlite") expect(select.withClause.ctes).toHaveLength(2);
    else expect(select.withClause).toBeUndefined();
    expect(JSON.stringify(select).match(/"relname":"notes"/g)).toHaveLength(engine === "sqlite" ? 1 : 2);
    expect(plan.views["renamed-columns"].columns.deadline).toEqual({ schema: "notes", field: "due" });
    expect(plan.views.page.columns.due).toEqual({ schema: "notes", field: "due" });
    expect(JSON.stringify(select)).not.toContain('"mantle":"view"');
});
it("base WITH remains closed against recursive, materialized and data-changing CTEs and volatile functions", async () => {
  const ctx = { schemas: { notes: { fields: { title: "text" } } }, inputs: {}, kind: "view" };
  expect((await compileSql("WITH x AS (SELECT id FROM notes) SELECT id FROM x", ctx)).ok).toBe(true);
  for (const sql of ["WITH RECURSIVE x AS (SELECT id FROM notes) SELECT id FROM x", "WITH x AS MATERIALIZED (SELECT id FROM notes) SELECT id FROM x", "WITH x AS (DELETE FROM notes RETURNING id) SELECT id FROM x", "SELECT random() AS x FROM notes", "SELECT clock_timestamp() AS x FROM notes"]) expect((await compileSql(sql, ctx)).ok, sql).toBe(false);
});

it("checks CTE declaration, column and relation aliases against native printing and reserved bindings", async () => {
  const ctx = { schemas: { notes: { fields: { title: "text" } } }, inputs: { id: "text" }, kind: "view" };
  for (const sql of ["WITH nothing AS (SELECT id FROM notes) SELECT id FROM nothing", "WITH x(nothing) AS (SELECT id FROM notes) SELECT nothing FROM x", "WITH x AS (SELECT id FROM notes) SELECT id FROM x nothing", "WITH x AS (SELECT id FROM notes) SELECT input.id FROM x input"]) expect((await compileSql(sql, ctx)).ok, sql).toBe(false);
});

import {schemas} from "../schemas.js";
import {compileProgram} from "../../src/build/core/sql/compile.js";
import {d1Dialect} from "../../src/build/d1/dialect.js";
import {postgresDialect} from "../../src/build/postgres/dialect.js";
for(const engine of ["sqlite","postgres"]) it(`${engine} CTE lowering retains visibility, caller/time binds, DML policy and forged-tag refusal`,async()=>{
 const dialect=engine==="postgres"?pgCompile:undefined, native=engine==="postgres"?postgresDialect():d1Dialect, refs={};
 const compile=async(kind,sql)=>{const r=await compileSql(sql,{schemas,inputs:{},kind,views:refs},dialect);expect(r.ok,JSON.stringify(r)).toBe(true);return r;};
 refs.feed={select:(await compile("view","SELECT id,title FROM posts")).reference};
 refs.inventory={select:(await compile("view","SELECT id,name FROM items")).reference};
 refs.clock={select:(await compile("view","SELECT now() AS instant,auth.uid() AS actor")).reference};
 const lower=(r,kind="view",mode="caller")=>compileProgram(r.plan.stmts,{schemas,dialect:native,inputs:{},kind,mode})[0];
 const pub=lower(await compile("view","SELECT id,title FROM feed ORDER BY id"),"view","public"),pubSql=native.print(pub.ast,schemas);
 expect(pubSql).toContain("published");expect(pubSql).toContain("expires_at");expect(pub.binds.some(bind=>bind.k==="now"||bind.k==="cutoff")).toBe(true);
 const scoped=await compile("view","SELECT i.id FROM inventory i JOIN clock c ON c.actor=auth.uid() AND c.instant=now() ORDER BY i.id"),shown=lower(scoped);
 expect(shown.binds.some(bind=>bind.k==="uid")).toBe(true);expect(shown.binds.some(bind=>bind.k==="now")).toBe(true);expect(native.print(shown.ast,schemas)).toContain("owner");
 for(const sql of ["INSERT INTO settings (key,value) SELECT id,name FROM inventory RETURNING key","UPDATE settings SET value='changed' WHERE key IN (SELECT id FROM inventory) RETURNING key"]){
  const c=lower(await compile("procedure",sql),"procedure");expect(native.print(c.ast,schemas)).toContain("owner");expect(c.binds.some(bind=>bind.k==="uid")).toBe(true);
 }
 const forged=structuredClone(scoped);
 const visit=n=>{if(!n||typeof n!=="object")return;if(n.RangeVar?.mantle==="table")n.RangeVar.mantle="cte";Object.values(n).forEach(visit);};visit(forged.plan.stmts);
 expect(()=>lower(forged)).toThrow(/cte reference is not defined in scope/);
 expect((await compileSql("WITH x AS (SELECT owner FROM items) SELECT owner FROM x",{schemas,inputs:{},kind:"view"},dialect)).ok).toBe(false);
});
