import { expect, it } from "vitest";
import { parseManifests } from "./parse.js";

const doc = (kind: string, title: unknown, description?: unknown) => JSON.stringify({
  apiVersion: "cms.mantle.aotter.net/v2", kind, metadata: { name: kind.toLowerCase() },
  spec: {
    ...(title === undefined ? {} : { title }), ...(description === undefined ? {} : { description }),
    ...(kind === "Schema" ? { schema: { type: "object" } }
      : kind === "View" ? { surface: "public", sql: "SELECT 1 AS value" }
      : { input: { type: "object" }, output: { type: "object" }, handler: { ref: "run" } }),
  },
});

it("every manifest metadata slot accepts text or a locale map; only Schema title is required", () => {
  for (const kind of ["Schema", "Procedure", "View"]) {
    expect(parseManifests(doc(kind, "Title", { en: "Description", "zh-TW": "說明" })).diagnostics).toEqual([]);
    expect(parseManifests(doc(kind, { en: "Title" }, "Description")).diagnostics).toEqual([]);
    expect(parseManifests(doc(kind, undefined)).diagnostics.length).toBe(kind === "Schema" ? 1 : 0);
  }
});

// One representative per invalid LocalizedText shape, rather than a kind × field × value product.
it.each(["", {}, { en: "Title", "zh-TW": 42 }, ["Title"], 42])("refuses malformed localized text %j", value => {
  expect(parseManifests(doc("Schema", value)).diagnostics[0]?.path).toContain("/spec/title");
});

it("all title and description slots use the same localized-text check", () => {
  const result = parseManifests(["Schema", "Procedure", "View"].flatMap(kind => [doc(kind, 42), doc(kind, "Title", 42)]).join("\n---\n"));
  expect(result.diagnostics.map(d => d.path?.split("#")[1])).toEqual([
    "/spec/title", "/spec/description", "/spec/title", "/spec/description", "/spec/title", "/spec/description",
  ]);
});

it("a Schema property's title and description may be localized", () => {
  const source = JSON.parse(doc("Schema", "Posts"));
  source.spec.schema.properties = { name: { type: "string", title: "Name", description: { en: "Name", "zh-TW": "名稱" } } };
  expect(parseManifests(JSON.stringify(source)).diagnostics).toEqual([]);
});
