import { expect, it } from "vitest";
import { firstZodIssueAsJsonPointer, jsonSchemaToZod } from "../../src/spec/domain/service/JsonSchemaToZod.js";

// JSON Schema semantics are Zod's (`z.fromJSONSchema`); only what Mantle adds on top is tested here.

it("the legacy `nullable` accepts null on a typed schema, an untyped one and a local ref, and `format: url` is `uri`", () => {
  expect(jsonSchemaToZod({ type: "string", nullable: true }).safeParse(null).success).toBe(true);
  expect(jsonSchemaToZod({ type: "string" }).safeParse(null).success).toBe(false);
  expect(jsonSchemaToZod({ type: "object", properties: { n: { type: "number", nullable: true } } }).safeParse({ n: null }).success).toBe(true);
  const ref = jsonSchemaToZod({ $defs: { s: { type: "string" } }, $ref: "#/$defs/s", nullable: true } as never);
  expect([ref.safeParse(null).success, ref.safeParse("x").success, ref.safeParse(1).success]).toEqual([true, true, false]);
  const url = jsonSchemaToZod({ type: "string", format: "url" });
  expect([url.safeParse("https://example.com/p").success, url.safeParse("not a url").success]).toEqual([true, false]);
});

it("an uncompilable pattern is a validation failure, not a throw (#395)", () => {
  const zs = jsonSchemaToZod({ type: "object", properties: { slug: { type: "string", pattern: "[a-" } } });
  expect(zs.safeParse({ slug: "anything" }).success).toBe(false);
});

it("refuses a value past the depth limit or with a cycle before Zod walks it", () => {
  let deep: unknown = 1;
  for (let i = 0; i < 102; i++) deep = [deep];
  expect(jsonSchemaToZod({}).safeParse(deep).success).toBe(false);
  const cyclic: Record<string, unknown> = {};
  cyclic["self"] = cyclic;
  expect(jsonSchemaToZod({}).safeParse(cyclic).success).toBe(false);
  expect(jsonSchemaToZod({}).safeParse([[[1]]]).success).toBe(true);
});

it("an issue path is an RFC 6901 pointer", () => {
  const r = jsonSchemaToZod({ type: "object", properties: { "a/b~c": { type: "array", items: { type: "number" } } } }).safeParse({ "a/b~c": [1, "x"] });
  expect(firstZodIssueAsJsonPointer(r.error!).instancePath).toBe("/a~1b~0c/1");
});
