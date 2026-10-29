import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildSchemaDiagram, erdRows } from "../src/features/logic/schema-diagram";
import type { DeveloperConsoleSnapshot } from "../src/lib/types";

// #1890: the generated Developer snapshot of fixtures/erd-marketplace.yaml (18 Schemas, every relation shape).
const snapshot = JSON.parse(readFileSync(resolve(import.meta.dirname, "fixtures/erd-marketplace.snapshot.json"), "utf8")) as DeveloperConsoleSnapshot;
const model = (name: string) => snapshot.dataModel.schemas.find((schema) => schema.name === name)!;
const row = (schema: string, name: string) => erdRows(model(schema)).find((entry) => entry.name === name)!;
const edge = (id: string) => buildSchemaDiagram(snapshot, "en").edges.find((entry) => entry.id === id)!;

describe("schema ER diagram", () => {
  it("marks keys, uniques, indexes, scope and search per column", () => {
    expect(row("orders", "id")).toMatchObject({ primary: true, system: true });
    expect(row("orders", "owner")).toMatchObject({ scope: true, indexed: true, required: true });
    expect(row("orders", "couponId")).toMatchObject({ reference: { schema: "coupons", field: "id" }, required: false });
    expect(row("products", "slug")).toMatchObject({ unique: ["slug"], search: true });
    expect(row("product_tags", "productId").unique).toEqual(["productid", "tagid"]);
    expect(row("products", "status")).toMatchObject({ system: true });
    expect(erdRows(model("orders")).some((entry) => entry.name === "status")).toBe(false);
  });

  it("joins each reference column to the referenced column with its cardinality", () => {
    expect(edge("Schema:stock:field:productId:products")).toMatchObject({ sourceHandle: expect.stringMatching(/^productId:s:/), targetHandle: expect.stringMatching(/^id:t:/), data: { source: "many", target: "one" } });
    expect(edge("Schema:orders:field:couponId:coupons").data).toMatchObject({ source: "many", target: "zeroOrOne" });
    expect(edge("Schema:payments:field:orderId:orders").data).toMatchObject({ source: "one", target: "one" });
    expect(edge("Schema:categories:field:parentId:categories")).toMatchObject({ sourceHandle: "parentId:s:r", targetHandle: "id:t:r" });
    const translation = buildSchemaDiagram(snapshot, "en").edges.find(({ data }) => data?.kind === "translation-parent")!;
    expect(translation).toMatchObject({ sourceHandle: expect.stringMatching(/^slug:s:/), targetHandle: expect.stringMatching(/^slug:t:/), style: { strokeDasharray: "6 4" } });
  });

  it("keeps key rows in Keys only, lands edges on headers in Table names, and lays unrelated tables out below", () => {
    const keys = buildSchemaDiagram(snapshot, "en", "keys");
    const orders = keys.nodes.find(({ id }) => id === "Schema:orders")!;
    expect(orders.data.rows.map(({ name }) => name)).toEqual(["id", "owner", "couponId"]);
    const names = buildSchemaDiagram(snapshot, "en", "names");
    expect(names.edges.every(({ sourceHandle, targetHandle }) => sourceHandle?.startsWith("@:") && targetHandle?.startsWith("@:"))).toBe(true);
    const { nodes } = buildSchemaDiagram(snapshot, "en");
    const loose = nodes.filter(({ id }) => id === "Schema:audit_log" || id === "Schema:settings");
    const related = nodes.filter((node) => !loose.includes(node));
    const bottom = Math.max(...related.map(({ position, style }) => position.y + Number(style?.height)));
    expect(loose.every(({ position }) => position.y > bottom)).toBe(true);
  });
});
