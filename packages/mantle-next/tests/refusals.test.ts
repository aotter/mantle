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

test("localized and translates declarations generate native helpers", async () => {
 const result=await generateFromSources({target:"bun-sqlite",sources:{sources:[{sourceId:"localized.yaml",text:[...base,doc("Schema","translations",{...localized,translates:{parent:"notes",on:"slug"}})].join("\n---\n")}]}});
 expect(result.ok).toBe(true);if(result.ok)expect(result.files["translations.ts"]).toContain("translationLocales");
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
    doc("Trigger", "timer", { source: { kind: "schedule", cron: "0 * * * *" }, target: { procedure: "read" } }),
  ]);
  expect(result.map(d => d.path)).toEqual(["triggers/cron", "triggers/timer"]);
  for (const d of result) expect(d.code).toBe("GENERATE_UNSUPPORTED");
});


test("a noncanonical input cast and another refused declaration are reported together", () => {
  const text = [doc("Schema", "local", localized), doc("View", "bad-cast", { surface: "internal", requires:{guard:{procedure:"guard"}}, input: { type: "object", properties: { payload: { type: "object" } } }, sql: "SELECT input.payload AS value" }), doc("Procedure","guard",{input:{type:"object"},output:{type:"object"},handler:{ref:"guard"}})].join("\n---\n");
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
  expect(result.diagnostics).toContainEqual({ code: "GENERATE_UNSUPPORTED", path: "views/bad-cast/requires/guard", message: "Dynamic authorization guards are unsupported. Write a custom handler that checks authorization before executing queries." });
});

test("HTTP Trigger exposure emits its REST handler", async () => {
  const result=await generateFromSources({target:"bun-sqlite",sources:{sources:[{sourceId:"http.yaml",text:[...base,doc("Trigger","expose",{source:{kind:"http",method:"POST",path:"/api/notes"},target:{procedure:"read"}})].join("\n---\n")}]}});
  expect(result.ok).toBe(true);if(result.ok)expect(result.files["rest.ts"]).toContain("/api/notes");
});

test("Next refuses legacy staff roles on every auth predicate with a migration hint",async()=>{
 const result = await diagnostics([
  doc("View","old-view",{surface:"staff",sql:"SELECT id FROM notes",requires:{auth:{all:[{"ctx.staff":["owner","editor"]}]}}}),
  doc("Procedure","old-procedure",{...procedure,requires:{auth:{all:["ctx.user",{"ctx.staff":["contributor"]}]}}}),
 ]);
 const roles=result.filter(d=>d.path.endsWith("/ctx.staff"));
 expect(roles).toHaveLength(3);
 for(const diagnostic of roles){expect(diagnostic.code).toBe("GENERATE_UNSUPPORTED");expect(diagnostic.message).toContain("generated vocabulary (staff)");expect(diagnostic.message).toContain("Migrate 0.2");}
 const valid=await generateFromSources({target:"bun-sqlite",sources:{sources:[{sourceId:"staff.yaml",text:[...base,doc("View","staff-view",{surface:"staff",sql:"SELECT id FROM notes ORDER BY id",requires:{auth:{all:[{"ctx.staff":["staff"]}]}}})].join("\n---\n")}]}});
 expect(valid.ok).toBe(true);
});
