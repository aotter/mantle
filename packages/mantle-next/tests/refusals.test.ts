import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { generateFromSources } from "../src/infrastructure/generate.js";
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

for (const [kind, hint] of [["schedule", "Wire scheduled() yourself."], ["lifecycle", "Write a custom handler."]] as const) {
  test(`${kind} Triggers produce one actionable diagnostic per declaration`, async () => {
    const result = await diagnostics([...(kind === "lifecycle" ? [doc("Procedure", "hook", { input: { type: "object" }, output: { type: "object" }, handler: { ref: "hook" } })] : []), ...["first", "second"].map(name => doc("Trigger", name, {
      source: kind === "schedule" ? { kind, cron: "0 * * * *", enabled: false } : { kind, schema: "notes", on: ["before_create", "after_create"] }, target: { procedure: kind === "lifecycle" ? "hook" : "read" },
    }))]);
    const triggers = result.filter(d => d.path.startsWith("triggers/"));
    expect(triggers).toHaveLength(2);
    expect(triggers.map(d => d.path)).toEqual(["triggers/first", "triggers/second"]);
    for (const d of triggers) { expect(d.code).toBe("GENERATE_UNSUPPORTED"); expect(d.message).toContain(hint); }
  });
}

test("guards are refused on every View and Procedure", async () => {
  const requires = { guard: { procedure: "guard" } };
  const result = await diagnostics([
    doc("Procedure", "guard", { input: { type: "object" }, output: { type: "object" }, handler: { ref: "guard" } }),
    doc("View", "guarded", { surface: "internal", requires, sql: "SELECT id FROM notes" }),
    doc("Procedure", "guarded-procedure", { ...procedure, requires }),
  ]);
  const guards = result.filter(d => d.path.endsWith("/requires/guard"));
  expect(guards.map(d => d.path)).toEqual(["views/guarded/requires/guard", "procedures/guarded-procedure/requires/guard"]);
  for (const d of guards) expect(d.message).toContain("Write a custom handler that checks authorization before executing queries.");
});

test("localized and translates declarations each carry their own path and hint", async () => {
  const result = await diagnostics([doc("Schema", "translations", { ...localized, translates: { parent: "notes", on: "slug" } })]);
  expect(result).toHaveLength(2);
  expect(result.map(d => d.path)).toEqual(["schemas/translations/localized", "schemas/translations/translates"]);
  expect(result[0]!.message).toContain("Manage locales in application-owned fields and handlers.");
  expect(result[1]!.message).toContain("Manage relationships in application-owned fields and handlers.");
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

test("mixed refused declarations are reported together", async () => {
  const result = await diagnostics([
    doc("Trigger", "cron", { source: { kind: "schedule", cron: "0 * * * *" }, target: { procedure: "read" } }),
    doc("Schema", "local", localized),
  ]);
  expect(result.map(d => d.path)).toEqual(["triggers/cron", "schemas/local/localized"]);
  for (const d of result) expect(d.code).toBe("GENERATE_UNSUPPORTED");
});

for (const source of [{ kind: "mcp", surface: "staff" }] as const) {
  test(`${source.kind} exposure is planned and provides an interim handler hint`, async () => {
    const result = await diagnostics([doc("Trigger", "expose", { source, target: { procedure: "read" } })]);
    expect(result).toEqual([{ code: "GENERATE_UNSUPPORTED", path: "triggers/expose", message: `${source.kind.toUpperCase()} Trigger exposure is planned; no handler is generated yet. Mount an application-owned handler until the surface is available.` }]);
  });
}

test("a noncanonical input cast and another refused declaration are reported together", () => {
  const text = [doc("Schema", "local", localized), doc("View", "bad-cast", { surface: "internal", input: { type: "object", properties: { payload: { type: "object" } } }, sql: "SELECT input.payload AS value" })].join("\n---\n");
  // The compiler normally supplies canonical casts. Corrupt one lowering in an isolated process.
  const lowered = new URL("../../mantle/dist/core/sql/lowered.js", import.meta.url).href;
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
  expect(result.diagnostics).toContainEqual({ code: "GENERATE_UNSUPPORTED", path: "schemas/local/localized", message: "Localized entries are unsupported until 0.2.x. Manage locales in application-owned fields and handlers." });
});

test("HTTP Trigger exposure emits its REST handler", async () => {
  const result=await generateFromSources({target:"bun-sqlite",sources:{sources:[{sourceId:"http.yaml",text:[...base,doc("Trigger","expose",{source:{kind:"http",method:"POST",path:"/api/notes"},target:{procedure:"read"}})].join("\n---\n")}]}});
  expect(result.ok).toBe(true);if(result.ok)expect(result.files["rest.ts"]).toContain("/api/notes");
});
