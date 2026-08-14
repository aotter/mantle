import { describe, expect, it } from "vitest";
import {
  automaticOperationInputFields,
  collectionOperationsFor,
  operationFormSchema,
} from "../src/features/content/row-operations";
import type { JsonSchema, StaffOperation } from "../src/lib/types";

describe("row operation form inference", () => {
  it("hides the bound ref and auto-generated idempotency key", () => {
    const input: JsonSchema = {
      type: "object",
      required: ["operationId", "productSlug", "delta"],
      properties: {
        operationId: { type: "string", format: "uuid", "x-mcp-hint": "idempotency-key" },
        productSlug: { type: "string", "x-mantle-ref": "inventory" },
        delta: { type: "integer" },
      },
    };
    const automatic = automaticOperationInputFields(input);
    const form = operationFormSchema(input, ["productSlug", ...automatic]);

    expect(automatic).toEqual(["operationId"]);
    expect(Object.keys(form.properties ?? {})).toEqual(["delta"]);
    expect(form.required).toEqual(["delta"]);
  });
});

describe("collection operation binding", () => {
  it("selects only procedures explicitly bound to this collection", () => {
    const operation = (name: string, collectionAction?: string): StaffOperation => ({
      name,
      title: null,
      description: null,
      input: { type: "object" },
      uiSchema: collectionAction ? { collectionAction } : null,
      triggers: ["mcp"],
      rowBindings: [],
    });
    const operations = [
      operation("create-manual-order", "orders"),
      operation("adjust-inventory"),
      operation("create-product", "products"),
    ];

    expect(collectionOperationsFor(operations, "orders").map(({ name }) => name))
      .toEqual(["create-manual-order"]);
  });
});
