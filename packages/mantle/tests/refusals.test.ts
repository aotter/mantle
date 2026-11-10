import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { generateFromSources } from "../src/infrastructure/generateAuth.js";
import { compilePlan } from "../src/build/compiler.js";
import { wireScalars } from "../src/domain/wireScalars.js";
import { dialect } from "../src/kernel/dialect/sqlite.js";

const doc = (kind: string, name: string, spec: object) => JSON.stringify({ apiVersion: "cms.mantle.aotter.net/v2", kind, metadata: { name }, spec });
const schema = { title: "Notes", lifecycle: "operational", schema: { type: "object", properties: { slug: { type: "string" }, title: { type: "string" } } } };
const localized = { ...schema, localized: true, schema: { ...schema.schema, properties: { ...schema.schema.properties, locale: { type: "string" } } } };
const procedure = { input: { type: "object" }, output: { type: "object" }, handler: { sql: "INSERT INTO notes (title) VALUES ('hello') RETURNING id" } };
const base = [doc("Schema", "notes", schema), doc("Procedure", "read", procedure)];
async function diagnostics(extra: string[]) {
  const result = await generateFromSources({ target: "bun-sqlite", sources: { sources: [{ sourceId: "refused.yaml", text: [...base, ...extra].join("\n---\n") }] } });
  expect(result.ok).toBe(false);
  if (result.ok) throw Error("unsupported declaration generated successfully");
  return result.diagnostics;
}

for (const [kind, source, hint] of [["schedule", "{kind: schedule, cron: '0 * * * *'}", "Schedule Triggers are unsupported. Wire scheduled() yourself."], ["lifecycle", "{kind: lifecycle, schema: notes, on: [after_create]}", "Before/after lifecycle hooks are unsupported. Write a custom handler."]] as const) {
  test(`a ${kind} Trigger fails the manifest with one actionable diagnostic per declaration`, async () => {
    const trigger = (name: string) => `apiVersion: cms.mantle.aotter.net/v2\nkind: Trigger\nmetadata: {name: ${name}}\nspec:\n  source: ${source}\n  target: {procedure: read}`;
    const result = await diagnostics([trigger("first"), trigger("second")]);
    expect(result).toEqual(["[doc 2]", "[doc 3]"].map(doc => ({ code: "INVALID_MANIFEST_ENVELOPE", path: "/spec/source/kind", message: `${doc} Trigger.spec.source.kind '${kind}' is not accepted (one of http, mcp). ${hint}` })));
    const compiled = await compilePlan({ sources: [{ sourceId: "refused.yaml", text: [...base, trigger("first")].join("\n---\n") }] });
    expect(compiled.ok).toBe(false);
    if (!compiled.ok) expect(compiled.diagnostics).toEqual([expect.objectContaining({ path: "/spec/source/kind", source: expect.objectContaining({ sourceId: "refused.yaml", documentIndex: 2, span: expect.objectContaining({ start: expect.objectContaining({ line: 9, column: 18 }) }) }) })]);
  });
}

test("requires.guard fails each View and Procedure that declares it", async () => {
  const requires = { guard: { procedure: "read" } };
  const result = await diagnostics([doc("View", "guarded", { surface: "internal", requires, sql: "SELECT id FROM notes" }), doc("Procedure", "guarded-procedure", { ...procedure, requires })]);
  const hint = "Dynamic authorization guards are unsupported. Write a custom handler that checks authorization before executing queries.";
  expect(result).toEqual([["View", 2], ["Procedure", 3]].map(([kind, index]) => ({ code: "INVALID_MANIFEST_ENVELOPE", path: "/spec/requires/guard", message: `[doc ${index}] ${kind}.spec.requires.guard is not accepted. ${hint}` })));
});

test("each native geo View output is refused with an explicit scalar alternative", async () => {
  const result = await diagnostics([
    doc("Schema", "places", { ...schema, schema: { type: "object", properties: { point: { type: "object", format: "geo" }, other: { type: "object", format: "geo" } } } }),
    doc("View", "places", { surface: "internal", sql: "SELECT point, other FROM places" }),
  ]);
  expect(result).toHaveLength(2);
  expect(result.map(d => d.path)).toEqual(["views/places/columns/point", "views/places/columns/other"]);
  for (const d of result) expect(d.message).toContain("Select the latitude and longitude columns explicitly.");
});

test("geo provenance survives CTEs and subqueries; physical scalar columns remain supported", async () => {
  const places = doc("Schema", "places", { ...schema, schema: { type: "object", properties: { point: { type: "object", format: "geo" } } } });
  const result = await diagnostics([places, doc("View", "nested", { surface: "internal", sql: "WITH c AS (SELECT point AS p FROM places) SELECT q.p AS position FROM (SELECT p FROM c) q" })]);
  expect(result).toEqual([{ code: "GENERATE_UNSUPPORTED", path: "views/nested/columns/position", message: "Native geo projection is unsupported. Select the latitude and longitude columns explicitly." }]);
  const scalar = await generateFromSources({ target: "bun-sqlite", sources: { sources: [{ sourceId: "geo.yaml", text: [places, doc("View", "coordinates", { surface: "internal", sql: "SELECT point_lat, point_lng FROM places" })].join("\n---\n") }] } });
  expect(scalar.ok).toBe(true);
});

test("unmatched date-time SELECT outputs give an actionable expansion hint", () => {
  const ast = { SelectStmt: { targetList: [{ ResTarget: { val: { ColumnRef: { fields: [{ A_Star: {} }] } } } }] } };
  expect(wireScalars(ast, ["created_at"], ["timestamptz"], dialect)).toBe("Declared timestamp and date outputs need one SELECT item per output. Expand the SELECT list explicitly.");
});


test("a noncanonical input cast and another refused declaration are reported together", () => {
  const text = [doc("Schema", "local", localized), doc("View", "bad-cast", { surface: "internal", input: { type: "object", properties: { payload: { type: "object" } } }, sql: "SELECT input.payload AS value" }), doc("Schema", "places", { ...schema, schema: { type: "object", properties: { point: { type: "object", format: "geo" } } } }), doc("View", "places", { surface: "internal", sql: "SELECT point FROM places" })].join("\n---\n");
  // The compiler normally supplies canonical casts. Corrupt one lowering in an isolated process.
  // The source generator imports the compiler from src/build; the published dist bundles it into one module.
  const lowered = new URL("../src/build/core/sql/lowered.ts", import.meta.url).href;
  const script = `import { mock } from "bun:test";
const original = await import(${JSON.stringify(lowered)});
const lowerPlan = original.lowerPlan;
mock.module(${JSON.stringify(lowered)}, () => ({ ...original, lowerPlan(...args) {
  const result = lowerPlan(...args);
  for (const statement of Object.values(result.lowered.views["bad-cast"])) statement.sql = "SELECT $1 AS value";
  return result;
} }));
const { generateFromSources } = await import(${JSON.stringify(new URL("../src/infrastructure/generate.ts", import.meta.url).href)});
console.log(JSON.stringify(await generateFromSources({ target: "bun-postgres", sources: { sources: [{ sourceId: "mixed.yaml", text: ${JSON.stringify(text)} }] } })));`;
  const result = JSON.parse(execFileSync(process.execPath, ["-e", script], { encoding: "utf8" }));
  expect(result.ok).toBe(false);
  expect(result.diagnostics).toContainEqual({ code: "GENERATE_UNSUPPORTED", path: "views/bad-cast", message: "Input $1 must appear only as CAST($1 AS jsonb). Wrap each occurrence in CAST($1 AS jsonb)." });
  expect(result.diagnostics).toContainEqual({ code: "GENERATE_UNSUPPORTED", path: "views/places/columns/point", message: "Native geo projection is unsupported. Select the latitude and longitude columns explicitly." });
}, 30_000);

test("date and timestamp literals that do not exist are refused at generate, as request input is", async () => {
  for (const target of ["bun-sqlite", "bun-postgres"] as const) for (const literal of ["'2026-13-01'::date", "'2026-02-30'::date", "'2026-10-11T24:00:00Z'::timestamptz", "'2026-13-01T00:00:00Z'::timestamptz"]) {
    const result = await generateFromSources({ target, sources: { sources: [{ sourceId: "refused.yaml", text: [...base, doc("View", "dated", { surface: "internal", sql: `SELECT id, ${literal} AS at FROM notes` })].join("\n---\n") }] } });
    expect(result.ok, `${target} ${literal}`).toBe(false);
  }
});
