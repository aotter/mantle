import type { JsonSchema } from "@aotter/mantle-spec";
import { describe, expect, it } from "vitest";
import { projectStandardOutputSchema } from "../src/domain/service/StandardOutputSchema.js";

describe("projectStandardOutputSchema", () => {
  it("projects an object root and normalizes Mantle extensions", () => {
    expect(projectStandardOutputSchema({
      type: "object",
      title: { en: "Result", "zh-TW": "結果" },
      additionalProperties: false,
      required: ["id", "status", "note", "ghost"],
      properties: {
        id: { type: "string", format: "uuid", "x-mantle-ref": "posts" },
        status: { type: "string", enum: ["open", "closed"], default: "open" },
        note: { type: "string", nullable: true, maxLength: 10 },
        count: { type: "integer", minimum: 0, "x-mcp-hint": "money-minor" },
        tags: { type: "array", items: { type: "string", minLength: 1 }, maxItems: 3 },
      },
    })).toEqual({
      type: "object",
      title: "Result",
      additionalProperties: false,
      required: ["id", "note"],
      properties: {
        id: { type: "string" },
        // Runtime checks only the listed values of an enum node.
        status: { enum: ["open", "closed"], default: "open" },
        note: { type: ["string", "null"], maxLength: 10 },
        count: { type: "integer", minimum: 0 },
        tags: { type: "array", items: { type: "string", minLength: 1 }, maxItems: 3 },
      },
    });
  });

  it("keeps local $defs references and applies the rules inside definitions", () => {
    expect(projectStandardOutputSchema({
      type: "object",
      $defs: { item: { type: "object", required: ["x"], properties: { x: { type: "string", default: "d" } } } },
      properties: { item: { $ref: "#/$defs/item", description: "One item" } },
    })).toEqual({
      type: "object",
      $defs: { item: { type: "object", required: [], properties: { x: { type: "string", default: "d" } } } },
      properties: { item: { $ref: "#/$defs/item", description: "One item" } },
    });
  });

  it("drops array bounds that Runtime ignores without an items schema", () => {
    expect(projectStandardOutputSchema({
      type: "object",
      properties: { a: { type: "array", minItems: 1, maxItems: 2 }, b: { type: "array", items: { type: "string" }, minItems: 1 } },
    })).toEqual({
      type: "object",
      properties: { a: { type: "array" }, b: { type: "array", items: { type: "string" }, minItems: 1 } },
    });
  });

  it("keeps recursion through an object and dedupes required", () => {
    expect(projectStandardOutputSchema({
      type: "object",
      $defs: { node: { type: "object", properties: { child: { $ref: "#/$defs/node" } } } },
      required: ["root", "root"],
      properties: { root: { $ref: "#/$defs/node" } },
    })).toMatchObject({ required: ["root"], $defs: { node: { properties: { child: { $ref: "#/$defs/node" } } } } });
  });

  it("drops a property from required when its default is reached through a $ref chain", () => {
    expect(projectStandardOutputSchema({
      type: "object",
      $defs: { a: { $ref: "#/$defs/b" }, b: { type: "string", default: "x" } },
      required: ["p"],
      properties: { p: { $ref: "#/$defs/a" } },
    })).toMatchObject({ required: [] });
  });

  it.each<[string, JsonSchema]>([
    ["a draft-04 boolean exclusiveMinimum", { type: "object", properties: { a: { type: "number", exclusiveMinimum: true } } }],
    ["a string minLength", { type: "object", properties: { a: { type: "string", minLength: "3" } } }],
    ["an empty enum", { type: "object", properties: { a: { enum: [] } } }],
    ["a non-array enum", { type: "object", properties: { a: { enum: "x" } } }],
    ["a non-array required", { type: "object", required: "s", properties: { s: { type: "string" } } }],
    ["a duplicate type list", { type: "object", properties: { a: { type: ["string", "string"] } } }],
    ["a non-object property schema", { type: "object", properties: { a: true } }],
    ["a self-referencing $ref", { type: "object", $defs: { a: { $ref: "#/$defs/a" } }, properties: { p: { $ref: "#/$defs/a" } } }],
    ["a $ref loop", {
      type: "object",
      $defs: { a: { $ref: "#/$defs/b" }, b: { $ref: "#/$defs/a" } },
      properties: { p: { $ref: "#/$defs/a" } },
    }],
    ["a defaulted items schema", { type: "object", properties: { a: { type: "array", items: { type: "string", default: "n/a" } } } }],
    ["an items $ref to a defaulted definition", {
      type: "object",
      $defs: { s: { type: "string", default: "n/a" } },
      properties: { a: { type: "array", items: { $ref: "#/$defs/s" } } },
    }],
    ["enum and const on one node", { type: "object", properties: { a: { enum: ["x", "y"], const: "x" } } }],
  ] as unknown as [string, JsonSchema][])("advertises nothing Ajv cannot compile: %s", (_label, schema) => {
    expect(projectStandardOutputSchema(schema)).toBeUndefined();
  });

  it.each<[string, JsonSchema]>([
    ["a non-object root", { type: "array", items: { type: "string" } }],
    ["a nullable root", { type: "object", nullable: true }],
    ["a root that may be null", { type: ["object", "null"] }],
    ["a root without type", { properties: { a: { type: "string" } } }],
    ["a root $ref", { $defs: { o: { type: "object" } }, $ref: "#/$defs/o" }],
    ["a root enum", { type: "object", enum: [1] }],
    ["pattern", { type: "object", properties: { a: { type: "string", pattern: "^[^x]{2}$" } } }],
    ["multipleOf", { type: "object", properties: { a: { type: "number", multipleOf: 0.1 } } }],
    ["oneOf", { type: "object", properties: { a: { oneOf: [{ type: "string" }, { type: "number" }] } } }],
    ["uniqueItems", { type: "object", properties: { a: { type: "array", uniqueItems: true } } }],
    ["contains", { type: "object", properties: { a: { type: "array", contains: { type: "string" } } } }],
    ["minProperties", { type: "object", minProperties: 1 }],
    ["a type keyword on a node without type", { type: "object", properties: { a: { minLength: 2 } } }],
    ["a type keyword for another type", { type: "object", properties: { a: { type: "number", minLength: 2 } } }],
    ["$ref with a constraint sibling", {
      type: "object",
      $defs: { s: { type: "string" } },
      properties: { a: { $ref: "#/$defs/s", minLength: 2 } },
    }],
    ["nested $defs", { type: "object", properties: { a: { type: "object", $defs: {} } } }],
    ["nullable without type", { type: "object", properties: { a: { enum: ["x"], nullable: true } } }],
  ])("advertises nothing for %s", (_label, schema) => {
    expect(projectStandardOutputSchema(schema)).toBeUndefined();
  });
});
