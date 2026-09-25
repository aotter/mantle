import { describe, expect, it } from "vitest";

import { atomKindLabel, focusSlice, relationLabel, traceAtomIds } from "../src/features/logic/atom-graph";
import { developerDetailHref, developerSelectionHref } from "../src/features/logic/developer-route";
import { buildSchemaDiagram } from "../src/features/logic/schema-diagram";
import type { DeveloperConsoleSnapshot } from "../src/lib/types";

const graph: DeveloperConsoleSnapshot["graph"] = {
  atoms: [
    { id: "Schema:orders", kind: "Schema", name: "orders", title: null },
    { id: "Schema:customers", kind: "Schema", name: "customers", title: null },
    { id: "Procedure:place-order", kind: "Procedure", name: "place-order", title: null },
    { id: "Trigger:place-order-http", kind: "Trigger", name: "place-order-http", title: null, transport: "http" },
  ],
  relations: [
    { id: "trigger", kind: "trigger-target", sourceId: "Trigger:place-order-http", targetId: "Procedure:place-order", pointer: "/spec/target/procedure", value: "place-order" },
    { id: "schema", kind: "procedure-schema", sourceId: "Procedure:place-order", targetId: "Schema:orders", pointer: "/spec/handler/schema", value: "orders" },
    { id: "reference", kind: "schema-reference", sourceId: "Schema:orders", targetId: "Schema:customers", pointer: "/spec/schema/properties/customerId/x-mantle-ref", value: "customers" },
  ],
};

describe("manifest graph trace", () => {
  it("keeps the selected trigger path ordered for HUD navigation", () => {
    const slice = focusSlice(graph, "Trigger:place-order-http");
    expect(traceAtomIds(graph, slice.nodeIds, slice.startId)).toEqual([
      "Trigger:place-order-http",
      "Procedure:place-order",
      "Schema:orders",
    ]);
    expect([...slice.relationIds]).toEqual(["trigger", "schema"]);
  });

  it("traces a schema through its outgoing references", () => {
    const slice = focusSlice(graph, "Schema:orders");
    expect(traceAtomIds(graph, slice.nodeIds, slice.startId)).toEqual(["Trigger:place-order-http", "Procedure:place-order", "Schema:orders", "Schema:customers"]);
    expect([...slice.nodeIds]).toEqual(expect.arrayContaining(["Trigger:place-order-http", "Procedure:place-order", "Schema:orders", "Schema:customers"]));
    expect([...slice.relationIds]).toEqual(["reference", "schema", "trigger"]);
  });

  it("keeps UI action placement out of execution paths", () => {
    const placed = { ...graph, relations: [
      ...graph.relations.filter(({ id }) => id !== "schema"),
      { id: "placement", kind: "collection-action" as const, sourceId: "Procedure:place-order", targetId: "Schema:orders", pointer: "/spec/uiSchema/collectionAction", value: "orders" },
    ] };
    expect([...focusSlice(placed, "Trigger:place-order-http").nodeIds]).toEqual([
      "Trigger:place-order-http", "Procedure:place-order",
    ]);
    expect([...focusSlice(placed, "Procedure:place-order").relationIds]).toEqual(["trigger"]);
    expect([...focusSlice(placed, "Schema:orders").relationIds]).not.toContain("placement");
    expect(placed.relations).toContainEqual(expect.objectContaining({ kind: "collection-action" }));
    expect(relationLabel("en", "collection-action")).toBe("placed as collection action");
  });

  it("keeps graph and model selection in shareable URLs", () => {
    expect(developerSelectionHref("/admin/dev", "View:my requisitions")).toBe("/admin/dev?selected=View%3Amy+requisitions");
    expect(developerSelectionHref("/admin/dev/model", "Schema:orders", { tab: "manifest", pointer: "/spec/schema" })).toBe("/admin/dev/model?selected=Schema%3Aorders&tab=manifest&pointer=%2Fspec%2Fschema");
    expect(developerSelectionHref("/admin/dev/model", "View:open-orders", { tab: "raw" })).toBe("/admin/dev/model?selected=View%3Aopen-orders&tab=raw");
    expect(developerSelectionHref("/admin/dev/logic", "Trigger:place-order-http", { tab: "contract" })).toBe("/admin/dev/logic?selected=Trigger%3Aplace-order-http&tab=contract");
    expect(developerDetailHref("Procedure:place-order")).toBe("/admin/dev/logic/procedures?selected=Procedure%3Aplace-order");
    expect(developerDetailHref("View:open-orders")).toBe("/admin/dev/model/views?selected=View%3Aopen-orders");
  });

  it("builds schema relationships from manifest references", () => {
    const snapshot: DeveloperConsoleSnapshot = {
      dataModel: { schemas: [
        { name: "orders", title: "Orders", lifecycle: "operational", localized: false, translates: null, schema: { type: "object", properties: { id: { type: "string" }, customerId: { type: "string", "x-mantle-ref": "customers" } } }, uniqueIndexes: [], indexes: [], searchableFields: [], manifest: {} },
        { name: "customers", title: "Customers", lifecycle: "operational", localized: false, translates: null, schema: { type: "object", properties: { id: { type: "string" } } }, uniqueIndexes: [], indexes: [], searchableFields: [], manifest: {} },
      ], views: [] },
      logic: { triggers: [], procedures: [] },
      interfaces: { http: [], callable: [] },
      graph: { atoms: graph.atoms, relations: graph.relations },
    };
    const diagram = buildSchemaDiagram(snapshot, "en");
    expect(diagram.nodes.map(({ id }) => id)).toEqual(["Schema:orders", "Schema:customers"]);
    expect(diagram.edges).toHaveLength(1);
    expect(diagram.edges[0]?.data?.label).toContain("customerId");
  });

  it("localizes developer atom labels", () => {
    expect(atomKindLabel("en", "Procedure")).toBe("Procedure");
    expect(atomKindLabel("zh-TW", "Procedure")).toBe("程序");
    expect(atomKindLabel("ja", "Procedure")).toBe("プロシージャ");
  });
});
