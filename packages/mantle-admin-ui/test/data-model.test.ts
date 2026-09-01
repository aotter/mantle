import { describe, expect, it } from "vitest";
import { flattenSchemaFields } from "../src/features/logic/data-model-view";

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
      { path: "status", type: "string", required: true, constraints: ["enum: draft | paid"] },
      { path: "items", type: "array", required: true, constraints: [] },
      { path: "items[].productSlug", type: "string", required: true, constraints: ["x-mantle-ref: products.slug"] },
    ]);
  });
});
