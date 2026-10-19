import { test, expect } from "bun:test";
import { generateFromSources } from "../src/infrastructure/generate.js";

const doc = (kind: string, name: string, spec: object) => JSON.stringify({ apiVersion: "cms.mantle.aotter.net/v2", kind, metadata: { name }, spec });
const schema = (name: string, extra: object = {}) => doc("Schema", name, { title: name, lifecycle: "operational", schema: { type: "object", required: ["title"], properties: { title: { type: "string" } } }, ...extra });
const warnings = async (...docs: string[]) => {
  const result = await generateFromSources({ target: "bun-sqlite", admin: true, sources: { sources: [{ sourceId: "app.yaml", text: docs.join("\n---\n") }] } });
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return (result.warnings ?? []).filter(w => w.includes("no Procedure places a create action"));
};

test("Admin create gaps are named for writable operational Schemas only", async () => {
  expect(await warnings(schema("events"))).toEqual([expect.stringContaining("Schema 'events'")]);
  expect(await warnings(schema("events", { uiSchema: {} }), doc("Procedure", "create-event", { title: "New", requires: { auth: { all: ["ctx.admin"] } }, uiSchema: { collectionAction: "events" },
    input: { type: "object", required: ["title"], additionalProperties: false, properties: { title: { type: "string" } } }, output: { type: "object" },
    handler: { sql: "INSERT INTO events (title) VALUES (input.title) RETURNING id" } }), doc("Trigger", "create-event-admin", { source: { kind: "mcp", surface: "admin" }, target: { procedure: "create-event" } }))).toEqual([]);
  const readOnly = doc("Schema", "log", { title: "log", lifecycle: "operational", schema: { type: "object", readOnly: true, required: ["title"], properties: { title: { type: "string" } } } });
  expect(await warnings(readOnly)).toEqual([]);
});

test("a required readOnly field without a default warns only when Admin's generic create would need it", async () => {
  const all = async (...docs: string[]) => {
    const result = await generateFromSources({ target: "bun-sqlite", admin: true, sources: { sources: [{ sourceId: "app.yaml", text: docs.join("\n---\n") }] } });
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
    return result.warnings ?? [];
  };
  const deals = doc("Schema", "deals", { title: "deals", lifecycle: "operational", schema: { type: "object", required: ["title", "stage"], properties: { title: { type: "string" }, stage: { type: "string", readOnly: true } } } });
  const field = (w: readonly string[]) => w.filter(x => x.includes("field 'stage'"));
  expect(field(await all(deals))).toEqual([expect.stringContaining("Admin's generic create cannot fill it")]);
  // A create action's Procedure writes the field itself (the CRM evaluator's case).
  expect(field(await all(deals, doc("Procedure", "open-deal", { title: "Open", requires: { auth: { all: ["ctx.admin"] } }, uiSchema: { collectionAction: "deals" },
    input: { type: "object", required: ["title"], additionalProperties: false, properties: { title: { type: "string" } } }, output: { type: "object" },
    handler: { sql: "INSERT INTO deals (title, stage) VALUES (input.title, 'lead') RETURNING id" } }), doc("Trigger", "open-deal-admin", { source: { kind: "mcp", surface: "admin" }, target: { procedure: "open-deal" } })))).toEqual([]);
});

test("a child folded through the object form of x-mantle-ref is not reported as uncreatable", async () => {
  const parent = doc("Schema", "orders", { title: "orders", lifecycle: "operational", uniqueIndexes: [["ref"]], schema: { type: "object", readOnly: true, required: ["ref"], properties: { ref: { type: "string" } } } });
  const child = doc("Schema", "lines", { title: "lines", lifecycle: "operational", schema: { type: "object", required: ["orderRef"], properties: { orderRef: { type: "string", "x-mantle-ref": { schema: "orders", field: "ref" } } } } });
  expect(await warnings(parent, child)).toEqual([]);
});

test("a field-scoped Schema's create gap tells the author to take the partition as an optional input", async () => {
  const scoped = doc("Schema", "leads", { title: "leads", lifecycle: "operational", scope: "region IN auth.user('region')", indexes: [["region", "id"]], schema: { type: "object", required: ["region", "title"], properties: { region: { type: "string" }, title: { type: "string" } } } });
  expect(await warnings(scoped)).toEqual([expect.stringContaining("takes 'region' as an optional input")]);
});
