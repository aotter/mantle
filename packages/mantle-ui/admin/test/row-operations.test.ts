import { describe, expect, it, vi } from "vitest";
import {
  boundOperationsFor,
  collectionOperationsFor,
  createOperationController,
  operationFormSchema,
  rowValues,
} from "../src/features/content/row-operations";
import { idempotencyFields } from "../src/features/ops/interaction-dialog";
import { globalOperations } from "../src/features/ops/operations-view";
import type { JsonSchema, StaffOperation, StaffOperationInteraction } from "../src/lib/types";

const input: JsonSchema = {
  type: "object",
  required: ["operationId", "id", "delta", "expectedVersion"],
  properties: {
    operationId: { type: "string", format: "uuid", "x-mcp-hint": "idempotency-key" },
    id: { type: "string" },
    delta: { type: "integer" },
    expectedVersion: { type: "number" },
  },
};

const operation = (name: string, extra: Partial<StaffOperation> = {}): StaffOperation => ({
  name,
  title: null,
  description: null,
  input,
  uiSchema: null,
  triggers: ["mcp"],
  rowBindings: [],
  interactions: [],
  ...extra,
});

const target: StaffOperationInteraction = { collection: "inventory", bind: [{ input: "id", field: "id" }], version: "expectedVersion", mutates: true };

describe("row operation form", () => {
  it("hides only what the interaction binds and the idempotency key", () => {
    const automatic = idempotencyFields(input);
    const form = operationFormSchema(input, ["id", "expectedVersion", ...automatic]);
    expect(automatic).toEqual(["operationId"]);
    expect(Object.keys(form.properties ?? {})).toEqual(["delta"]);
    expect(form.required).toEqual(["delta"]);
  });

  it("feeds the controller the listed row: id, version and fields", () => {
    expect(rowValues({ id: "p1", collection: "inventory", version: 4, data_preview: { sku: "A" } }))
      .toEqual({ sku: "A", id: "p1", version: 4 });
  });
});

describe("createOperationController (ADR-0029)", () => {
  it("binds the row and locks the version the person reviews, from the declared interaction only", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      entry: { id: "p1", version: 4, data: { delta: 0 } },
    })));
    const controller = createOperationController(operation("adjust", { interactions: [target] }), target, "inventory", { id: "p1", version: 4 });
    await controller.open();
    const state = controller.getSnapshot();
    expect(state.phase).toBe("ready");
    expect(state.bound).toEqual({ id: "p1" });
    expect(state.reviewed?.version).toBe(4);
    expect(typeof state.draft["operationId"]).toBe("string");
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining("/entries/p1?collection=inventory"), expect.anything());
    fetch.mockRestore();
  });

  it("binds nothing and locks nothing without an interaction, even when the input declares expectedVersion", async () => {
    const controller = createOperationController(operation("adjust"), undefined, undefined, undefined);
    await controller.open();
    const state = controller.getSnapshot();
    expect(state.phase).toBe("ready");
    expect(state.bound).toEqual({});
    expect(state.canRead).toBe(false);
  });

  it("maps a refusal to diagnostics and anything else to an uncertain write", async () => {
    const fetch = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, diagnostic: { code: "CONFLICT", message: "Moved." } }), { status: 409 }))
      .mockRejectedValueOnce(new TypeError("Network down"));
    const refused = createOperationController(operation("adjust"), undefined, undefined, undefined);
    await refused.open();
    await refused.submit();
    // No version is locked here, so a CONFLICT is a refusal the person can fix.
    expect(refused.getSnapshot()).toMatchObject({ phase: "failed", diagnostics: [{ code: "CONFLICT" }] });
    const lost = createOperationController(operation("adjust"), undefined, undefined, undefined);
    await lost.open();
    await lost.submit();
    expect(lost.getSnapshot().phase).toBe("uncertain");
    fetch.mockRestore();
  });
});

describe("operation placement", () => {
  it("offers row operations by interaction, header operations by collectionAction, and the rest globally", () => {
    const operations = [
      operation("create-manual-order", { uiSchema: { collectionAction: "orders" } }),
      operation("adjust-inventory"),
      operation("row-only", { interactions: [{ ...target, collection: "orders" }] }),
    ];
    expect(globalOperations(operations).map(({ name }) => name)).toEqual(["adjust-inventory"]);
    expect(collectionOperationsFor(operations, "orders").map(({ name }) => name)).toEqual(["create-manual-order"]);
    expect(boundOperationsFor(operations, "orders").map(({ name }) => name)).toEqual(["row-only"]);
  });
});
