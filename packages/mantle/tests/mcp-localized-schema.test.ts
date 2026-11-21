/** Localized `title` and `description` keywords in a tool's schemas are listed over MCP as the server locale's string (#2046). */
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/client/validators/ajv";
import { generateOrThrow, writeGenerated } from "./apps/link.js";
import { localizedSchema } from "../src/kernel/localized-schema.js";
import { compilePlan, d1Dialect } from "../src/build/compiler.js";
import { describeApp } from "../src/domain/describe/index.js";
import { mcpClient } from "./mcp-client.js";

const label = (en: string, zh: string) => `{en: "${en}", "zh-TW": "${zh}"}`;
const source = `apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: {name: companies}
spec:
  title: Companies
  lifecycle: operational
  schema: {type: object, properties: {name: {type: string}, stage: {type: string}}, required: [name, stage]}
---
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: {name: companies-by-status}
spec:
  surface: public
  input:
    type: object
    properties:
      status: {type: string, title: ${label("Status", "狀態")}, description: ${label("Which status", "哪個狀態")}, enum: [open, closed], default: open}
  sql: SELECT id, name FROM companies WHERE stage = input.status ORDER BY id
---
apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: {name: create-company}
spec:
  description: Create a company
  input:
    type: object
    title: ${label("Company", "公司")}
    additionalProperties: false
    required: [name, title, status]
    properties:
      name: {type: string, title: ${label("Name", "名稱")}, description: ${label("Legal name", "法定名稱")}}
      title: {type: string, title: ${label("Job title", "職稱")}}
      status:
        type: string
        title: ${label("Status", "狀態")}
        default: open
        enum: [open, closed]
      address:
        type: object
        description: ${label("Where", "地址")}
        properties:
          city: {type: string, title: ${label("City", "城市")}}
      tags:
        type: array
        items: {type: string, title: ${label("Tag", "標籤")}, enum: [a, b]}
  output: {type: object}
  handler: {sql: 'INSERT INTO companies(name, stage) VALUES(input.name, input.status) RETURNING id'}
---
apiVersion: cms.mantle.aotter.net/v2
kind: Trigger
metadata: {name: create-company-mcp}
spec: {source: {kind: mcp, surface: public}, target: {procedure: create-company}}
`;

type Schema = Record<string, unknown>;
/** Every `title`/`description` keyword of a schema that is not a string, by path; a property's name is not a keyword. */
const nonStringLabels = (schema: unknown, at = "#"): string[] => {
  if (!schema || typeof schema !== "object") return [];
  if (Array.isArray(schema)) return schema.flatMap((item, i) => nonStringLabels(item, `${at}/${i}`));
  return Object.entries(schema as Schema).flatMap(([key, value]) => {
    if (["enum", "const", "default", "examples"].includes(key)) return [];
    if ((key === "title" || key === "description") && typeof value !== "string") return [`${at}/${key}`];
    if (["properties", "$defs", "definitions", "patternProperties"].includes(key) && value && typeof value === "object")
      return Object.entries(value as Schema).flatMap(([name, child]) => nonStringLabels(child, `${at}/${key}/${name}`));
    return nonStringLabels(value, `${at}/${key}`);
  });
};
// The SDK bundles Ajv for draft 2020-12; its engine also checks a schema against the meta-schema. The SDK is pinned
// exactly, so a rename of the private `ajv` getter fails here loudly rather than passing vacuously.
const Ajv2020 = (Reflect.get(new AjvJsonSchemaValidator(), "ajv") as object).constructor as new (
  options: object,
) => {
  validateSchema(schema: unknown): boolean;
  errors: unknown;
};
const draft2020 = new Ajv2020({ strict: false });

test("tools/list resolves localized schema labels to the server locale at every depth", async () => {
  const files = await generateOrThrow("bun-sqlite", [{ sourceId: "companies.yaml", text: source }]);
  // The generated table keeps the maps; the kernel resolves them when it lists.
  expect(files["mcp.ts"]).toContain('"zh-TW":"名稱"');
  const dir = await mkdtemp(resolve(import.meta.dir, ".mcp-localized-")),
    db = new Database(":memory:");
  try {
    await writeGenerated(dir, files);
    db.exec(files["schema.sql"]!);
    const { mcp, tools } = await import(resolve(dir, "mcp.ts"));
    // Generated input validation refuses `oneOf`; a hand-written tool beside them carries one, and an output schema.
    const report = {
      name: "company_report",
      surface: "public",
      description: "Report",
      inputSchema: {
        type: "object",
        properties: {
          status: {
            type: "string",
            oneOf: [
              { const: "open", title: { en: "Open", "zh-TW": "營業中" } },
              { const: "closed", title: { "zh-TW": "已歇業" } },
            ],
          },
        },
      },
      outputSchema: {
        type: "object",
        properties: { total: { type: "integer", title: { en: "Total", "zh-TW": "總數" } } },
        $defs: { row: { type: "object", description: { fr: "Ligne" } } },
      },
      validate: (raw: unknown) => raw as Record<string, unknown>,
      run: async () => ({ total: 0 }),
    };
    const list = async (locale?: string) => {
      const handle = mcp({ db: () => db, caller: () => ({ kind: "anonymous" }), ...(locale ? { locale } : {}) });
      const { mcp: serve } = await import("../src/kernel/mcp.js");
      const extra = serve([report as never], { db: () => db, caller: () => ({ kind: "anonymous" }), locale });
      const listed = [];
      for (const fetchFrom of [handle, extra]) {
        const client = await mcpClient(fetchFrom);
        listed.push(...(await client.listTools()).tools);
        await client.close();
      }
      return Object.fromEntries(listed.map(tool => [tool.name, tool]));
    };
    for (const [locale, zh] of [
      ["zh-TW", true],
      ["ja", false],
      [undefined, false],
    ] as const) {
      const listed = await list(locale);
      expect(Object.keys(listed).sort()).toEqual(["companies_by_status", "company_report", "create_company"]);
      for (const tool of Object.values(listed)) {
        for (const schema of [tool.inputSchema, tool.outputSchema].filter(Boolean)) {
          expect(nonStringLabels(schema)).toEqual([]);
          expect([tool.name, draft2020.validateSchema(schema), draft2020.errors]).toEqual([tool.name, true, null]);
        }
      }
      const input = listed.create_company!.inputSchema as Schema & { properties: Record<string, Schema> };
      const pick = (en: string, other: string) => (zh ? other : en);
      expect(input.title).toBe(pick("Company", "公司"));
      expect(input.properties.name).toEqual({
        type: "string",
        title: pick("Name", "名稱"),
        description: pick("Legal name", "法定名稱"),
      });
      // A property named `title` is a schema, not a label.
      expect(input.properties.title).toEqual({ type: "string", title: pick("Job title", "職稱") });
      expect(input.required).toEqual(["name", "title", "status"]);
      expect(input.properties.status).toEqual({
        type: "string",
        title: pick("Status", "狀態"),
        default: "open",
        enum: ["open", "closed"],
      });
      expect(input.properties.address).toMatchObject({
        description: pick("Where", "地址"),
        properties: { city: { type: "string", title: pick("City", "城市") } },
      });
      expect(input.properties.tags).toMatchObject({
        items: { type: "string", title: pick("Tag", "標籤"), enum: ["a", "b"] },
      });
      // The View's paging wrapper keeps its own properties and resolves the View's.
      const view = listed.companies_by_status!.inputSchema as Schema & { properties: Record<string, Schema> };
      expect(view.properties).toEqual({
        status: {
          type: "string",
          title: pick("Status", "狀態"),
          description: pick("Which status", "哪個狀態"),
          enum: ["open", "closed"],
          default: "open",
        },
        limit: { type: "integer", minimum: 1, maximum: 500 },
        cursor: { type: "string" },
      });
      // No `en`: the first value given.
      expect(listed.company_report!.inputSchema).toEqual({
        type: "object",
        properties: {
          status: {
            type: "string",
            oneOf: [
              { const: "open", title: pick("Open", "營業中") },
              { const: "closed", title: "已歇業" },
            ],
          },
        },
      });
      expect(listed.company_report!.outputSchema).toEqual({
        type: "object",
        properties: { total: { type: "integer", title: pick("Total", "總數") } },
        $defs: { row: { type: "object", description: "Ligne" } },
      });
    }
    // A failed call repeats the input contract as listed: labels resolved, not maps.
    const handle = mcp({ db: () => db, caller: () => ({ kind: "anonymous" }), locale: "zh-TW" });
    const client = await mcpClient(handle);
    const failed = await client.callTool({ name: "create_company", arguments: { name: "Acme" } });
    await client.close();
    expect(failed.isError).toBe(true);
    const about = (failed.content as { text: string }[])
      .map(block => block.text)
      .find(text => text.includes("input schema "))!;
    const contract = JSON.parse(about.slice(about.indexOf("input schema ") + "input schema ".length)) as Schema & {
      properties: Record<string, Schema>;
    };
    expect(nonStringLabels(contract)).toEqual([]);
    expect(contract.title).toBe("公司");
    expect(contract.properties.name).toEqual({ type: "string", title: "名稱", description: "法定名稱" });
    expect(contract.properties.title).toEqual({ type: "string", title: "職稱" });
    // Listing copies: the generated table still holds the maps Admin reads.
    const generated = tools.find((tool: { name: string }) => tool.name === "create_company");
    expect(generated.inputSchema.properties.name.title).toEqual({ en: "Name", "zh-TW": "名稱" });
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("describe lists target schemas with English labels; targetHash still hashes the declared maps", async () => {
  const plan = async (text: string) => {
    const result = await compilePlan({ sources: [{ sourceId: "companies.yaml", text }] }, d1Dialect, "operational");
    if (!result.ok) throw Error(JSON.stringify(result.diagnostics));
    return result.plan;
  };
  const declared = await plan(source),
    report = await describeApp(declared);
  const schemas = report.targets.flatMap(t => [t.inputSchema, ...t._meta.variants.map(v => v.inputSchema)]);
  expect(schemas.length).toBeGreaterThan(2);
  for (const schema of schemas) {
    expect(nonStringLabels(schema)).toEqual([]);
    expect([draft2020.validateSchema(schema), draft2020.errors]).toEqual([true, null]);
  }
  const procedure = report.targets.find(t => t._meta.id === "procedure:create-company")!,
    input = procedure.inputSchema as Schema & { properties: Record<string, Schema> };
  expect(input.title).toBe("Company");
  expect(input.properties.name).toEqual({ type: "string", title: "Name", description: "Legal name" });
  // A property named `title` is a schema, not a label.
  expect(input.properties.title).toEqual({ type: "string", title: "Job title" });
  expect(input.properties.address).toMatchObject({ description: "Where", properties: { city: { title: "City" } } });
  expect(input.properties.tags).toMatchObject({ items: { title: "Tag", enum: ["a", "b"] } });
  expect(report.targets.find(t => t._meta.id === "view:companies-by-status")!.inputSchema).toMatchObject({
    properties: { status: { title: "Status", description: "Which status", enum: ["open", "closed"], default: "open" } },
  });
  // The hash is the definition's: stable for the same plan, and it still sees a label in another locale.
  expect((await describeApp(declared)).targets.map(t => t._meta.targetHash)).toEqual(
    report.targets.map(t => t._meta.targetHash),
  );
  const relabelled = await describeApp(await plan(source.replace('"zh-TW": "名稱"', '"zh-TW": "公司名稱"')));
  const again = relabelled.targets.find(t => t._meta.id === "procedure:create-company")!;
  expect(again.inputSchema).toEqual(procedure.inputSchema);
  expect(again._meta.targetHash).not.toBe(procedure._meta.targetHash);
});

test("localizedSchema rewrites only label keywords of schemas, at every subschema keyword", () => {
  const zh = (en: string) => ({ en, "zh-TW": `${en}-zh` });
  const schema = {
    title: zh("root"),
    description: "plain",
    type: "object",
    properties: {
      title: { type: "object", properties: { description: { type: "string", description: zh("d") } } },
      choice: { anyOf: [{ title: zh("a") }, true], allOf: [{ description: zh("b") }], not: { title: zh("c") } },
      tuple: { prefixItems: [{ title: zh("p") }], items: [{ title: zh("old-items") }] },
      rule: { if: { title: zh("if") }, then: { title: zh("then") }, else: { title: zh("else") } },
      data: {
        const: { title: zh("x") },
        enum: [{ title: zh("y") }],
        default: { description: zh("z") },
        examples: [zh("e")],
      },
      empty: { title: {} },
      legacy: {
        dependencies: { foo: { properties: { bar: { title: zh("bar") } } }, baz: ["foo"] },
        additionalItems: { title: zh("ai") },
      },
      notText: { title: { en: 5 }, description: { "zh-TW": null } },
    },
    patternProperties: { "^x-": { title: zh("pattern") } },
    additionalProperties: { description: zh("extra") },
    propertyNames: { title: zh("names") },
    dependentSchemas: { a: { title: zh("dep") } },
    definitions: { legacy: { title: zh("legacy") } },
    $defs: { node: { title: zh("node"), unevaluatedProperties: { title: zh("ue") }, contains: { title: zh("has") } } },
  };
  const before = structuredClone(schema);
  // biome-ignore lint/suspicious/noExplicitAny: the resolved copy has strings where the input has maps.
  const out = localizedSchema(schema, "zh-TW") as any;
  expect(schema).toEqual(before);
  expect(nonStringLabels(out)).toEqual([]);
  expect(out.title).toBe("root-zh");
  expect(out.description).toBe("plain");
  expect(out.properties.title).toEqual({
    type: "object",
    properties: { description: { type: "string", description: "d-zh" } },
  });
  expect(out.properties.choice).toEqual({
    anyOf: [{ title: "a-zh" }, true],
    allOf: [{ description: "b-zh" }],
    not: { title: "c-zh" },
  });
  expect(out.properties.tuple).toEqual({ prefixItems: [{ title: "p-zh" }], items: [{ title: "old-items-zh" }] });
  expect(out.properties.rule).toEqual({
    if: { title: "if-zh" },
    then: { title: "then-zh" },
    else: { title: "else-zh" },
  });
  expect(out.properties.data).toEqual(before.properties.data);
  expect(out.properties.empty).toEqual({});
  // A label that resolves to no string is dropped, never emitted.
  expect(out.properties.notText).toEqual({});
  expect(out.properties.legacy).toEqual({
    dependencies: { foo: { properties: { bar: { title: "bar-zh" } } }, baz: ["foo"] },
    additionalItems: { title: "ai-zh" },
  });
  expect(out.patternProperties["^x-"]).toEqual({ title: "pattern-zh" });
  expect(out.additionalProperties).toEqual({ description: "extra-zh" });
  expect(out.propertyNames).toEqual({ title: "names-zh" });
  expect(out.dependentSchemas.a).toEqual({ title: "dep-zh" });
  expect(out.definitions.legacy).toEqual({ title: "legacy-zh" });
  expect(out.$defs.node).toEqual({
    title: "node-zh",
    unevaluatedProperties: { title: "ue-zh" },
    contains: { title: "has-zh" },
  });
  expect(localizedSchema(schema, "fr")).toMatchObject({ title: "root" });
  for (const value of [undefined, true, false, "x", null]) expect(localizedSchema(value, "en")).toBe(value);
});
