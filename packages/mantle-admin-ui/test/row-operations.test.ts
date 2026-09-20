import { describe, expect, it } from "vitest";
import {
  automaticOperationInputFields,
  collectionOperationsFor,
  operationFormSchema,
  operationVersionReady,
  resolveOccTargetId,
} from "../src/features/content/row-operations";
import { globalOperations } from "../src/features/ops/operations-view";
import type { JsonSchema, StaffOperation } from "../src/lib/types";

describe("row operation form inference", () => {
  it("hides the bound ref, auto-generated idempotency key, and expectedVersion", () => {
    const input: JsonSchema = {
      type: "object",
      required: ["operationId", "productSlug", "delta", "expectedVersion"],
      properties: {
        operationId: { type: "string", format: "uuid", "x-mcp-hint": "idempotency-key" },
        productSlug: { type: "string", "x-mantle-ref": "inventory" },
        delta: { type: "integer" },
        expectedVersion: { type: "number" },
      },
    };
    const automatic = automaticOperationInputFields(input);
    const form = operationFormSchema(input, ["productSlug", ...automatic]);

    expect(automatic).toEqual(["operationId", "expectedVersion"]);
    expect(Object.keys(form.properties ?? {})).toEqual(["delta"]);
    expect(form.required).toEqual(["delta"]);
  });
});

describe("resolveOccTargetId", () => {
  const membershipBindings = [
    { collection: "organizations", inputField: "organizationId", rowField: "id" },
    { collection: "organization-members", inputField: "id", rowField: "id" },
  ];

  it("binds a quota-style action to the launch row when input has no id", () => {
    expect(resolveOccTargetId({
      input: { type: "object", properties: { organizationId: { type: "string" }, quota: { type: "number" }, expectedVersion: { type: "number" } } },
      formValue: { organizationId: "org-1", quota: 10 },
      row: { id: "org-1", collection: "organizations" },
      binding: membershipBindings[0],
      rowBindings: [membershipBindings[0]!],
    })).toBe("org-1");
  });

  it("uses form.id for membership mutations even when launched from an organization", () => {
    expect(resolveOccTargetId({
      input: { type: "object", properties: { id: { type: "string" }, organizationId: { type: "string" }, expectedVersion: { type: "number" } } },
      formValue: { organizationId: "org-1" },
      row: { id: "org-1", collection: "organizations" },
      binding: membershipBindings[0],
      rowBindings: membershipBindings,
      targetCollection: "organization-members",
    })).toBeUndefined();

    expect(resolveOccTargetId({
      input: { type: "object", properties: { id: { type: "string" }, organizationId: { type: "string" }, expectedVersion: { type: "number" } } },
      formValue: { organizationId: "org-1", id: "member-9" },
      row: { id: "org-1", collection: "organizations" },
      binding: membershipBindings[0],
      rowBindings: membershipBindings,
      targetCollection: "organization-members",
    })).toBe("member-9");
  });

  it("does not reuse the previous target id after the selection is cleared", () => {
    expect(resolveOccTargetId({
      input: { type: "object", properties: { id: { type: "string" }, expectedVersion: { type: "number" } } },
      formValue: { id: "" },
      row: { id: "member-1", collection: "organization-members" },
      binding: membershipBindings[1],
      rowBindings: membershipBindings,
    })).toBeUndefined();
  });

  it("does not fall back to the launch row when targetCollection is a different collection", () => {
    expect(resolveOccTargetId({
      input: { type: "object", properties: { organizationId: { type: "string" }, userId: { type: "string" }, expectedVersion: { type: "number" } } },
      formValue: { organizationId: "org-1", userId: "user-a" },
      row: { id: "org-1", collection: "organizations" },
      binding: membershipBindings[0],
      rowBindings: [membershipBindings[0]!],
      targetCollection: "organization-members",
    })).toBeUndefined();
  });
});

describe("operationVersionReady", () => {
  it("requires a captured version whenever an OCC target or row is present", () => {
    expect(operationVersionReady({
      declaresExpectedVersion: true,
      expectedVersionRequired: false,
      capturedVersion: undefined,
      occTargetId: "org-1",
      boundRow: true,
    })).toBe(false);
    expect(operationVersionReady({
      declaresExpectedVersion: true,
      expectedVersionRequired: false,
      capturedVersion: 4,
      occTargetId: "org-1",
      boundRow: true,
    })).toBe(true);
  });

  it("keeps submit disabled when expectedVersion is required and no target exists", () => {
    expect(operationVersionReady({
      declaresExpectedVersion: true,
      expectedVersionRequired: true,
      capturedVersion: undefined,
      occTargetId: undefined,
      boundRow: false,
    })).toBe(false);
  });

  it("allows create-path omit when version is not required and there is no row or target", () => {
    expect(operationVersionReady({
      declaresExpectedVersion: true,
      expectedVersionRequired: false,
      capturedVersion: undefined,
      occTargetId: undefined,
      boundRow: false,
    })).toBe(true);
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

    expect(globalOperations([...operations, { ...operation("row-only"), rowBindings: [{ collection: "orders", inputField: "id", rowField: "id" }] }]).map(({ name }) => name)).toEqual(["adjust-inventory"]);
    expect(collectionOperationsFor(operations, "orders").map(({ name }) => name))
      .toEqual(["create-manual-order"]);
  });
});
