/** Generate official Zod construction, never a second value validator. Unsupported schemas use the ordinary importer. */
import type { JsonSchema, RuntimePlan } from "../spec/domain/index.js";

const keys = new Set(["type", "properties", "required", "additionalProperties", "items", "minItems", "maxItems", "minLength", "maxLength", "pattern", "format", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "enum", "const", "default", "readOnly", "nullable", "title", "description"]);
const formats: Readonly<Record<string, string>> = {
  email: "z.email()", uri: "z.url()", "uri-reference": "z.url()", url: "z.url()", uuid: "z.uuid()", guid: "z.uuid()",
  "date-time": "z.iso.datetime({ offset: true })", date: "z.iso.date()", duration: "z.iso.duration()", hostname: "z.hostname()", ipv4: "z.ipv4()", ipv6: "z.ipv6()",
};
const literal = (v: unknown): string => v !== null && typeof v === "object" ? `JSON.parse(${JSON.stringify(JSON.stringify(v))})` : JSON.stringify(v) ?? "undefined";

/** An expression using the official constructor order of z.fromJSONSchema; undefined selects its complete fallback. */
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
    const number = (key: keyof JsonSchema, method: string) => { if (typeof schema[key] === "number") out += `.${method}(${schema[key]})`; };
    switch (type) {
      case undefined: return "z.any()";
      case "string":
        out = "z.string()";
        if (schema.format) {
          if (!Object.hasOwn(formats, schema.format)) return undefined;
          out += `.check(${formats[schema.format]})`;
        }
        number("minLength", "min"); number("maxLength", "max");
        if (schema.pattern) out += `.regex(new RegExp(${literal(schema.pattern)}))`;
        break;
      case "integer": case "number":
        out = type === "integer" ? "z.number().int()" : "z.number()";
        if (schema.exclusiveMinimum !== true) number("minimum", "min");
        if (schema.exclusiveMaximum !== true) number("maximum", "max");
        if (typeof schema.exclusiveMinimum === "number") number("exclusiveMinimum", "gt");
        else if (schema.exclusiveMinimum === true) number("minimum", "gt");
        if (typeof schema.exclusiveMaximum === "number") number("exclusiveMaximum", "lt");
        else if (schema.exclusiveMaximum === true) number("maximum", "lt");
        number("multipleOf", "multipleOf");
        break;
      case "boolean": return "z.boolean()";
      case "null": return "z.null()";
      case "object": {
        if (typeof schema.additionalProperties === "object") return undefined;
        const properties: string[] = [];
        for (const [key, child] of Object.entries(schema.properties ?? {})) {
          const expression = emitValidator(child);
          if (expression === undefined) return undefined;
          properties.push(`[${JSON.stringify(key)}]: ${expression}${schema.required?.includes(key) ? "" : ".optional()"}`);
        }
        out = `z.object({ ${properties.join(", ")} }).${schema.additionalProperties === false ? "strict" : "passthrough"}()`;
        break;
      }
      case "array": {
        if (Array.isArray(schema.items)) return undefined;
        const item = schema.items === undefined ? "z.any()" : emitValidator(schema.items);
        if (item === undefined) return undefined;
        out = `z.array(${item})`;
        // The official importer only applies these bounds when `items` is declared.
        if (schema.items !== undefined) { number("minItems", "min"); number("maxItems", "max"); }
        break;
      }
      default: return undefined;
    }
    return out;
  };
  let type = schema.type;
  if (schema.nullable === true) type = typeof type === "string" ? [type, "null"] : Array.isArray(type) && !type.includes("null") ? [...type, "null"] : type;
  let expression = base(type);
  if (expression === undefined) return undefined;
  if (schema.readOnly === true) expression += ".readonly()";
  if (schema.default !== undefined) expression += `.default(${literal(schema.default)})`;
  if (schema.description) expression += `.describe(${literal(schema.description)})`;
  return expression;
}

/** Factories run on first validation through planValidators, never at generated-module load. */
export function emitValidators(plan: RuntimePlan): string | undefined {
  const factory = (schema: JsonSchema): string | undefined => {
    const expression = emitValidator(schema);
    return expression === undefined ? undefined : `() => jsonSchemaValidator((z) => ${expression})`;
  };
  const procedures = Object.entries(plan.procedures).flatMap(([name, p]) => {
    const fields = (["input", "output"] as const).flatMap((kind) => { const f = factory(p[kind]); return f ? [`${kind}: ${f}`] : []; });
    return fields.length ? [`[${JSON.stringify(name)}]: { ${fields.join(", ")} }`] : [];
  });
  const views = Object.entries(plan.views).flatMap(([name, v]) => { const f = v.input && factory(v.input); return f ? [`[${JSON.stringify(name)}]: ${f}`] : []; });
  return procedures.length || views.length ? `{ procedure: { ${procedures.join(", ")} }, view: { ${views.join(", ")} } }` : undefined;
}
