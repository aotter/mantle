/** Compile boundary checks into each operation; no schema enters the request bundle. */
import { INPUT_RULE_KEYWORDS, lookupLocalRef as lookup, rootRefChain, type JsonSchema } from "../build/compiler.js";
import { literal, q } from "../domain/entry.js";
import { publishingInput } from "./publishing.js";
import { equal } from "../kernel/validation.js";
const pointer = (key: string) => key.replace(/~/g, "~0").replace(/\//g, "~1");
const supported = new Set([..."$defs $ref $schema $id type nullable properties required additionalProperties items enum const format pattern minLength maxLength minimum maximum exclusiveMinimum exclusiveMaximum multipleOf minItems maxItems title description default readOnly writeOnly examples deprecated x-mantle-ref x-mcp-hint".split(" "), ...INPUT_RULE_KEYWORDS]);
const shapes = "see docs/handbook/reference/surface.md";
// YAML .inf and .nan parse to numbers that JSON writes as null.
const finite = (value: unknown): boolean => typeof value === "number" ? Number.isFinite(value) : !!value && typeof value === "object" ? Object.values(value).every(finite) : true;
type Rule = { readonly when: string; readonly key?: string; readonly message: string };
const has = (key: string) => `Object.hasOwn(object,${q(key)})`;
const exactly = (value: unknown, keys: string) => !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join(" ") === keys;
/**
 * An object schema's rules, each failing `when` (JavaScript on `object`) with its sentence at the missing field `key`, or the
 * reason a rule has an unsupported shape.
 */
function rules(schema: JsonSchema): Rule[] | string {
  const declared = (names: unknown): names is string[] => Array.isArray(names) && names.length > 0 && names.every(name => typeof name === "string" && Object.hasOwn(schema.properties ?? {}, name));
  const list = (names: readonly string[]) => names.map(name => `'${name}'`).join(" and ");
  const found: Rule[] = [], { dependentRequired: dependent, anyOf, if: condition, then, else: otherwise } = schema;
  if (dependent !== undefined) {
    if (!dependent || typeof dependent !== "object" || Array.isArray(dependent) || !declared(Object.keys(dependent)) || !Object.values(dependent).every(declared)) return `dependentRequired maps declared properties to lists of declared properties; ${shapes}.`;
    for (const [key, names] of Object.entries(dependent as Record<string, string[]>)) for (const name of names) found.push({ when: `${has(key)} && !${has(name)}`, key: name, message: `'${name}' is required when '${key}' is present.` });
  }
  if (anyOf !== undefined) {
    if (!Array.isArray(anyOf) || !anyOf.length || !anyOf.every(branch => exactly(branch, "required") && declared(branch.required))) return `anyOf is supported only as branches of exactly { required: [declared properties] }; ${shapes}.`;
    const branches = (anyOf as { required: string[] }[]).map(branch => branch.required);
    found.push({ when: `!(${branches.map(names => names.map(has).join(" && ")).join(" || ")})`, message: `At least one of ${branches.map(names => names.length > 1 ? `(${list(names)})` : list(names)).join(", ")} is required.` });
  }
  if (condition !== undefined || then !== undefined || otherwise !== undefined) {
    const [key] = exactly(condition, "properties required") ? Object.keys((condition as JsonSchema).properties!) : [];
    const value = key === undefined ? undefined : (condition as JsonSchema).properties![key];
    // Without required: [key], an absent key satisfies `if`.
    if (key === undefined || !exactly((condition as JsonSchema).properties, key) || !exactly(value, "const") || !(["string", "boolean"].includes(typeof value!.const) || Number.isFinite(value!.const) || value!.const === null) || q((condition as JsonSchema).required) !== q([key]) || !declared([key]))
      return `if is supported only as exactly { properties: { <field>: { const: <string, finite number, boolean or null> } }, required: [<field>] }, so an absent field does not satisfy it; ${shapes}.`;
    if (then === undefined && otherwise === undefined || [then, otherwise].some(branch => branch !== undefined && !(exactly(branch, "required") && declared((branch as JsonSchema).required)))) return `then and else are supported only as exactly { required: [declared properties] } after an if; ${shapes}.`;
    const met = `${has(key)} && object[${q(key)}] === ${q(value!.const)}`;
    for (const name of (then as JsonSchema | undefined)?.required ?? []) found.push({ when: `${met} && !${has(name)}`, key: name, message: `'${name}' is required when '${key}' is ${q(value!.const)}.` });
    for (const name of (otherwise as JsonSchema | undefined)?.required ?? []) found.push({ when: `!(${met}) && !${has(name)}`, key: name, message: `'${name}' is required unless '${key}' is ${q(value!.const)}.` });
  }
  return found;
}
/** Whether an input schema accepts `{}`: a list View is read with no input, so web indexes need this. */
export function acceptsEmpty(input: JsonSchema | undefined): boolean {
  if (input === undefined) return true;
  // Validation applies a root `$ref`'s target too, so each schema along the chain must accept `{}`; an unresolved or cyclic chain does not.
  // dependentRequired needs a present key; an if needs its field, so `{}` meets only an else. An enum or const must admit `{}`.
  return rootRefChain(input)?.every(schema => !schema.required?.length && schema.anyOf === undefined && !(schema.else as JsonSchema | undefined)?.required?.length
    && (schema.enum === undefined || schema.enum.some(option => equal({}, option))) && (schema.const === undefined || equal({}, schema.const)) && (schema.type === undefined || [schema.type].flat().includes("object"))) ?? false;
}
type Text = string | Readonly<Record<string, string>>;
/**
 * An input schema as an AI tool catalogue advertises it: some model APIs refuse rules (a root `anyOf`, `if`), so each rule leaves
 * the schema and becomes a sentence of the description.
 */
export function advertised(input: JsonSchema | undefined, description: Text): { inputSchema: JsonSchema | undefined; description: Text } {
  if (!input) return { inputSchema: input, description };
  const sentences: string[] = [], copy = JSON.parse(q(input)) as Record<string, unknown>;
  const strip = (node: unknown, at: string): void => {
    if (!node || typeof node !== "object") return;
    const schema = node as Record<string, unknown>;
    // An MCP View tool keeps each rule set of its root `$ref` chain as an `allOf` branch over the merged properties.
    const branches = Array.isArray(schema.allOf) ? schema.allOf as JsonSchema[] : [];
    for (const branch of [schema, ...branches.map(branch => ({ ...branch, properties: schema.properties }) as JsonSchema)]) {
      const found = rules(branch);
      if (typeof found !== "string") for (const rule of found) sentences.push(at ? `In '${at}': ${rule.message}` : rule.message);
    }
    if (branches.length && branches.every(branch => Object.keys(branch).every(key => (INPUT_RULE_KEYWORDS as readonly string[]).includes(key)))) delete schema.allOf;
    for (const keyword of INPUT_RULE_KEYWORDS) delete schema[keyword];
    for (const [key, child] of Object.entries((schema.properties ?? {}) as object)) strip(child, `${at}/${key}`);
    for (const [key, child] of Object.entries((schema.$defs ?? {}) as object)) strip(child, `#/$defs/${key}`);
    strip(schema.items, `${at}/*`);
    strip(schema.additionalProperties, `${at}/*`);
  };
  strip(copy, "");
  if (!sentences.length) return { inputSchema: input, description };
  const text = sentences.join(" ");
  return { inputSchema: copy, description: typeof description === "string" ? `${description} ${text}` : Object.fromEntries(Object.entries(description).map(([locale, value]) => [locale, `${value} ${text}`])) };
}
const bounds = [
  ["string", "[...value].length", { minLength:"<", maxLength:">" }],
  ["number", "value", { minimum:"<", maximum:">", exclusiveMinimum:"<=", exclusiveMaximum:">=" }],
  ["array", "value.length", { minItems:"<", maxItems:">" }],
] as const;
const condition = (type: string): string => ({ null:"value === null", array:"Array.isArray(value)", object:'typeof value === "object" && value !== null && !Array.isArray(value)', integer:'typeof value === "number" && Number.isSafeInteger(value)', number:'typeof value === "number" && Number.isFinite(value)' })[type as "null"] ?? `typeof value === ${q(type)}`;
const typeCheck = (types: readonly string[]) => `if (!(${types.map(type=>`(${condition(type)})`).join(" || ")})) fail(path, ${q(`Expected ${types.join(" or ")}.`)});`;

export function emitValidation(plan: { views:Readonly<Record<string,{input?:JsonSchema}>>; procedures:Readonly<Record<string,{input?:JsonSchema}>> }, refuse: (path:string,message:string)=>void = (path,message)=>{throw Error(`${path}: ${message}`);}): Record<string,string> {
  const files: Record<string,string> = {};
  for (const [kind, operations] of [["views",plan.views],["procedures",plan.procedures]] as const) for (const [name,operation] of Object.entries(operations)) {
    const root:JsonSchema = operation.input ?? {type:"object",additionalProperties:false};
    const base = `${kind}/${name}/input`, file = `validation/${kind}/${encodeURIComponent(name)}.ts`;
    const json = q(root);
    if (kind === "procedures" && json === q(publishingInput)) {
      files[file] = `import { transition } from "@aotter/mantle/validation";\nexport const validate = (raw: unknown) => transition(${q(base)}, raw);\n`;
      continue;
    }
    // Only a local `$ref`, or more than 100 nested objects and arrays, can reach the nesting limit: only then is `depth` passed.
    const recursive = json.includes('"$ref"') || json.split(/[[{]/).length > 101, depth = recursive ? ",depth+1" : "";
    // Identical bodies share one function.
    const nodes = new Map<JsonSchema,string>(), bodies = new Map<string,string>(), functions:string[] = [], formats = new Set<string>(), patterns = new Map<string,string>();
    let equality = false;
    const resolve = (ref:string): JsonSchema => {
      const found = lookup(root, ref);
      if (!found) refuse(base,"Input ref must be a valid local JSON pointer.");
      return found ?? {};
    };
    const emit = (schema:JsonSchema): string => {
      if (nodes.has(schema)) return nodes.get(schema)!;
      const named = `check${nodes.size}`;
      nodes.set(schema,named);
      for (const key of Object.keys(schema)) if (!supported.has(key)) refuse(base,`Generated input validation does not support '${key}'.`);
      const lines = recursive ? ['if (depth > 100) fail(path, "Input nesting exceeds 100 levels.");'] : [];
      const check = (invalid:string,message:string) => lines.push(`if (${invalid}) fail(path, ${q(message)});`);
      if (schema.nullable) lines.push("if (value === null) return;");
      if (schema.$ref !== undefined) lines.push(`${emit(resolve(schema.$ref))}(value,path${depth});`);
      const types = [schema.type].flat().filter((type):type is string=>!!type);
      for (const type of types) if (!"null array object integer number string boolean".split(" ").includes(type)) refuse(base,`Unsupported input type '${type}'.`);
      if (types.length) lines.push(typeCheck(types));
      // After a single type check `fail` (never) has narrowed `value`: that type's guard is implied.
      const only = types.length === 1 ? types[0] : undefined;
      const guard = (type:string, test = `(${condition(type)})`) => only === type || type === "number" && only === "integer" ? "" : test + " && ";
      if (schema.enum) { if (!finite(schema.enum)) refuse(base, "Input enum numbers must be finite; JSON has no Infinity or NaN."); equality = true; check(`!${literal(schema.enum)}.some(option=>equal(value,option))`,"Value is not in enum."); }
      if (schema.const !== undefined) { if (!finite(schema.const)) refuse(base, "Input const numbers must be finite; JSON has no Infinity or NaN."); equality = true; check(`!equal(value,${literal(schema.const)})`,"Value violates const."); }
      for (const key of ["minLength", "maxLength", "minItems", "maxItems"] as const) if (schema[key] !== undefined && (!Number.isSafeInteger(schema[key]) || schema[key]! < 0))
        refuse(base, `${key} must be a non-negative safe integer.`);
      for (const key of ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"] as const) if (schema[key] !== undefined && (typeof schema[key] !== "number" || !Number.isFinite(schema[key])))
        refuse(base, `${key} must be a finite number.`);
      if (schema.multipleOf !== undefined && (typeof schema.multipleOf !== "number" || !Number.isFinite(schema.multipleOf) || schema.multipleOf <= 0))
        refuse(base, "multipleOf must be a positive finite number.");
      for (const [type,measure,keywords] of bounds) for (const [key,operator] of Object.entries(keywords)) if (schema[key] !== undefined) check(`${guard(type)}${measure} ${operator} ${schema[key]}`, `Value violates ${key}.`);
      if (schema.multipleOf !== undefined) check(`${guard("number",'typeof value === "number"')}!(Math.abs(value / ${schema.multipleOf} - Math.round(value / ${schema.multipleOf})) < 1e-9)`,"Number violates multipleOf.");
      if (schema.pattern !== undefined) {
        try { new RegExp(schema.pattern); } catch { refuse(base,"Input pattern is not a valid regular expression."); }
        if (!patterns.has(schema.pattern)) patterns.set(schema.pattern,`pattern${patterns.size}`);
        check(`${guard("string",'typeof value === "string"')}!${patterns.get(schema.pattern)}.test(value)`,"String does not match pattern.");
      }
      if (schema.format) {
        if (schema.format === "email") check(`${guard("string",'typeof value === "string"')}!/^[^\\s@]+@[^\\s@]+$/u.test(value)`, "Expected an email with one @, non-empty local and domain parts, and no whitespace.");
        else if (schema.format === "uri") lines.push(`${only === "string" ? "" : 'if (typeof value === "string") '}{ let url: URL | undefined; try { url = new URL(value); } catch {} if (url?.protocol !== "http:" && url?.protocol !== "https:") fail(path, "Expected an absolute http or https URL."); }`);
        else if (!["date","date-time"].includes(schema.format)) refuse(base,`Generated input validation does not support format '${schema.format}'; ${shapes} for the supported formats.`);
        else { const scalar = schema.format === "date" ? "encodeDate" : "encodeTimestamptz"; formats.add(scalar); lines.push(`${only === "string" ? "" : 'if (typeof value === "string") '}try { ${scalar}(value); } catch { fail(path, ${q(`Expected a valid ${schema.format}.`)}); }`); }
      }
      if (schema.items) lines.push(`${only === "array" ? "" : "if (Array.isArray(value)) "}for (let i=0;i<value.length;i++) ${emit(schema.items)}(value[i],path+"/"+i${depth});`);
      // Several keys that need no JSON-pointer escaping are checked by one loop, in the same order.
      const required = schema.required ?? [], checks = Object.entries(schema.properties ?? {}).map(([key,child]) => [key, emit(child)] as const);
      const loop = (keys: readonly string[]) => keys.length > 1 && keys.every(key => pointer(key) === key);
      const object = loop(required) ? [`for (const key of ${q(required)}) if (!Object.hasOwn(object,key)) fail(path+"/"+key,"Required field is missing.");`] : required.map(key => `if (!Object.hasOwn(object,${q(key)})) fail(path+${q("/"+pointer(key))},"Required field is missing.");`);
      if (loop(checks.map(([key]) => key))) object.push(`for (const [key,check] of [${checks.map(([key,fn])=>`[${q(key)},${fn}]`)}] as const) if (Object.hasOwn(object,key)) check(object[key],path+"/"+key${depth});`);
      else for (const [key,fn] of checks) object.push(`if (Object.hasOwn(object,${q(key)})) ${fn}(object[${q(key)}],path+${q("/"+pointer(key))}${depth});`);
      if (schema.additionalProperties === false || typeof schema.additionalProperties === "object") object.push(`for (const key of Object.keys(object)) if (!(${q(Object.keys(schema.properties ?? {}))} as readonly string[]).includes(key)) { const childPath = path+"/"+key.replace(/~/g,"~0").replace(/\\//g,"~1"); ${schema.additionalProperties === false ? 'fail(childPath,"Unknown field.");' : `${emit(schema.additionalProperties)}(object[key],childPath${depth});`} }`);
      const checked = rules(schema);
      if (typeof checked === "string") refuse(base, checked);
      else for (const rule of checked) object.push(`if (${rule.when}) fail(path${rule.key === undefined ? "" : `+${q("/"+pointer(rule.key))}`}, ${q(rule.message)});`);
      if (object.length) lines.push(`${only === "object" ? "" : `if (${condition("object")}) `}{ const object = value as Record<string,unknown>;\n${object.join("\n")}\n}`);
      const body = lines.join("\n");
      // Without recursion nothing calls a check before its body is complete, so an identical body's function serves it.
      const fn = recursive ? named : bodies.get(body) ?? named;
      if (fn === named) { bodies.set(body,fn); functions.push(`function ${fn}(value:unknown,path:string${recursive ? ",depth:number" : ""}):void {\n${body}\n}`); }
      nodes.set(schema,fn); return fn;
    };
    const validate = emit(root);
    const fields = kind === "views" ? Object.entries(root.properties ?? {}).map(([key,schema])=> {
      const type=[schema.type].flat().find(type=>type&&type!=="null");
      return type === "boolean" || type === "integer" || type === "number" ? [key,type] : [key];
    }) : undefined;
    const helpers = [...(functions.length ? ["fail"] : []), ...(equality ? ["equal"] : []), ...(fields ? ["query as read"] : [])];
    const code = `${helpers.length ? `import { ${helpers.join(", ")} } from "@aotter/mantle/validation";\n` : ""}${formats.size ? `import { ${[...formats].join(", ")} } from "@aotter/mantle/scalars";\n` : ""}${[...patterns].map(([pattern,name])=>`const ${name} = new RegExp(${q(pattern)});\n`).join("")}${functions.join("\n")}
export function validate(raw:unknown):Record<string,unknown> { ${validate}(raw,${q(base)}${recursive ? ",0" : ""}); return raw as Record<string,unknown>; }
${fields ? `export const query = (params:URLSearchParams) => read(params, validate, ${q(`${kind}/${name}`)}, ${q(fields)});\n` : ""}`;
    files[file]=code;
  }
  return files;
}
