import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PG_GRAMMAR, compilePlan } from "../compiler.js";
import * as pgCompile from "../../src/build/postgres/compile/index.js";

const fixture = readFileSync(fileURLToPath(new URL("./fixtures/pipeline/valid.yaml", import.meta.url)), "utf8");

const SCHEMA = `apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: { name: notes }
spec:
  title: Notes
  lifecycle: operational
  indexes: [[ownerId]]
  scope: "ownerId = auth.uid()"
  schema:
    type: object
    required: [ownerId]
    properties: { ownerId: { type: string }, body: { type: string } }
`;
const view = (sql: string) => `---
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: { name: v }
spec: { surface: admin, sql: "${sql}", input: { type: object, properties: { q: { type: string } } } }
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

  it("carries a View's cache.sharedMaxAge into the plan", async () => {
    const res = await compile(`${SCHEMA.replace("  lifecycle: operational\n", "").replace('  scope: "ownerId = auth.uid()"\n', "")}---
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: { name: v }
spec: { surface: public, cache: { sharedMaxAge: 60 }, sql: "SELECT body FROM notes" }
`);
    if (!res.ok) throw new Error(JSON.stringify(res.diagnostics));
    expect(res.plan.views["v"]!.sharedMaxAge).toBe(60);
  });

  it.each([undefined, pgCompile])("checks shared caching against expanded IR (%s)", async (dialect) => {
    const schema = (extra = "") => `apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: { name: records }
spec:
  title: Records
  schema: { type: object, properties: { body: { type: string }, expires: { type: string, format: date-time } } }
${extra}`;
    const namedView = (name: string, sql: string, cache = true) => `---
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: { name: ${name} }
spec: { surface: ${cache ? "public" : "internal"}, ${cache ? "cache: { sharedMaxAge: 60 }," : ""} sql: ${JSON.stringify(sql)} }
`;
    const check = (text: string) => compilePlan({ sources: [{ sourceId: "memory:cache", text }] }, dialect);
    for (const [sql, extra] of [
      ["SELECT now() AS at", ""], ["SELECT pg_catalog.now() AS at", ""],
      ["SELECT auth.uid() AS caller", ""],
      ["SELECT body FROM records", "  lifecycle: operational\n"],
      ["SELECT body FROM records", "  ttl: { field: expires, expireAfterSeconds: 0 }\n"],
    ]) {
      const result = await check(schema(extra) + namedView("cached", sql!));
      expect(result.ok, sql).toBe(false);
      if (!result.ok) expect(result.diagnostics.some((d) => d.code === "VIEW_CACHE_INVALID"), JSON.stringify(result.diagnostics)).toBe(true);
    }
    // The parser cannot decide eligibility by matching text inside literals, comments or a CTE name.
    for (const sql of ["SELECT 'now() auth.uid() records' AS label /* now() */", "SELECT body FROM records"])
      expect((await check(schema() + namedView("cached", sql))).ok).toBe(true);
    if (dialect) {
      expect((await check(schema("  lifecycle: operational\n") + namedView("cached", "WITH records AS (SELECT 'fixed' AS body) SELECT body FROM records"))).ok).toBe(true);
      for (const [sql, extra] of [["SELECT now() AS body", ""], ["SELECT body FROM records", "  lifecycle: operational\n"], ["SELECT body FROM records", "  ttl: { field: expires, expireAfterSeconds: 0 }\n"]]) {
        const result = await check(schema(extra) + namedView("inner-source", sql!, false) + namedView("middle-source", "SELECT body FROM inner_source", false) + namedView("cached", "SELECT body FROM middle_source"));
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.diagnostics).toEqual([expect.objectContaining({ code: "VIEW_CACHE_INVALID", source: expect.objectContaining({ path: "/spec/cache" }) })]);
      }
      expect((await check(schema() + namedView("inner-source", "SELECT body FROM records", false) + namedView("cached", "SELECT body FROM inner_source"))).ok).toBe(true);
    }
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
  ] as const)("%s", async (_name, doc, code, pointer?: string, line?: number) => {
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
    const rich = await compilePlan({ sources: [{ sourceId: "m", text: SCHEMA.replace("title: Notes", "title: { en: Notes, zh-TW: 筆記 }\n  description: My notes\n  localized: false\n  uiSchema: { list: { columns: [body] } }") + view("SELECT id FROM notes").replace("surface: admin,", "surface: admin, title: Mine, description: Mine only, uiSchema: { list: { columns: [id] } },") }] });
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
    const withList = (list: string) => SCHEMA + view("SELECT id, body AS text FROM notes ORDER BY id").replace("surface: admin,", `surface: admin, uiSchema: { list: { ${list} } },`);
    expect((await compile(withList("searchFields: [text], filterFields: [ID]"))).ok).toBe(true);
    const bad = await compile(withList("searchFields: [body], filterFields: [ownerId]"));
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.diagnostics.map((d) => [d.code, d.value])).toEqual([["VIEW_UI_INVALID", "body"], ["VIEW_UI_INVALID", "ownerId"]]);
  });

  it("refuses uiSchema.list.cells: components are defineAdmin's, not the manifest's", async () => {
    const withCells = (cells: string) => SCHEMA + view("SELECT id, body AS text FROM notes ORDER BY id").replace("surface: admin,", `surface: admin, uiSchema: { list: { cells: { ${cells} } } },`);
    const bad = await compile(withCells("text: kit/preview"));
    expect(!bad.ok && bad.diagnostics.map((d) => [d.code, d.path.endsWith("/spec/uiSchema/list/cells")])).toEqual([["VIEW_UI_INVALID", true]]);
  });

});

describe("a field with more than one JSON Schema type", () => {
  const doc = (kind: string, name: string, spec: string) => `apiVersion: cms.mantle.aotter.net/v2\nkind: ${kind}\nmetadata: { name: ${name} }\nspec:\n${spec}\n`;
  const things = (checks = "") => doc("Schema", "things", `  title: Things\n  lifecycle: operational\n  schema:\n    type: object\n    properties: { qty: { type: [integer, number] }, mixed: { type: [integer, string] }, tags: { type: array } }\n${checks}`);
  const labels = doc("Schema", "labels", "  title: Labels\n  lifecycle: operational\n  schema:\n    type: object\n    properties: { mixed: { type: string }, value: { type: object } }");
  const view = (sql: string) => `---\n${doc("View", "v", `  surface: admin\n  sql: "${sql}"`)}`;
  const compile = async (text: string, dialect?: typeof pgCompile) => {
    const r = await compilePlan({ sources: [{ sourceId: "memory:union", text }] }, ...(dialect ? [dialect] : []));
    return r.ok ? "ok" : r.diagnostics.map((d) => d.message).join(" ");
  };
  it("is one number when its types are integer and number, and json otherwise", async () => {
    const r = await compilePlan({ sources: [{ sourceId: "memory:union", text: things() }] });
    expect(r.ok && r.plan.schemas.things?.fields).toMatchObject({ qty: "real", mixed: "json" });
  });
  it("is refused in a comparison or a check when json, on every dialect: SQLite compares its text, PostgreSQL has no jsonb < integer", async () => {
    for (const dialect of [undefined, pgCompile]) {
      for (const text of [things(`  checks: ["mixed < 5"]`), `${things()}---\n${labels}${view("SELECT t.id FROM things t JOIN labels l ON l.id = t.id WHERE t.mixed > 3")}`])
        expect(await compile(text, dialect)).toMatch(/mixed is json: compare a value read with ->>/);
      // not refused: a numeric union, another relation's field of the same name, a subquery's output, a row source's value (json_each on D1, jsonb_array_elements_text on PostgreSQL), IS NULL
      for (const sql of ["SELECT id FROM things WHERE qty < 5", "SELECT l.id FROM labels l WHERE l.mixed = 'x'", "SELECT s.mixed FROM (SELECT CAST(t.qty AS text) AS mixed FROM things t) s WHERE s.mixed = 'x'", "SELECT t.id FROM things t, " + (dialect ? "jsonb_array_elements_text(t.tags) AS j(value)" : "json_each(t.tags)") + " WHERE value = 'x'", "SELECT id FROM things WHERE mixed IS NULL"])
        expect(await compile(`${things()}---\n${labels}${view(sql)}`, dialect), `${dialect ? "pg" : "d1"}: ${sql}`).toBe("ok");
    }
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

describe("Schema.spec.lock (#1822)", () => {
  const LIVE = "EXISTS (SELECT 1 FROM posts p WHERE p.current_revision = post_revisions.id)";
  const lockSchemas = (when = LIVE, postsIndexes = "[[current_revision]]", lock?: string) => `apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: { name: posts }
spec:
  title: Posts
  lifecycle: operational
  indexes: ${postsIndexes}
  schema: { type: object, properties: { title: { type: string }, current_revision: { type: string } } }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: { name: post_revisions }
spec:
  title: Revisions
  lifecycle: operational
  lock: ${lock ?? JSON.stringify([{ name: "live_revision", on: ["update", "delete"], when, message: "This revision is live." }])}
  schema: { type: object, properties: { body: { type: string }, state: { type: string } } }
`;
  const result = async (text: string, dialect?: typeof pgCompile) => { const r = await compilePlan({ sources: [{ sourceId: "memory:lock", text }] }, dialect); return r.ok ? r : { ok: false as const, found: r.diagnostics.map((d) => `${d.code}: ${d.message}`) }; };

  it.each([undefined, pgCompile])("compiles when into the plan as IR whose subqueries read stored rows (%s)", async (dialect) => {
    const r = await result(lockSchemas(), dialect);
    if (!r.ok) throw new Error(r.found.join("\n"));
    const [lock] = r.plan.schemas.post_revisions!.locks!;
    expect(lock).toMatchObject({ name: "live_revision", on: ["update", "delete"], message: "This revision is live.", when: { SubLink: { subLinkType: "EXISTS_SUBLINK" } } });
    expect(JSON.stringify(lock!.when)).toContain('"mantle":"system"');
    expect(r.plan.schemas.posts!.locks).toBeUndefined();
  });

  it("refuses a malformed lock entry with SCHEMA_LOCK_INVALID", async () => {
    const entry = (patch: object) => JSON.stringify([{ name: "live", on: ["update"], when: "state = 'x'", message: "m", ...patch }]);
    for (const [lock, why] of [
      ["[]", /non-empty list/], [entry({ name: "has space" }), /name must be an identifier/],
      [entry({ on: [] }), /on must be a non-empty list/], [entry({ on: ["create"] }), /on must be/], [entry({ on: ["update", "update"] }), /distinct/],
      [entry({ when: 1 }), /when must be a non-empty string/], [entry({ message: "" }), /message must be a non-empty string/], [entry({ extra: 1 }), /is not supported/],
      [JSON.stringify([{ name: "live", on: ["update"], when: "true", message: "m" }, { name: "Live", on: ["delete"], when: "true", message: "m" }]), /declared twice/],
    ] as const) {
      const r = await result(lockSchemas(undefined, undefined, lock));
      expect(r.ok ? [] : r.found, lock).toEqual([expect.stringMatching(why)]);
      if (!r.ok && !/is not supported/.test(String(why))) expect(r.found[0]).toMatch(/^SCHEMA_LOCK_INVALID/);
    }
  });

  it("refuses SQL outside the lock subset", async () => {
    for (const [when, why] of [
      ["EXISTS (SELECT 1 FROM posts p WHERE p.current_revision = id)", /qualify every column: 'id'/],
      ["EXISTS (SELECT 1 FROM posts WHERE current_revision = post_revisions.id)", /qualify every column/],
      ["EXISTS (SELECT 1 FROM post_revisions WHERE post_revisions.state = 'x')", /hides a name already in scope/],
      ["state = auth.uid()", /calls no function/], ["state = now()", /calls no function/], ["state = input.x", /input.x is not a declared input/],
      ["(SELECT count(*) FROM posts p) > 0", /SubLink is refused/], ["EXISTS (SELECT count(*) FROM posts p WHERE p.id = post_revisions.id)", /calls no function/],
      ["EXISTS (SELECT 1 FROM posts p JOIN posts q ON q.id = p.id WHERE p.current_revision = post_revisions.id)", /no join/],
      ["EXISTS (SELECT 1 FROM posts p WHERE p.current_revision = post_revisions.id LIMIT 1)", /LIMIT/],
      ["missing = 'x'", /SQL_COLUMN|not a column/], ["EXISTS (SELECT 1 FROM nope n WHERE n.id = post_revisions.id)", /nope is not a declared Schema/],
      ["state || 'x' = 'y'", /is refused/],
    ] as const) {
      const r = await result(lockSchemas(when));
      expect(r.ok ? [] : r.found, when).toEqual([expect.stringMatching(why)]);
    }
    // the subset: columns, comparisons, IN, AND/OR/NOT, IS [NOT] NULL, [NOT] EXISTS, nested EXISTS
    for (const when of ["state = 'live' OR state IS NULL", "state IN ('a', 'b') AND NOT state <> 'c'", `NOT ${LIVE}`, "EXISTS (SELECT 1 FROM posts p WHERE p.current_revision = post_revisions.id AND EXISTS (SELECT 1 FROM post_revisions r2 WHERE r2.id = p.id))"])
      expect((await result(lockSchemas(when))).ok, when).toBe(true);
  });

  it("proves each EXISTS is index-served, naming the index to declare", async () => {
    const r = await result(lockSchemas(LIVE, "[]"));
    expect(r.ok ? [] : r.found).toEqual(["LOCK_INDEX_MISSING: Schema 'post_revisions' lock 'live_revision': no index serves its EXISTS on 'posts', which every guarded write runs. Declare indexes: [[current_revision]] on Schema 'posts' (handbook: reference/schema.md#locks)."]);
    expect((await result(lockSchemas(LIVE))).ok).toBe(true);
    // a unique index or id serves it too; a literal equality counts; an index whose first column is not equated does not
    expect((await result(lockSchemas(LIVE, "[]").replace("  indexes: []\n", "  indexes: []\n  uniqueIndexes: [[current_revision]]\n"))).ok).toBe(true);
    expect((await result(lockSchemas("EXISTS (SELECT 1 FROM posts p WHERE p.id = post_revisions.body)", "[]"))).ok).toBe(true);
    expect((await result(lockSchemas("EXISTS (SELECT 1 FROM posts p WHERE p.title = 'x' AND p.current_revision = post_revisions.id)", "[[title, current_revision]]"))).ok).toBe(true);
    expect((await result(lockSchemas("EXISTS (SELECT 1 FROM posts p WHERE p.current_revision = post_revisions.id)", "[[title, current_revision]]"))).ok).toBe(false);
    const none = await result(lockSchemas("EXISTS (SELECT 1 FROM posts p WHERE p.current_revision > post_revisions.id)", "[]"));
    expect(none.ok ? [] : none.found).toEqual([expect.stringMatching(/^LOCK_INDEX_MISSING: .*Correlate the subquery to the locked row by an equality/)]);
  });
});
