/** Generate official Zod Mini construction (tree-shakable functions, no method chains), never a second value validator. Unsupported schemas are diagnosed at generation. */
import type { JsonSchema } from "@aotter/mantle/spec";

const keys = new Set(["type", "properties", "required", "additionalProperties", "items", "minItems", "maxItems", "minLength", "maxLength", "pattern", "format", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "enum", "const", "default", "readOnly", "nullable", "title", "description"]);
const formats: Readonly<Record<string, string>> = {
  email: "z.email()", uri: "z.url()", "uri-reference": "z.url()", url: "z.url()", uuid: "z.uuid()", guid: "z.uuid()",
  "date-time": "z.iso.datetime({ offset: true })", date: "z.iso.date()", duration: "z.iso.duration()", hostname: "z.hostname()", ipv4: "z.ipv4()", ipv6: "z.ipv6()",
};
const literal = (v: unknown): string => v !== null && typeof v === "object" ? `JSON.parse(${JSON.stringify(JSON.stringify(v))})` : JSON.stringify(v) ?? "undefined";

/** An expression using the official constructor order of z.fromJSONSchema; undefined refuses generation until a complete native expression is implemented. */
export function emitValidator(schema: JsonSchema): string | undefined {
  if (!schema || typeof schema !== "object" || Array.isArray(schema) || Object.keys(schema).some((k) => !keys.has(k))) return undefined;
  if (schema.nullable && schema.type === undefined) return undefined; // normalization creates a composed schema
  const primitive = (v: unknown) => v === null || ["string", "number", "boolean"].includes(typeof v);
  const base = (type: JsonSchema["type"]): string | undefined => {
    if (schema.enum !== undefined) {
      if (!schema.enum.every(primitive)) return undefined;
      if (!schema.enum.length) return "z.never()";
      if (schema.enum.length === 1) return `z.literal(${literal(schema.enum[0])})`;
      return schema.enum.every((v) => typeof v === "string") ? `z.enum(${literal(schema.enum)})` : `z.union([${schema.enum.map((v) => `z.literal(${literal(v)})`).join(", ")}])`;
    }
    if (schema.const !== undefined) return primitive(schema.const) ? `z.literal(${literal(schema.const)})` : undefined;
    if (Array.isArray(type)) {
      const entries = type.map(base);
      if (entries.some((e) => e === undefined)) return undefined;
      return entries.length === 0 ? "z.never()" : entries.length === 1 ? entries[0] : `z.union([${entries.join(", ")}])`;
    }
    let out: string;
    const checks: string[] = [];
    const check = (key: keyof JsonSchema, fn: string) => { if (typeof schema[key] === "number") checks.push(`z.${fn}(${schema[key]})`); };
    switch (type) {
      case undefined: return "z.any()";
      case "string":
        if (schema.format && !Object.hasOwn(formats, schema.format)) return undefined;
        out = schema.format ? formats[schema.format]! : "z.string()";
        check("minLength", "minLength");
        if (typeof schema.maxLength === "number") checks.push(`z.maxLength(${schema.maxLength}, { abort: true })`);
        if (schema.pattern) checks.push(`z.regex(new RegExp(${literal(schema.pattern)}))`);
        break;
      case "integer": case "number":
        out = type === "integer" ? "z.int()" : "z.number()";
        if (schema.exclusiveMinimum !== true) check("minimum", "gte");
        if (schema.exclusiveMaximum !== true) check("maximum", "lte");
        if (typeof schema.exclusiveMinimum === "number") check("exclusiveMinimum", "gt");
        else if (schema.exclusiveMinimum === true) check("minimum", "gt");
        if (typeof schema.exclusiveMaximum === "number") check("exclusiveMaximum", "lt");
        else if (schema.exclusiveMaximum === true) check("maximum", "lt");
        check("multipleOf", "multipleOf");
        break;
      case "boolean": return "z.boolean()";
      case "null": return "z.null()";
      case "object": {
        if (typeof schema.additionalProperties === "object") return undefined;
        const properties: string[] = [];
        for (const [key, child] of Object.entries(schema.properties ?? {})) {
          const expression = emitValidator(child);
          if (expression === undefined) return undefined;
          properties.push(`[${JSON.stringify(key)}]: ${schema.required?.includes(key) ? expression : `z.optional(${expression})`}`);
        }
        out = `z.${schema.additionalProperties === false ? "strictObject" : "looseObject"}({ ${properties.join(", ")} })`;
        break;
      }
      case "array": {
        if (Array.isArray(schema.items)) return undefined;
        const item = schema.items === undefined ? "z.any()" : emitValidator(schema.items);
        if (item === undefined) return undefined;
        out = `z.array(${item})`;
        // The official importer only applies these bounds when `items` is declared.
        if (schema.items !== undefined) { check("minItems", "minLength"); check("maxItems", "maxLength"); }
        break;
      }
      default: return undefined;
    }
    return checks.length ? `${out}.check(${checks.join(", ")})` : out;
  };
  let type = schema.type;
  if (schema.nullable === true) type = typeof type === "string" ? [type, "null"] : Array.isArray(type) && !type.includes("null") ? [...type, "null"] : type;
  let expression = base(type);
  if (expression === undefined) return undefined;
  if (schema.readOnly === true) expression = `z.readonly(${expression})`;
  if (schema.default !== undefined) expression = `z._default(${expression}, ${literal(schema.default)})`;
  // ponytail: description is documentation only; boundary validation never reads it.
  return expression;
}

