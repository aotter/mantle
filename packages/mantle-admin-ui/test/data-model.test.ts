import { describe, expect, it } from "vitest";
import { flattenSchemaFields, schemaFieldMarkers } from "../src/features/logic/data-model-view";
import type { DeveloperSchemaModel } from "../src/lib/types";

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
