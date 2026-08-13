/**
 * JSON Schema → zod converter scoped to the v0.1 grammar.
 *
 * Why hand-rolled instead of an off-the-shelf lib:
 *   - `json-schema-to-zod` (npm: 2.x) emits TypeScript source as a
 *     STRING; executing it requires `eval` / `new Function`, which CF
 *     Workers blocks under the default V8 codegen-from-strings policy.
 *     It's a build-time tool, not a runtime converter.
 *   - `@dmitryrechkin/json-schema-to-zod` returns a zod schema OBJECT
 *     at runtime (no codegen), but as of v1.0.1 silently ignores
 *     `minLength` / `maxLength` / `minimum` / `maximum` / `pattern` —
 *     unacceptable for content validation.
 *
 * Workers CSP requires the converter run zero `new Function`. zod's
 * own schema-builder API doesn't codegen — composing `z.object({...})`
 * etc. produces a plain object tree that runs through zod's interpreter
 * at validation time. Wrapping JSON Schema → zod here is therefore
 * Workers-safe.
 *
 * Coverage = exactly the keywords the shipped grammar uses. Unsupported
 * grammar (oneOf / anyOf / $ref / if-then-else) is deliberately rejected.
 */
import { z, type ZodType } from "zod";
import type { JsonSchema } from "../model/ManifestGrammar.js";

/**
 * Convert a JSON Schema object to a zod schema. The result composes
 * zod's own builders (no codegen) so it's safe to call at runtime on
 * Cloudflare Workers (V8 isolate-level codegen-from-strings is off).
 */
export function jsonSchemaToZod(schema: JsonSchema): ZodType {
  const base = buildBase(schema);
  // `nullable: true` is a v0.1 grammar extension on top of plain JSON
  // Schema; without this wrap, a field declared nullable rejects `null`
  // at validation time even though the manifest author opted in.
  return schema.nullable === true ? base.nullable() : base;
}

function buildBase(schema: JsonSchema): ZodType {
  const t = schema.type;

  // Multiple types in `type: [...]` — produce a union over each element.
  if (Array.isArray(t)) {
    const variants = t.map((primitive) =>
      jsonSchemaToZod({ ...schema, type: primitive }),
    ) as [ZodType, ZodType, ...ZodType[]];
    return z.union(variants);
  }

  // Enum on its own line takes precedence over type-derived shapes —
  // an enum already locks down the allowed values.
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return enumLiteralUnion(schema.enum);
  }

  switch (t) {
    case "object":
      return objectShape(schema);
    case "array":
      return arrayShape(schema);
    case "string":
      return stringShape(schema);
    case "number":
      return numberShape(schema, false);
    case "integer":
      return numberShape(schema, true);
    case "boolean":
      return z.boolean();
    case "null":
      return z.null();
    default:
      // No `type` keyword — accept anything. JSON Schema's effective
      // default. A Procedure declared as `output: {}` accepts any
      // return value — that's the spec-correct read of "no type
      // constraint" but may surprise an author who meant "void / empty
      // object". Authors who want stricter shapes should write
      // `output: { type: "null" }` or `output: { type: "object",
      // properties: {} }`.
      return z.unknown();
  }
}

function objectShape(schema: JsonSchema): ZodType {
  const props = schema.properties ?? {};
  const requiredSet = new Set(schema.required ?? []);
  const shape: Record<string, ZodType> = {};
  for (const [key, sub] of Object.entries(props)) {
    const child = jsonSchemaToZod(sub);
    shape[key] = requiredSet.has(key) ? child : child.optional();
  }
  let obj = z.object(shape);
  // `additionalProperties: false` → strict; default + `true` → passthrough
  // is too lax for content validation, default to strip (zod default).
  // `additionalProperties: { ... }` (a value-type schema for extra props)
  // is treated as strip (extra keys removed), NOT validated against the
  // sub-schema. v0.1 starter doesn't use this form; promote when needed.
  if (schema.additionalProperties === false) {
    obj = obj.strict();
  }
  return obj;
}

function arrayShape(schema: JsonSchema): ZodType {
  const itemSchema = schema.items ? jsonSchemaToZod(schema.items) : z.unknown();
  let arr = z.array(itemSchema);
  if (typeof schema.minItems === "number") arr = arr.min(schema.minItems);
  if (typeof schema.maxItems === "number") arr = arr.max(schema.maxItems);
  return arr;
}

function stringShape(schema: JsonSchema): ZodType {
  let s = z.string();
  if (typeof schema.minLength === "number") s = s.min(schema.minLength);
  if (typeof schema.maxLength === "number") s = s.max(schema.maxLength);
  if (typeof schema.pattern === "string") {
    // `new RegExp` throws SyntaxError on a malformed pattern. This runs
    // at zod-BUILD time (before any safeParse), so an uncaught throw
    // here crashes the request handler instead of surfacing a
    // Diagnostic. Pre-deploy `validate` is the real gate (INVALID_PATTERN);
    // at runtime we skip an uncompilable constraint rather than crash.
    try {
      s = s.regex(new RegExp(schema.pattern));
    } catch {
      /* invalid pattern — already an INVALID_PATTERN validate error */
    }
  }
  if (typeof schema.format === "string") {
    switch (schema.format) {
      case "email":
        s = s.email();
        break;
      case "uri":
      case "url":
        s = s.url();
        break;
      case "uuid":
        s = s.uuid();
        break;
      case "date-time":
        s = s.datetime({ offset: true });
        break;
      case "date":
        // zod has no date-only built-in; pattern enforces YYYY-MM-DD
        s = s.regex(/^\d{4}-\d{2}-\d{2}$/, {
          message: "must be a date in YYYY-MM-DD format",
        });
        break;
      // Other formats (hostname, ipv4, etc.) silently no-op — extend
      // when v0.1 grammar adopts them. v0.1 starter only uses email.
    }
  }
  return s;
}

function numberShape(schema: JsonSchema, integer: boolean): ZodType {
  let n = z.number();
  if (integer) n = n.int();
  if (typeof schema.minimum === "number") n = n.gte(schema.minimum);
  if (typeof schema.maximum === "number") n = n.lte(schema.maximum);
  return n;
}

function enumLiteralUnion(values: readonly unknown[]): ZodType {
  // z.enum() only accepts string literals; for mixed/non-string enums
  // fall back to z.literal() union. Single-value enum collapses to
  // z.literal directly to avoid a single-element union.
  if (values.every((v): v is string => typeof v === "string")) {
    return z.enum(values as [string, ...string[]]);
  }
  if (values.length === 1) {
    return z.literal(values[0] as never);
  }
  const literals = values.map((v) => z.literal(v as never)) as unknown as [
    ZodType,
    ZodType,
    ...ZodType[],
  ];
  return z.union(literals);
}

/**
 * Convert a zod issue path (`PropertyKey[]`) to an RFC 6901 JSON
 * Pointer string. Empty path → `""`; `["foo", 0, "bar"]` → `"/foo/0/bar"`;
 * field names containing `/` or `~` are escaped per the spec
 * (`~` → `~0`, `/` → `~1`).
 */
export function zodPathToJsonPointer(path: ReadonlyArray<PropertyKey>): string {
  if (path.length === 0) return "";
  return (
    "/" +
    path
      .map((seg) => String(seg).replace(/~/g, "~0").replace(/\//g, "~1"))
      .join("/")
  );
}

/**
 * Translate a zod `safeParse` failure to the (instancePath, message)
 * shape the dispatcher's diagnostic emitter expects.
 */
export function firstZodIssueAsJsonPointer(
  err: z.ZodError,
): { instancePath: string; message: string } {
  const issue = err.issues[0];
  if (!issue) return { instancePath: "", message: "validation failed" };
  return { instancePath: zodPathToJsonPointer(issue.path), message: issue.message };
}
