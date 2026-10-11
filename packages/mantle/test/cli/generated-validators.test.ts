// @ts-nocheck test corpus includes deliberately unsupported schemas and exotic JS values
import { expect, it, vi } from "vitest";
import { z } from "zod";
import { emitValidator, emitValidators } from "../../src/cli/emitValidators.js";
import { jsonSchemaToZod, jsonSchemaValidator, safeParseJson, firstZodIssueAsJsonPointer } from "../../src/spec/domain/service/JsonSchemaToZod.js";
import { planValidators } from "../../src/core/runtime/validators.js";
import { compile } from "../core/lowered-fixture.js";

const make = (schema) => {
  const expression = emitValidator(schema);
  expect(expression).toBeDefined();
  return jsonSchemaValidator((z) => new Function("z", `return ${expression};`)(z));
};
const parsed = (validator, value) => {
  const result = safeParseJson(validator, value);
  return result.success ? { success: true, data: result.data, frozen: Object.isFrozen(result.data) } : { success: false, first: firstZodIssueAsJsonPointer(result.error), issues: result.error.issues.map(({ input: _input, ...issue }) => issue) };
};
const corpus = [
  [{}, [undefined, null, false, "x", { a: 1 }]],
  [{ type: "string", minLength: 2, maxLength: 4, pattern: "^[a-z]+$" }, [undefined, null, "", "a", "ab", "AB", "very-long!", "😀😀"]],
  [{ type: "integer", minimum: -3, maximum: 8, multipleOf: 2 }, [undefined, NaN, Infinity, 2, -4, 9, 1.5, 9007199254740992]],
  [{ type: "number", minimum: 0, exclusiveMinimum: true, exclusiveMaximum: 10 }, [0, -1, 1, 9.5, 10, "2"]],
  [{ type: "boolean" }, [undefined, null, false, true, 0, "false"]],
  [{ type: "null" }, [undefined, null, false]],
  [{ type: "string", nullable: true, minLength: 2 }, [null, undefined, "a", "ab", 1]],
  [{ type: ["integer", "string", "null"] }, [null, 2, 2.5, "x", []]],
  [{ enum: ["a", "b"] }, [undefined, null, "a", "c", 0]],
  [{ enum: [null, false, 1, "x"] }, [null, false, 1, "x", {}, "y"]],
  [{ enum: [] }, [undefined, null, "x"]],
  [{ const: 3 }, [3, 4, null]],
  [{ type: "array", items: { type: "integer" }, minItems: 1, maxItems: 2 }, [[], [1], [1, 2, 3], [1, "bad"], null, new Array(1)]],
  [{ type: "array", maxItems: 0 }, [[], [1, "two"]]],
  [{ type: "object", required: ["required", "absent"], properties: { required: { type: "integer" }, optional: { type: "string", default: "default" } } }, [{}, { required: 1 }, { required: 1, optional: undefined, extra: true }, { required: "bad", optional: 2 }]],
  [{ type: "object", additionalProperties: false, properties: { "a/~": { type: "array", items: { type: "integer" } } } }, [{}, { "a/~": [1, "bad"] }, { unexpected: true }, { "a/~": ["bad"], unexpected: true }]],
  [{ type: "object", properties: { nested: { type: "object", properties: { x: { type: "string" } } } }, default: { nested: { x: "default" } }, readOnly: true }, [undefined, {}, { nested: { x: "ok" } }]],
  [{ type: "object", properties: { ["__proto__"]: { type: "string" }, ["constructor"]: { type: "integer" } } }, [JSON.parse('{"__proto__":"safe","constructor":1}'), {}]],
];

it("official generated factories preserve success values, defaults and exact error issues", () => {
  for (const [schema, values] of corpus) {
    const generated = make(schema), imported = jsonSchemaToZod(schema);
    for (const value of values) for (let call = 0; call < 2; call++) expect(parsed(generated, value), JSON.stringify(schema)).toStrictEqual(parsed(imported, value));
  }
  for (const format of ["email", "uri", "url", "uuid", "date-time", "date", "duration", "hostname", "ipv4", "ipv6"]) {
    const schema = { type: "string", format, maxLength: 100 };
    for (const value of ["", "not valid", "2026-10-11T03:02:01+08:00", "2026-10-11", "https://example.com", "a@example.com", "127.0.0.1"]) expect(parsed(make(schema), value)).toStrictEqual(parsed(jsonSchemaToZod(schema), value));
  }
});

it("uses the same safety walk and official getter, inherited-key and Proxy evaluation order", () => {
  const schema = { type: "object", required: ["x"], properties: { x: { type: "integer" }, child: { type: "object", properties: { value: { type: "string" } } } } };
  for (const scenario of ["valid", "invalid", "throw", "proxy", "inherited"]) {
    const run = (validator) => {
      const reads: string[] = [];
      const x = { get x() { reads.push("x"); if (scenario === "throw") throw new Error("getter failed"); return scenario === "invalid" ? "bad" : 3; }, child: { get value() { reads.push("value"); return "nested"; } }, get extra() { reads.push("extra"); return true; } };
      const input = scenario === "proxy" ? new Proxy(x, { get(t, k, r) { reads.push(`get:${String(k)}`); return Reflect.get(t, k, r); }, ownKeys(t) { reads.push("keys"); return Reflect.ownKeys(t); }, getOwnPropertyDescriptor(t, k) { reads.push(`descriptor:${String(k)}`); return Reflect.getOwnPropertyDescriptor(t, k); }, has(t, k) { reads.push(`has:${String(k)}`); return Reflect.has(t, k); } }) : scenario === "inherited" ? Object.assign(Object.create({ inherited: "kept" }), x) : x;
      return { result: parsed(validator, input), reads };
    };
    expect(run(make(schema))).toStrictEqual(run(jsonSchemaToZod(schema)));
  }
  const anyObject = { type: "object" };
  const cycle: any = {}; cycle.self = cycle;
  let deep: any = {}; for (let n = 0; n < 102; n++) deep = { child: deep };
  const wide = { nodes: Array.from({ length: 10_001 }, () => ({})) };
  const shared = {}; const alias = { first: shared, second: shared };
  for (const value of [cycle, deep, wide, alias]) expect(parsed(make(anyObject), value)).toStrictEqual(parsed(jsonSchemaToZod(anyObject), value));
});

it("keeps length-before-pattern abort and construction failure behavior", () => {
  const schema = { type: "string", maxLength: 2, pattern: "^[a-z]+$" };
  const generated = make(schema), imported = jsonSchemaToZod(schema);
  const exec = vi.spyOn(RegExp.prototype, "test");
  try {
    for (const validator of [generated, imported]) { exec.mockClear(); const result = parsed(validator, "too long!"); const patternCalls = exec.mock.contexts.filter((regex) => regex.source === "^[a-z]+$").length; expect(result.success).toBe(false); expect(patternCalls).toBe(0); }
  } finally { exec.mockRestore(); }
  expect(parsed(make({ type: "string", pattern: "[" }), "x")).toStrictEqual(parsed(jsonSchemaToZod({ type: "string", pattern: "[" }), "x"));
});

it("uses official import for every unsupported semantic keyword, including nested schemas", () => {
  for (const unsupported of [{ oneOf: [{ type: "string" }, { type: "number" }] }, { $ref: "#/$defs/x", $defs: { x: { type: "string" } } }, { type: "array", uniqueItems: true }, { type: "object", minProperties: 1 }, { type: "object", additionalProperties: { type: "integer" } }, { type: "string", format: "time" }, { nullable: true }, { type: "object", properties: { x: { oneOf: [{ type: "string" }] } } }]) expect(emitValidator(unsupported)).toBeUndefined();
});

it("emits lazy factories and keeps generated and generic caches separate", async () => {
  const plan = await compile();
  const source = emitValidators(plan);
  expect(source).toBeDefined();
  const finish = vi.fn(jsonSchemaValidator);
  const generated = new Function("jsonSchemaValidator", `return ${source};`)(finish);
  expect(finish).not.toHaveBeenCalled();
  const lazy = planValidators(plan, generated), ordinary = planValidators(plan);
  expect(lazy).toBe(planValidators(plan, generated));
  expect(lazy).not.toBe(ordinary);
  const a = lazy.procedure("add-item", "input");
  expect(finish).toHaveBeenCalledTimes(1);
  expect(lazy.procedure("add-item", "input")).toBe(a);
  expect(finish).toHaveBeenCalledTimes(1);
  expect(parsed(a, { name: "item", stock: 3 })).toStrictEqual(parsed(ordinary.procedure("add-item", "input"), { name: "item", stock: 3 }));
  const fallback = planValidators(plan, { procedure: {} });
  expect(parsed(fallback.procedure("add-item", "input"), { stock: "bad" })).toStrictEqual(parsed(ordinary.procedure("add-item", "input"), { stock: "bad" }));
  expect(finish).toHaveBeenCalledTimes(1);
});
