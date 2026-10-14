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
