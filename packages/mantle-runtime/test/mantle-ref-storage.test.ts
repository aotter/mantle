import type { SchemaManifest } from "@aotter/mantle-spec";
import { describe, expect, it } from "vitest";
import {
  schemaTableMigrations,
  schemaTableProjection,
} from "../src/infrastructure/storage/SqliteSchemaTables.js";

function lines(ref: unknown): SchemaManifest {
  return {
    apiVersion: "cms.mantle.aotter.net/v1",
    kind: "Schema",
    metadata: { name: "lines" },
    spec: {
      title: "Lines",
      indexes: [["orderId"]],
      schema: { type: "object", properties: { orderId: { type: "string", "x-mantle-ref": ref } } },
    },
  } as SchemaManifest;
}

describe("x-mantle-ref forms in storage", () => {
  it("gives the object form the same relationship index and projection as the string form", () => {
    const string = lines("orders");
    const object = lines({ schema: "orders", field: "id" });
    expect(schemaTableProjection(object)).toBe(schemaTableProjection(string));
    expect(schemaTableMigrations([object])).toEqual(schemaTableMigrations([string]));
    expect(schemaTableMigrations([object]).some((migration) => migration.id.includes(":relation_"))).toBe(true);
  });
});
