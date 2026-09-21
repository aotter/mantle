import { describe, expect, it } from "vitest";
import type { SchemaManifest } from "@aotter/mantle-spec";
import {
  isNullableJsonSchema,
  materializeNullableFields,
} from "../src/domain/model/EntryRow.js";

function schema(properties: SchemaManifest["spec"]["schema"]["properties"]): SchemaManifest {
  return {
    apiVersion: "cms.mantle.aotter.net/v1",
    kind: "Schema",
    metadata: { name: "notes" },
    spec: { title: "Notes", schema: { type: "object", properties } },
  };
}

describe("materializeNullableFields", () => {
  it("treats nullable: true the same as a type array that includes null", () => {
    const handbook = schema({ note: { type: "string", nullable: true } });
    const union = schema({ note: { type: ["string", "null"] } });
    const omitted = { title: "Hi" };
    expect(materializeNullableFields(handbook, omitted)).toEqual({ title: "Hi", note: null });
    expect(materializeNullableFields(union, omitted)).toEqual({ title: "Hi", note: null });
    expect(isNullableJsonSchema(handbook.spec.schema.properties!.note!)).toBe(true);
    expect(isNullableJsonSchema({ type: "string" })).toBe(false);
  });

  it("walks oneOf when deciding whether a field allows null", () => {
    const property = { oneOf: [{ type: "string" }, { type: "null" }] };
    expect(isNullableJsonSchema(property)).toBe(true);
    expect(materializeNullableFields(schema({ note: property }), {})).toEqual({ note: null });
  });
});
