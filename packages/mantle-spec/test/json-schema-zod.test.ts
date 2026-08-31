import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  firstZodIssueAsJsonPointer,
  jsonSchemaToZod,
  zodPathToJsonPointer,
} from "../src/domain/service/JsonSchemaToZod.js";

describe("jsonSchemaToZod — object", () => {
  it("requires fields listed in `required` and makes the rest optional", () => {
    const zs = jsonSchemaToZod({
      type: "object",
      properties: {
        title: { type: "string" },
        slug: { type: "string" },
        description: { type: "string" },
      },
      required: ["title", "slug"],
    });

    expect(zs.safeParse({ title: "Hi", slug: "hi" }).success).toBe(true);
    expect(zs.safeParse({ title: "Hi" }).success).toBe(false);
    expect(zs.safeParse({ title: "Hi", slug: "hi", description: "d" }).success).toBe(true);
  });

  it("accepts an empty `required` array", () => {
    const zs = jsonSchemaToZod({
      type: "object",
      properties: { a: { type: "string" } },
    });
    expect(zs.safeParse({}).success).toBe(true);
    expect(zs.safeParse({ a: "x" }).success).toBe(true);
  });

  it("`additionalProperties: false` rejects unknown keys", () => {
    const zs = jsonSchemaToZod({
      type: "object",
      properties: { a: { type: "string" } },
      required: ["a"],
      additionalProperties: false,
    });
    expect(zs.safeParse({ a: "x" }).success).toBe(true);
    expect(zs.safeParse({ a: "x", b: 1 }).success).toBe(false);
  });

  it("default (no `additionalProperties`) preserves unknown keys", () => {
    const zs = jsonSchemaToZod({
      type: "object",
      properties: { a: { type: "string" } },
      required: ["a"],
    });
    const parsed = zs.safeParse({ a: "x", b: 1 });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toEqual({ a: "x", b: 1 });
  });

  it("validates schema-valued `additionalProperties`", () => {
    const zs = jsonSchemaToZod({ type: "object", additionalProperties: { type: "integer" } });
    expect(zs.safeParse({ one: 1, two: 2 }).success).toBe(true);
    expect(zs.safeParse({ one: "1" }).success).toBe(false);
  });
});

describe("jsonSchemaToZod — string", () => {
  it("enforces minLength / maxLength", () => {
    const zs = jsonSchemaToZod({ type: "string", minLength: 2, maxLength: 5 });
    expect(zs.safeParse("a").success).toBe(false);
    expect(zs.safeParse("ab").success).toBe(true);
    expect(zs.safeParse("abcde").success).toBe(true);
    expect(zs.safeParse("abcdef").success).toBe(false);
  });

  it("enforces pattern", () => {
    const zs = jsonSchemaToZod({ type: "string", pattern: "^[a-z]+$" });
    expect(zs.safeParse("abc").success).toBe(true);
    expect(zs.safeParse("abc1").success).toBe(false);
    expect(zs.safeParse("ABC").success).toBe(false);
  });

  it.each([
    ["email", "alice@example.com", "not-an-email"],
    ["uri", "https://example.com/p", "not a url"],
    ["url", "https://example.com/p", "not a url"],
    ["uuid", "550e8400-e29b-41d4-a716-446655440000", "not-a-uuid"],
    ["date-time", "2026-05-03T10:00:00Z", "2026-05-03"],
    ["date", "2026-05-03", "May 3 2026"],
  ])("format=%s accepts valid, rejects invalid", (fmt, ok, bad) => {
    const zs = jsonSchemaToZod({ type: "string", format: fmt });
    expect(zs.safeParse(ok).success).toBe(true);
    expect(zs.safeParse(bad).success).toBe(false);
  });

  it("unknown formats silently no-op (no false rejection)", () => {
    const zs = jsonSchemaToZod({ type: "string", format: "hostname" });
    expect(zs.safeParse("anything").success).toBe(true);
  });
});

describe("jsonSchemaToZod — number / integer", () => {
  it("number with minimum / maximum", () => {
    const zs = jsonSchemaToZod({ type: "number", minimum: 0, maximum: 10 });
    expect(zs.safeParse(5).success).toBe(true);
    expect(zs.safeParse(0).success).toBe(true);
    expect(zs.safeParse(10).success).toBe(true);
    expect(zs.safeParse(-1).success).toBe(false);
    expect(zs.safeParse(11).success).toBe(false);
    expect(zs.safeParse(2.5).success).toBe(true);
  });

  it("integer rejects floats", () => {
    const zs = jsonSchemaToZod({ type: "integer", minimum: 0 });
    expect(zs.safeParse(2).success).toBe(true);
    expect(zs.safeParse(2.5).success).toBe(false);
  });
});

describe("jsonSchemaToZod — array", () => {
  it("validates items + minItems / maxItems", () => {
    const zs = jsonSchemaToZod({
      type: "array",
      items: { type: "string" },
      minItems: 1,
      maxItems: 3,
    });
    expect(zs.safeParse([]).success).toBe(false);
    expect(zs.safeParse(["a"]).success).toBe(true);
    expect(zs.safeParse(["a", "b", "c"]).success).toBe(true);
    expect(zs.safeParse(["a", "b", "c", "d"]).success).toBe(false);
    expect(zs.safeParse([1]).success).toBe(false);
  });

  it("missing `items` accepts any element", () => {
    const zs = jsonSchemaToZod({ type: "array" });
    expect(zs.safeParse([1, "x", true]).success).toBe(true);
  });
});

describe("jsonSchemaToZod — enum", () => {
  it("string-only enum collapses to z.enum", () => {
    const zs = jsonSchemaToZod({ enum: ["draft", "published", "archived"] });
    expect(zs.safeParse("draft").success).toBe(true);
    expect(zs.safeParse("archived").success).toBe(true);
    expect(zs.safeParse("ghost").success).toBe(false);
    expect(zs.safeParse(1).success).toBe(false);
  });

  it("mixed-type enum becomes a literal union", () => {
    const zs = jsonSchemaToZod({ enum: [1, "x", true] });
    expect(zs.safeParse(1).success).toBe(true);
    expect(zs.safeParse("x").success).toBe(true);
    expect(zs.safeParse(true).success).toBe(true);
    expect(zs.safeParse("y").success).toBe(false);
  });

  it("single-value enum collapses to z.literal", () => {
    const zs = jsonSchemaToZod({ enum: ["only"] });
    expect(zs.safeParse("only").success).toBe(true);
    expect(zs.safeParse("else").success).toBe(false);
  });

  it("enum takes precedence over a `type` keyword", () => {
    const zs = jsonSchemaToZod({ type: "number", enum: ["a", "b"] });
    expect(zs.safeParse("a").success).toBe(true);
    expect(zs.safeParse(1).success).toBe(false);
  });
});

describe("jsonSchemaToZod — boolean / null / unknown", () => {
  it("boolean", () => {
    const zs = jsonSchemaToZod({ type: "boolean" });
    expect(zs.safeParse(true).success).toBe(true);
    expect(zs.safeParse("true").success).toBe(false);
  });

  it("null", () => {
    const zs = jsonSchemaToZod({ type: "null" });
    expect(zs.safeParse(null).success).toBe(true);
    expect(zs.safeParse(0).success).toBe(false);
  });

  it("missing `type` accepts anything (z.unknown)", () => {
    const zs = jsonSchemaToZod({});
    expect(zs.safeParse(1).success).toBe(true);
    expect(zs.safeParse({ x: 1 }).success).toBe(true);
    expect(zs.safeParse(null).success).toBe(true);
  });
});

describe("jsonSchemaToZod — nullable", () => {
  it("nullable: true on a string accepts null and the string type", () => {
    const zs = jsonSchemaToZod({ type: "string", nullable: true });
    expect(zs.safeParse("x").success).toBe(true);
    expect(zs.safeParse(null).success).toBe(true);
    expect(zs.safeParse(1).success).toBe(false);
  });

  it("nullable: false (or unset) on a string rejects null", () => {
    const zs = jsonSchemaToZod({ type: "string" });
    expect(zs.safeParse(null).success).toBe(false);
  });

  it("nullable: true on an object accepts null and the object shape", () => {
    const zs = jsonSchemaToZod({
      type: "object",
      properties: { a: { type: "string" } },
      required: ["a"],
      nullable: true,
    });
    expect(zs.safeParse({ a: "x" }).success).toBe(true);
    expect(zs.safeParse(null).success).toBe(true);
    expect(zs.safeParse({}).success).toBe(false);
  });

  it("nullable: true on a number accepts null and the number type", () => {
    const zs = jsonSchemaToZod({ type: "number", nullable: true });
    expect(zs.safeParse(1).success).toBe(true);
    expect(zs.safeParse(null).success).toBe(true);
    expect(zs.safeParse("1").success).toBe(false);
  });

  it("nullable: true on an array accepts null and the array shape", () => {
    const zs = jsonSchemaToZod({
      type: "array",
      items: { type: "string" },
      nullable: true,
    });
    expect(zs.safeParse(["a"]).success).toBe(true);
    expect(zs.safeParse(null).success).toBe(true);
    expect(zs.safeParse([1]).success).toBe(false);
  });
});

describe("jsonSchemaToZod — type union", () => {
  it("`type: ['string', 'null']` accepts either", () => {
    const zs = jsonSchemaToZod({ type: ["string", "null"] });
    expect(zs.safeParse("x").success).toBe(true);
    expect(zs.safeParse(null).success).toBe(true);
    expect(zs.safeParse(1).success).toBe(false);
  });
});

describe("jsonSchemaToZod — JSON Schema composition", () => {
  it("enforces exact-one `oneOf` semantics", () => {
    const zs = jsonSchemaToZod({
      oneOf: [
        { type: "object", required: ["a"], properties: { a: { type: "string" } } },
        { type: "object", required: ["b"], properties: { b: { type: "number" } } },
      ],
    });
    expect(zs.safeParse({ a: "x" }).success).toBe(true);
    expect(zs.safeParse({ b: 1 }).success).toBe(true);
    expect(zs.safeParse({ a: "x", b: 1 }).success).toBe(false);
  });

  it("resolves recursive local `$defs` refs", () => {
    const zs = jsonSchemaToZod({
      $defs: {
        node: {
          type: "object",
          required: ["value"],
          properties: {
            value: { type: "string" },
            next: { $ref: "#/$defs/node" },
          },
          additionalProperties: false,
        },
      },
      $ref: "#/$defs/node",
    });
    expect(zs.safeParse({ value: "a", next: { value: "b" } }).success).toBe(true);
    expect(zs.safeParse({ value: "a", next: { value: 2 } }).success).toBe(false);
  });

  it("keeps the legacy nullable extension on a local ref", () => {
    const zs = jsonSchemaToZod({
      $defs: { value: { type: "string" } },
      $ref: "#/$defs/value",
      nullable: true,
    });
    expect(zs.safeParse("ok").success).toBe(true);
    expect(zs.safeParse(null).success).toBe(true);
    expect(zs.safeParse(1).success).toBe(false);
  });

  it("enforces `const`", () => {
    const zs = jsonSchemaToZod({ const: "ready" });
    expect(zs.safeParse("ready").success).toBe(true);
    expect(zs.safeParse("pending").success).toBe(false);
  });
});

describe("zodPathToJsonPointer", () => {
  it("empty path → empty string", () => {
    expect(zodPathToJsonPointer([])).toBe("");
  });

  it("nested object/array path", () => {
    expect(zodPathToJsonPointer(["foo", 0, "bar"])).toBe("/foo/0/bar");
  });

  it("escapes `~` and `/` per RFC 6901", () => {
    expect(zodPathToJsonPointer(["a/b"])).toBe("/a~1b");
    expect(zodPathToJsonPointer(["a~b"])).toBe("/a~0b");
    expect(zodPathToJsonPointer(["~/"])).toBe("/~0~1");
  });
});

describe("firstZodIssueAsJsonPointer", () => {
  it("translates a zod issue to the (instancePath, message) shape", () => {
    const zs = z.object({ a: z.string() });
    const r = zs.safeParse({ a: 1 });
    expect(r.success).toBe(false);
    if (r.success) return;
    const ajv = firstZodIssueAsJsonPointer(r.error);
    expect(ajv.instancePath).toBe("/a");
    expect(typeof ajv.message).toBe("string");
    expect(ajv.message.length).toBeGreaterThan(0);
  });

  it("root-level error → instancePath = ''", () => {
    const zs = z.string();
    const r = zs.safeParse(1);
    expect(r.success).toBe(false);
    if (r.success) return;
    const ajv = firstZodIssueAsJsonPointer(r.error);
    expect(ajv.instancePath).toBe("");
  });

  it("ZodError with no issues → fallback message", () => {
    const fake = { issues: [] } as unknown as z.ZodError;
    const ajv = firstZodIssueAsJsonPointer(fake);
    expect(ajv).toEqual({ instancePath: "", message: "validation failed" });
  });
});

describe("jsonSchemaToZod — malformed pattern (#395)", () => {
  it("does not throw at build time when `pattern` is uncompilable", () => {
    // Pre-#395 this threw a raw SyntaxError out of the converter,
    // crashing the request handler. Now the constraint is skipped
    // (validate already flags it as INVALID_PATTERN).
    expect(() =>
      jsonSchemaToZod({
        type: "object",
        properties: { slug: { type: "string", pattern: "(unterminated" } },
      }),
    ).not.toThrow();
    const zs = jsonSchemaToZod({
      type: "object",
      properties: { slug: { type: "string", pattern: "[a-" } },
    });
    // Invalid schema is converted to a controlled validation failure.
    expect(zs.safeParse({ slug: "anything" }).success).toBe(false);
  });
});
