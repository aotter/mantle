import { expect, test } from "bun:test";
import type { JsonSchema, RuntimePlan } from "../src/build/compiler.js";
import { advertised, emitValidation } from "../src/usecase/validation.js";
import { loadGenerated } from "./apps/link.js";

const plan = (input: JsonSchema) => ({ views: { search: { input } }, procedures: { save: { input } } }) as unknown as RuntimePlan;
const checked = async (input: JsonSchema, kind = "procedures") => loadGenerated(emitValidation(plan(input))[`validation/${kind}/${kind === "views" ? "search" : "save"}.ts`]!);
const error = (run: () => unknown, path: string, message?: string) => {
  try { run(); throw Error("Expected validation failure"); } catch (e) {
    expect(e).toMatchObject({ code: "INPUT_VALIDATION_FAILED", path, ...(message ? { message } : {}) });
  }
};

test("generated validation checks nested types, bounds, enums, formats and escaped field paths", async () => {
  const { validate } = await checked({ type: "object", additionalProperties: false, required: ["value", "a/b~"], properties: {
    value: { type: "integer", minimum: 1, maximum: 5 },
    "a/b~": { type: "array", minItems: 1, maxItems: 2, items: { type: "object", required: ["title"], additionalProperties: false, properties: { title: { type: "string", minLength: 2, maxLength: 4, pattern: "^a" }, day: { type: ["string", "null"], format: "date" }, stamp: { type: "string", format: "date-time" }, state: { enum: ["open", "closed"] } } } },
  } });
  const valid = { value: 2, "a/b~": [{ title: "abc", day: "2024-02-29", stamp: "2026-10-12T12:00:00.123456Z", state: "open" }] };
  expect(validate(valid)).toBe(valid);
  error(() => validate({ ...valid, value: 2.2 }), "procedures/save/input/value");
  error(() => validate({ value: 2 }), "procedures/save/input/a~1b~0");
  error(() => validate({ ...valid, extra: 1 }), "procedures/save/input/extra");
  for (const field of [{ title: "zz" }, { day: "2026-02-29" }, { stamp: "2026-10-12T24:00:00Z" }, { state: "other" }]) {
    error(() => validate({ value: 2, "a/b~": [{ ...valid["a/b~"][0], ...field }] }), `procedures/save/input/a~1b~0/0/${Object.keys(field)[0]}`);
  }
});

test("View query uses Core number/boolean coercion and ignores undeclared keys", async () => {
  const { query } = await checked({ type: "object", required: ["count"], properties: { count: { type: "integer", minimum: 1 }, enabled: { type: "boolean" }, text: { type: "string" } }, additionalProperties: false }, "views");
  expect(query(new URLSearchParams("count=0x10&enabled=false&text=hello&limit=2&cursor=next&other=ignored"))).toEqual({ input: { count: 16, enabled: false, text: "hello" }, limit: 2, cursor: "next" });
  for (const count of ["", "Infinity", "1.1"]) error(() => query(new URLSearchParams({ count })), "views/search/input/count");
  error(() => query(new URLSearchParams("count=2&enabled=1")), "views/search/input/enabled");
  error(() => query(new URLSearchParams("count=2&limit=1.5")), "views/search/limit");
  error(() => query(new URLSearchParams()), "views/search/input/count");
});

test("local references retain nullable fields and structural enums", async () => {
  const {validate}=await checked({type:"object",$defs:{option:{enum:["a","b"]}},properties:{option:{$ref:"#/$defs/option",nullable:true},shape:{enum:[{a:1,b:2}]}}});
  expect(validate({option:"a",shape:{b:2,a:1}})).toBeTruthy();
  expect(validate({option:null})).toBeTruthy();
  error(()=>validate({option:"c"}),"procedures/save/input/option");
});

test("unsupported validation declarations fail generation explicitly", () => {
  for (const input of [{ type: "string", format: "hostname" }, { type: "array", contains: { type: "string" } }, {oneOf:[]}, {uniqueItems:true}, {minProperties:1}]) {
    expect(() => emitValidation(plan(input))).toThrow("Generated input validation does not support");
    const refused: string[] = [];
    emitValidation(plan(input), (path, message) => refused.push(`${path}: ${message}`));
    expect(refused).toHaveLength(2);
  }
});

test("string bounds count Unicode code points", async () => {
  const { validate } = await checked({type:"object",properties:{value:{type:"string",minLength:1,maxLength:1}}});
  expect(validate({value:"😀"})).toEqual({value:"😀"});
  error(()=>validate({value:"😀😀"}),"procedures/save/input/value");
});

test("unsafe integers fail and fractional multipleOf tolerates representation error", async () => {
  const {validate} = await checked({type:"object",properties:{count:{type:"integer"},step:{type:"number",multipleOf:0.1}}});
  error(()=>validate({count:1e30}),"procedures/save/input/count");
  expect(validate({count:Number.MAX_SAFE_INTEGER,step:0.3})).toBeTruthy();
  expect(validate({step:-0.3})).toBeTruthy();
  error(()=>validate({step:0.31}),"procedures/save/input/step");
  const {query}=await checked({type:"object",properties:{count:{type:"integer"}}},"views");
  error(()=>query(new URLSearchParams("count=1e30")),"views/search/input/count");
});

test("malformed percent escapes in local refs become generation diagnostics", () => {
  const diagnostics: string[]=[];
  expect(()=>emitValidation(plan({$ref:"#/%invalid"}), (path,message)=>diagnostics.push(path+": "+message))).not.toThrow();
  expect(diagnostics).toEqual(["views/search/input: Input ref must be a valid local JSON pointer.","procedures/save/input: Input ref must be a valid local JSON pointer."]);
});

test("recursive local references stop at 100 nesting levels", async () => {
  const {validate}=await checked({type:"object",$defs:{node:{type:"object",properties:{next:{$ref:"#/$defs/node"}}}},properties:{next:{$ref:"#/$defs/node"}}});
  const nest=(levels:number)=>{let value:object={};for(let i=0;i<levels;i++)value={next:value};return value;};
  expect(validate(nest(50))).toBeTruthy();
  expect(()=>validate(nest(51))).toThrow(expect.objectContaining({code:"INPUT_VALIDATION_FAILED",path:"procedures/save/input"+"/next".repeat(51),message:"Input nesting exceeds 100 levels."}));
});

 test("email validation is deliberately permissive on View and Procedure boundaries", async () => {
  for (const kind of ["views", "procedures"]) {
    const { validate } = await checked({ type: "object", properties: { email: { type: ["string", "null"], format: "email" } } }, kind);
    for (const email of ["a@b", "+tag@localhost", "名字@網域", "x@y.z", null]) expect(validate({ email })).toEqual({ email });
    for (const email of ["", "a", "@b", "a@", "a@@b", "a@b@c", " a@b", "a@b\n", "a\tb@c", "a@b c"]) error(() => validate({ email }), `${kind}/${kind === "views" ? "search" : "save"}/input/email`);
  }
});

const body = { type: "object", additionalProperties: false, properties: { weight: { type: "number" }, unit: { enum: ["kg", "lb"] }, heightCm: { type: "number" }, bodyFatPct: { type: "number" }, undo: { type: "boolean" }, item: { type: "string" } },
  dependentRequired: { weight: ["unit"] },
  anyOf: [{ required: ["weight"] }, { required: ["heightCm"] }, { required: ["bodyFatPct"] }],
  if: { properties: { undo: { const: true } }, required: ["undo"] }, else: { required: ["item"] } } as JsonSchema;

test("cross-field rules fail at the missing field, or the object, with a sentence naming the rule", async () => {
  const { validate } = await checked(body);
  for (const valid of [{ weight: 70, unit: "kg", item: "a" }, { heightCm: 180, undo: true }, { bodyFatPct: 20, undo: false, item: "a" }]) expect(validate(valid)).toBe(valid);
  error(() => validate({ weight: 70, item: "a" }), "procedures/save/input/unit", "'unit' is required when 'weight' is present.");
  error(() => validate({ unit: "kg", item: "a" }), "procedures/save/input", "At least one of 'weight', 'heightCm', 'bodyFatPct' is required.");
  for (const input of [{ heightCm: 180, undo: false }, { heightCm: 180 }]) error(() => validate(input), "procedures/save/input/item", "'item' is required unless 'undo' is true.");
  error(() => validate({ heightCm: 180, undo: "true" }), "procedures/save/input/undo", "Expected boolean.");
  const nested = await checked({ type: "object", properties: { order: { type: "object", properties: { status: { type: "string" }, "a/reason": { type: "string" }, x: {}, y: {} }, anyOf: [{ required: ["x", "y"] }, { required: ["status"] }],
    if: { properties: { status: { const: "rejected" } }, required: ["status"] }, then: { required: ["a/reason"] } } } });
  expect(nested.validate({ order: { status: "open" } })).toBeTruthy();
  error(() => nested.validate({ order: { status: "rejected" } }), "procedures/save/input/order/a~1reason", "'a/reason' is required when 'status' is \"rejected\".");
  error(() => nested.validate({ order: { x: 1 } }), "procedures/save/input/order", "At least one of ('x' and 'y'), 'status' is required.");
});

test("const compares JSON values", async () => {
  const { validate } = await checked({ type: "object", properties: { kind: { const: "a" }, shape: { const: { a: [1] } }, none: { const: null } } });
  expect(validate({ kind: "a", shape: { a: [1] }, none: null })).toBeTruthy();
  for (const field of [{ kind: "b" }, { shape: { a: [2] } }, { none: 0 }]) error(() => validate(field), `procedures/save/input/${Object.keys(field)[0]}`, "Value violates const.");
});

test("format uri is an absolute http or https URL", async () => {
  const { validate } = await checked({ type: "object", properties: { link: { type: ["string", "null"], format: "uri" } } });
  for (const link of ["https://example.com/a?b#c", "http://localhost:8080", "HTTPS://EXAMPLE.COM", null]) expect(validate({ link })).toEqual({ link });
  for (const link of ["javascript:alert(1)", "data:text/html,x", "ftp://example.com", "mailto:a@b", "/relative", "example.com", "", "http://"]) error(() => validate({ link }), "procedures/save/input/link", "Expected an absolute http or https URL.");
});

test("patterns are compiled once per module", () => {
  const source = emitValidation(plan({ type: "object", properties: { a: { type: "string", pattern: "^a" }, b: { type: "string", pattern: "^a" }, c: { type: "string", pattern: "^c" } } }))["validation/procedures/save.ts"]!;
  expect(source.match(/new RegExp\(/g)).toHaveLength(2);
  expect(source).toStartWith('import { fail } from "@aotter/mantle/validation";\nconst pattern0 = new RegExp("^a");\nconst pattern1 = new RegExp("^c");\n');
});

test("rules of another shape fail generation with the supported shape", () => {
  const object = (rules: object) => ({ type: "object", properties: { a: {}, b: {} }, ...rules }) as JsonSchema;
  for (const [rules, message] of [
    [{ dependentRequired: { a: ["c"] } }, "dependentRequired maps declared properties"],
    [{ dependentRequired: { a: [] } }, "dependentRequired maps declared properties"],
    [{ anyOf: [{ required: ["a"] }, { type: "string" }] }, "anyOf is supported only as branches of exactly { required"],
    [{ anyOf: [] }, "anyOf is supported only"],
    [{ if: { properties: { a: { const: 1 } } }, then: { required: ["b"] } }, "so an absent field does not satisfy it"],
    [{ if: { properties: { a: { const: [1] } }, required: ["a"] }, then: { required: ["b"] } }, "if is supported only"],
    [{ if: { properties: { a: { enum: [1] } }, required: ["a"] }, then: { required: ["b"] } }, "if is supported only"],
    [{ if: { properties: { a: { const: 1 } }, required: ["a"] } }, "then and else are supported only"],
    [{ then: { required: ["b"] } }, "if is supported only"],
    [{ if: { properties: { a: { const: 1 } }, required: ["a"] }, else: { required: ["b"], properties: {} } }, "then and else are supported only"],
  ] as const) {
    const refused: string[] = [];
    emitValidation(plan(object(rules)), (path, text) => refused.push(`${path}: ${text}`));
    expect(refused).toEqual([expect.stringContaining(message), expect.stringContaining(message)]);
    expect(refused[0]).toContain("see docs/handbook/reference/surface.md");
  }
  expect(() => emitValidation(plan({ type: "string", format: "hostname" }))).toThrow("Generated input validation does not support format 'hostname'; see docs/handbook/reference/surface.md");
});

test("AI tool catalogues advertise rules as description sentences, not keywords", () => {
  const { inputSchema, description } = advertised({ ...body, properties: { ...body.properties, order: { type: "object", properties: { a: {} }, dependentRequired: { a: ["a"] } } } }, { en: "Log a measurement.", zh: "記錄" });
  expect(JSON.stringify(inputSchema)).not.toMatch(/"(?:dependentRequired|anyOf|if|then|else)"/);
  expect(inputSchema).toMatchObject({ additionalProperties: false, properties: { undo: { type: "boolean" } } });
  expect(description).toEqual({ en: "Log a measurement. 'unit' is required when 'weight' is present. At least one of 'weight', 'heightCm', 'bodyFatPct' is required. 'item' is required unless 'undo' is true. In '/order': 'a' is required when 'a' is present.", zh: "記錄 'unit' is required when 'weight' is present. At least one of 'weight', 'heightCm', 'bodyFatPct' is required. 'item' is required unless 'undo' is true. In '/order': 'a' is required when 'a' is present." });
  expect(body).toHaveProperty("anyOf");
  const plain = { type: "object" } as JsonSchema;
  expect(advertised(plain, "Same.")).toEqual({ inputSchema: plain, description: "Same." });
});
