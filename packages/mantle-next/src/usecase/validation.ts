/** Compile boundary checks into each operation; no schema enters the request bundle. */
import type { JsonSchema } from "@aotter/mantle/spec";
const q = JSON.stringify;
const pointer = (key: string) => key.replace(/~/g, "~0").replace(/\//g, "~1");
const supported = new Set("$defs $ref $schema $id type nullable properties required additionalProperties items enum format pattern minLength maxLength minimum maximum exclusiveMinimum exclusiveMaximum multipleOf minItems maxItems title description default readOnly writeOnly examples deprecated x-mantle-ref x-mcp-hint".split(" "));
const bounds = [
  ["string", "[...value].length", { minLength:"<", maxLength:">" }],
  ["number", "value", { minimum:"<", maximum:">", exclusiveMinimum:"<=", exclusiveMaximum:">=" }],
  ["array", "value.length", { minItems:"<", maxItems:">" }],
] as const;
const condition = (type: string): string => ({ null:"value === null", array:"Array.isArray(value)", object:'typeof value === "object" && value !== null && !Array.isArray(value)', integer:'typeof value === "number" && Number.isSafeInteger(value)', number:'typeof value === "number" && Number.isFinite(value)' })[type as "null"] ?? `typeof value === ${q(type)}`;

export function emitValidation(plan: { views:Readonly<Record<string,{input?:JsonSchema}>>; procedures:Readonly<Record<string,{input?:JsonSchema}>> }, refuse: (path:string,message:string)=>void = (path,message)=>{throw Error(`${path}: ${message}`);}): Record<string,string> {
  const files: Record<string,string> = {};
  for (const [kind, operations] of [["views",plan.views],["procedures",plan.procedures]] as const) for (const [name,operation] of Object.entries(operations)) {
    const root:JsonSchema = operation.input ?? {type:"object",additionalProperties:false};
    const base = `${kind}/${name}/input`, nodes = new Map<JsonSchema,string>(), functions:string[] = [], formats = new Set<string>();
    let equality = false;
    const resolve = (ref:string): JsonSchema => {
      let value: unknown = root;
      try {
        if (typeof ref !== "string" || !ref.startsWith("#/")) throw Error();
        for (const key of decodeURIComponent(ref.slice(2)).split("/").map(key=>key.replace(/~1/g,"/").replace(/~0/g,"~"))) value = value && typeof value === "object" && Object.hasOwn(value,key) ? (value as Record<string,unknown>)[key] : undefined;
        if (value && typeof value === "object") return value as JsonSchema;
      } catch {}
      refuse(base,"Input ref must be a valid local JSON pointer."); return {};
    };
    const emit = (schema:JsonSchema): string => {
      if (nodes.has(schema)) return nodes.get(schema)!;
      const fn = `check${nodes.size}`; nodes.set(schema,fn);
      for (const key of Object.keys(schema)) if (!supported.has(key)) refuse(base,`Generated input validation does not support '${key}'.`);
      const lines = ['if (depth > 100) fail(path, "Input nesting exceeds 100 levels.");'];
      const check = (invalid:string,message:string) => lines.push(`if (${invalid}) fail(path, ${q(message)});`);
      if (schema.nullable) lines.push("if (value === null) return;");
      if (schema.$ref !== undefined) lines.push(`${emit(resolve(schema.$ref))}(value,path,depth+1);`);
      const types = [schema.type].flat().filter((type):type is string=>!!type);
      for (const type of types) if (!"null array object integer number string boolean".split(" ").includes(type)) refuse(base,`Unsupported input type '${type}'.`);
      if (types.length) check(`!(${types.map(type=>`(${condition(type)})`).join(" || ")})`, `Expected ${types.join(" or ")}.`);
      if (schema.enum) { equality = true; check(`!${q(schema.enum)}.some(option=>equal(value,option))`,"Value is not in enum."); }
      for (const [type,measure,keywords] of bounds) for (const [key,operator] of Object.entries(keywords)) if (schema[key] !== undefined) check(`(${condition(type)}) && ${measure} ${operator} ${schema[key]}`, `Value violates ${key}.`);
      if (schema.multipleOf !== undefined) check(`typeof value === "number" && !(Math.abs(value / ${schema.multipleOf} - Math.round(value / ${schema.multipleOf})) < 1e-9)`,"Number violates multipleOf.");
      if (schema.pattern !== undefined) {
        try { new RegExp(schema.pattern); } catch { refuse(base,"Input pattern is not a valid regular expression."); }
        check(`typeof value === "string" && !new RegExp(${q(schema.pattern)}).test(value)`,"String does not match pattern.");
      }
      if (schema.format) {
        if (!["date","date-time"].includes(schema.format)) refuse(base,`Generated input validation does not support format '${schema.format}'.`);
        else { const scalar = schema.format === "date" ? "encodeDate" : "encodeTimestamptz"; formats.add(scalar); lines.push(`if (typeof value === "string") try { ${scalar}(value); } catch { fail(path, ${q(`Expected a valid ${schema.format}.`)}); }`); }
      }
      if (schema.items) lines.push(`if (Array.isArray(value)) for (let i=0;i<value.length;i++) ${emit(schema.items)}(value[i],path+"/"+i,depth+1);`);
      const object:string[]=[];
      for (const key of schema.required ?? []) object.push(`if (!Object.hasOwn(object,${q(key)})) fail(path+${q("/"+pointer(key))},"Required field is missing.");`);
      for (const [key,child] of Object.entries(schema.properties ?? {})) object.push(`if (Object.hasOwn(object,${q(key)})) ${emit(child)}(object[${q(key)}],path+${q("/"+pointer(key))},depth+1);`);
      if (schema.additionalProperties === false || typeof schema.additionalProperties === "object") object.push(`for (const key of Object.keys(object)) if (!(${q(Object.keys(schema.properties ?? {}))} as readonly string[]).includes(key)) { const childPath = path+"/"+key.replace(/~/g,"~0").replace(/\\//g,"~1"); ${schema.additionalProperties === false ? 'fail(childPath,"Unknown field.");' : `${emit(schema.additionalProperties)}(object[key],childPath,depth+1);`} }`);
      if (object.length) lines.push(`if (${condition("object")}) { const object = value as Record<string,unknown>;\n${object.join("\n")}\n}`);
      functions.push(`function ${fn}(value:unknown,path:string,depth:number):void {\n${lines.join("\n")}\n}`); return fn;
    };
    const validate = emit(root);
    const fields = kind === "views" ? Object.entries(root.properties ?? {}).map(([key,schema])=> {
      const type=[schema.type].flat().find(type=>type&&type!=="null");
      return type === "boolean" || type === "integer" || type === "number" ? [key,type] : [key];
    }) : undefined;
    const helpers = ["fail", ...(equality ? ["equal"] : []), ...(fields ? ["query as read"] : [])];
    const code = `import { ${helpers.join(", ")} } from "@aotter/mantle-next/validation";
${formats.size ? `import { ${[...formats].join(", ")} } from "@aotter/mantle-next/scalars";\n` : ""}${functions.join("\n")}
export function validate(raw:unknown):Record<string,unknown> { ${validate}(raw,${q(base)},0); return raw as Record<string,unknown>; }
${fields ? `export const query = (params:URLSearchParams) => read(params, validate, ${q(`${kind}/${name}`)}, ${q(fields)});\n` : ""}`;
    files[`validation/${kind}/${encodeURIComponent(name)}.ts`]=code;
  }
  return files;
}
