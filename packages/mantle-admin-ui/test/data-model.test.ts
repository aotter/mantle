import { describe, expect, it } from "vitest";
import { connectedComponents, layoutComponents } from "../src/features/logic/atom-graph";
import { flattenSchemaFields, schemaFieldMarkers } from "../src/features/logic/data-model-view";
import type { DeveloperConsoleSnapshot, DeveloperSchemaModel } from "../src/lib/types";

describe("flattenSchemaFields", () => {
  it("keeps nested paths, required flags, and exact constraints", () => {
    expect(flattenSchemaFields({
      type: "object",
      required: ["status", "items"],
      properties: {
        status: { type: "string", enum: ["draft", "paid"] },
        items: {
          type: "array",
          items: {
            type: "object",
            required: ["productSlug"],
            properties: {
              productSlug: { type: "string", "x-mantle-ref": "products.slug" },
            },
          },
        },
      },
    })).toEqual([
      { path: "status", pointer: "/spec/schema/properties/status", type: "string", required: true, constraints: ["enum: draft | paid"], reference: null },
      { path: "items", pointer: "/spec/schema/properties/items", type: "array", required: true, constraints: [], reference: null },
      { path: "items[].productSlug", pointer: "/spec/schema/properties/items/items/properties/productSlug", type: "string", required: true, constraints: [], reference: "products.slug" },
    ]);
  });

  it("projects translation and composite-key roles onto their fields", () => {
    const products = schemaModel("products", null, [["slug"]]);
    const translations = schemaModel("product-translations", { parent: "products", on: "slug" }, [["slug", "locale"]]);
    const [slug] = flattenSchemaFields(translations.schema);

    expect(schemaFieldMarkers(slug!, translations, [products, translations])).toEqual([
      { kind: "translation", target: "products.slug", direction: "outgoing", sourceId: "Schema:product-translations", pointer: "/spec/translates" },
      { kind: "unique", index: 0, fields: ["slug", "locale"], sourceId: "Schema:product-translations", pointer: "/spec/uniqueIndexes/0" },
    ]);
  });
});

describe("layoutComponents", () => {
  it("packs disconnected flows while preserving their left-to-right direction", () => {
    const graph: DeveloperConsoleSnapshot["graph"] = {
      atoms: [
        { id: "Trigger:start", kind: "Trigger", name: "start", title: null },
        { id: "Procedure:run", kind: "Procedure", name: "run", title: null },
        { id: "Schema:records", kind: "Schema", name: "records", title: null },
        { id: "View:standalone", kind: "View", name: "standalone", title: null },
      ],
      relations: [
        { id: "start-run", kind: "trigger-target", sourceId: "Trigger:start", targetId: "Procedure:run", pointer: "/spec/target", value: "run" },
        { id: "run-records", kind: "procedure-schema", sourceId: "Procedure:run", targetId: "Schema:records", pointer: "/spec/schema", value: "records" },
      ],
    };

    const positions = layoutComponents(graph);
    expect(positions.size).toBe(4);
    expect(connectedComponents(graph).map((component) => component.length).sort()).toEqual([1, 3]);
    expect(positions.get("Trigger:start")!.x).toBeLessThan(positions.get("Procedure:run")!.x);
    expect(positions.get("Procedure:run")!.x).toBeLessThan(positions.get("Schema:records")!.x);
  });
});

function schemaModel(name: string, translates: DeveloperSchemaModel["translates"], uniqueIndexes: string[][]): DeveloperSchemaModel {
  return {
    name,
    title: name,
    lifecycle: "publishing",
    localized: translates !== null,
    translates,
    schema: {
      type: "object",
      required: ["slug", "locale"],
      properties: { slug: { type: "string" }, locale: { type: "string" } },
    },
    uniqueIndexes,
    indexes: [],
    searchableFields: [],
    manifest: {},
  };
}
