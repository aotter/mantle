import { expect, test } from "bun:test";
import type { JsonSchema, RuntimePlan } from "../src/build/compiler.js";
import { emitValidation } from "../src/usecase/validation.js";
import { loadGenerated } from "./apps/link.js";

const plan = (input: JsonSchema) => ({ views: { search: { input } }, procedures: { save: { input } } }) as unknown as RuntimePlan;
const checked = async (input: JsonSchema, kind = "procedures") => loadGenerated(emitValidation(plan(input))[`validation/${kind}/${kind === "views" ? "search" : "save"}.ts`]!);
const error = (run: () => unknown, path: string) => {
  try { run(); throw Error("Expected validation failure"); } catch (e) {
    expect(e).toMatchObject({ code: "INPUT_VALIDATION_FAILED", path });
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
  for (const input of [{ type: "string", format: "email" }, { type: "array", contains: { type: "string" } }, {const:1}, {oneOf:[]}, {uniqueItems:true}, {minProperties:1}]) {
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
