import { beforeAll, describe, expect, it } from "vitest";
import { loadLanguage } from "../src/app/i18n";
import { atomKindLabel, focusSlice, traceAtomIds, layoutComponents } from "../src/features/logic/atom-graph";
import { developerDetailHref, developerSelectionHref } from "../src/features/logic/developer-route";
import { buildSchemaDiagram } from "../src/features/logic/schema-diagram";
import type { DeveloperConsoleSnapshot, DeveloperSchemaModel } from "../src/lib/types";
import { flattenSchemaFields, schemaFieldMarkers } from "../src/features/logic/data-model-view";
beforeAll(() => Promise.all([loadLanguage("zh-TW"), loadLanguage("ja")]));

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

describe("flattenSchemaFields", () => {
  it("keeps nested paths, required flags, and exact constraints", () => {
    expect(flattenSchemaFields({
      type: "object",
      required: ["orderStatus", "items"],
      properties: {
        orderStatus: { type: "string", enum: ["draft", "paid"] },
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
      { path: "orderStatus", pointer: "/spec/schema/properties/orderStatus", type: "string", required: true, constraints: ["enum: draft | paid"], reference: null },
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
  it("places read and command surfaces before procedures and schemas", () => {
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
    expect(positions.get("Trigger:start")!.y).toBeLessThan(positions.get("Procedure:run")!.y);
    expect(positions.get("Procedure:run")!.y).toBeLessThan(positions.get("Schema:records")!.y);
    expect(positions.get("View:standalone")!.y).toBeLessThan(positions.get("Schema:records")!.y);
  });

  it("keeps independent chains vertically aligned", () => {
    const graph: DeveloperConsoleSnapshot["graph"] = {
      atoms: [
        { id: "Trigger:first", kind: "Trigger", name: "first", title: null },
        { id: "Trigger:second", kind: "Trigger", name: "second", title: null },
        { id: "Procedure:first", kind: "Procedure", name: "first", title: null },
        { id: "Procedure:second", kind: "Procedure", name: "second", title: null },
        { id: "Schema:first", kind: "Schema", name: "first", title: null },
        { id: "Schema:second", kind: "Schema", name: "second", title: null },
      ],
      relations: [
        { id: "first-trigger", kind: "trigger-target", sourceId: "Trigger:first", targetId: "Procedure:first", pointer: "/spec/target", value: "first" },
        { id: "second-trigger", kind: "trigger-target", sourceId: "Trigger:second", targetId: "Procedure:second", pointer: "/spec/target", value: "second" },
        { id: "first-schema", kind: "procedure-schema", sourceId: "Procedure:first", targetId: "Schema:first", pointer: "/spec/schema", value: "first" },
        { id: "second-schema", kind: "procedure-schema", sourceId: "Procedure:second", targetId: "Schema:second", pointer: "/spec/schema", value: "second" },
      ],
    };

    const positions = layoutComponents(graph);
    expect(positions.get("Procedure:first")!.x).toBe(positions.get("Trigger:first")!.x);
    expect(positions.get("Schema:first")!.x).toBe(positions.get("Procedure:first")!.x);
    expect(positions.get("Procedure:second")!.x).toBe(positions.get("Trigger:second")!.x);
    expect(positions.get("Schema:second")!.x).toBe(positions.get("Procedure:second")!.x);
  });

  it("traces a schema through its command upstream", () => {
    const graph: DeveloperConsoleSnapshot["graph"] = {
      atoms: [
        { id: "Trigger:start", kind: "Trigger", name: "start", title: null },
        { id: "Procedure:run", kind: "Procedure", name: "run", title: null },
        { id: "Schema:records", kind: "Schema", name: "records", title: null },
        { id: "View:list", kind: "View", name: "list", title: null },
      ],
      relations: [
        { id: "start-run", kind: "trigger-target", sourceId: "Trigger:start", targetId: "Procedure:run", pointer: "/spec/target", value: "run" },
        { id: "run-records", kind: "procedure-schema", sourceId: "Procedure:run", targetId: "Schema:records", pointer: "/spec/schema", value: "records" },
        { id: "run-reference", kind: "schema-reference", sourceId: "Procedure:run", targetId: "Schema:other", pointer: "/spec/input", value: "other" },
        { id: "list-records", kind: "view-source", sourceId: "View:list", targetId: "Schema:records", pointer: "/spec/from", value: "records" },
      ],
    };

    const focus = focusSlice(graph, "Trigger:start");
    expect([...focus.nodeIds]).toEqual(["Trigger:start", "Procedure:run", "Schema:records"]);
    expect([...focus.relationIds]).toEqual(["start-run", "run-records"]);
    const schemaFocus = focusSlice(graph, "Schema:records");
    expect([...schemaFocus.nodeIds]).toEqual(["Schema:records", "Procedure:run", "Trigger:start"]);
    expect([...schemaFocus.relationIds]).toEqual(["run-records", "start-run"]);
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
