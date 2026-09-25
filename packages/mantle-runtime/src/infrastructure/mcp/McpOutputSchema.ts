import { resolveLocalizedText, type JsonSchema, type LocalizedText } from "@aotter/mantle-spec";

/**
 * Project a Procedure's declared `output` into an MCP tool `outputSchema`.
 *
 * MCP clients validate `structuredContent` against the advertised schema with
 * a standard JSON Schema validator (the official SDKs use Ajv), while Runtime
 * validates handler output with `jsonSchemaToZod`. An advertised schema is
 * therefore a promise: every value Runtime accepts must also pass the
 * client's validator. The two engines disagree on some keywords (for example
 * `uniqueItems`, `contains`, `minProperties`, `pattern` (no `u` flag in
 * Runtime), `multipleOf` on decimals, a `required` field with a `default`,
 * keywords on a node without `type`, constraints beside `enum`/`const`, root
 * `$ref`, overlapping `oneOf`), so this is an allowlist, not a pass-through:
 *
 * - the root is exactly `type: object`;
 * - each node names its `type` and uses only keywords whose semantics
 *   agree, each on a node of the matching type; an `enum`/`const` node
 *   advertises only its values, which is all Runtime checks there;
 * - `$ref` stands alone and points into the root `$defs`;
 * - `oneOf` is not projected;
 * - `format` and `x-*` extensions are dropped, `nullable` becomes a `null`
 *   type member, localized `title`/`description` collapse to English,
 *   `required` keeps only declared properties without a `default`, and array
 *   bounds without an `items` schema are dropped (Runtime ignores them);
 * - an `items` schema with a `default` is not projected, since Runtime then
 *   accepts `undefined` elements that JSON serializes as `null`.
 *
 * Every rewrite only loosens the schema. A schema outside the allowlist
 * returns `undefined` and the tool advertises no `outputSchema`; Runtime still
 * enforces the full declared schema either way.
 */
export function projectMcpOutputSchema(output: JsonSchema): Record<string, unknown> | undefined {
  // One tool's malformed output declaration must never break tools/list.
  try {
    return projectRoot(output);
  } catch {
    return undefined;
  }
}

function projectRoot(output: JsonSchema): Record<string, unknown> | undefined {
  if (!isRecord(output)) return undefined;
  if (output.$ref !== undefined || output.enum !== undefined || output.const !== undefined
    || output.nullable === true || !sameTypes(output.type, ["object"])) {
    return undefined;
  }
  const defs = output.$defs;
  const projectedDefs: Record<string, unknown> = {};
  if (defs !== undefined) {
    if (!isRecord(defs) || hasRefOnlyCycle(defs)) return undefined;
    for (const [name, child] of Object.entries(defs)) {
      const projected = projectNode(child, defs);
      if (!projected) return undefined;
      projectedDefs[name] = projected;
    }
  }
  const { $defs: _defs, ...root } = output;
  const projected = projectNode(root as JsonSchema, defs ?? {});
  if (!projected) return undefined;
  return defs !== undefined ? { ...projected, $defs: projectedDefs } : projected;
}

const ANNOTATIONS = new Set(["title", "description", "default", "readOnly", "examples", "deprecated", "$comment"]);
const DROPPED = new Set(["format", "nullable"]);
const KEYWORD_TYPES: Readonly<Record<string, readonly string[]>> = {
  properties: ["object"],
  required: ["object"],
  additionalProperties: ["object"],
  items: ["array"],
  minItems: ["array"],
  maxItems: ["array"],
  minLength: ["string"],
  maxLength: ["string"],
  minimum: ["number", "integer"],
  maximum: ["number", "integer"],
  exclusiveMinimum: ["number", "integer"],
  exclusiveMaximum: ["number", "integer"],
};
const isNonNegativeInteger = (value: unknown): boolean => Number.isInteger(value) && (value as number) >= 0;
const isFiniteNumber = (value: unknown): boolean => typeof value === "number" && Number.isFinite(value);
/** Values an Ajv client can compile. Anything else withholds the schema. */
const VALUE_CHECKS: Readonly<Record<string, (value: unknown) => boolean>> = {
  properties: isRecord,
  required: (value) => Array.isArray(value) && value.every((item) => typeof item === "string"),
  additionalProperties: (value) => typeof value === "boolean" || isRecord(value),
  items: isRecord,
  minItems: isNonNegativeInteger,
  maxItems: isNonNegativeInteger,
  minLength: isNonNegativeInteger,
  maxLength: isNonNegativeInteger,
  minimum: isFiniteNumber,
  maximum: isFiniteNumber,
  exclusiveMinimum: isFiniteNumber,
  exclusiveMaximum: isFiniteNumber,
  readOnly: (value) => typeof value === "boolean",
  deprecated: (value) => typeof value === "boolean",
  examples: Array.isArray,
  $comment: (value) => typeof value === "string",
};
const TYPE_NAMES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);

function projectNode(
  node: JsonSchema,
  defs: Readonly<Record<string, JsonSchema>>,
): Record<string, unknown> | undefined {
  if (!isRecord(node)) return undefined;
  if (node.$ref !== undefined) return projectRef(node, defs);
  if (node.enum !== undefined || node.const !== undefined) return projectLiteral(node);
  const types = typeList(node.type);
  if (types === undefined) return undefined;
  if (types.length === 0) return undefined;

  const out: Record<string, unknown> = {};
  for (const [keyword, value] of Object.entries(node)) {
    if (keyword.startsWith("x-") || DROPPED.has(keyword)) continue;
    if (keyword === "title" || keyword === "description") {
      const text = resolveLocalizedText(value as LocalizedText, "en");
      if (text !== undefined) out[keyword] = text;
      continue;
    }
    if (VALUE_CHECKS[keyword] && !VALUE_CHECKS[keyword](value)) return undefined;
    if (ANNOTATIONS.has(keyword)) {
      out[keyword] = value;
      continue;
    }
    if (keyword === "type") continue;
    const requiredTypes = KEYWORD_TYPES[keyword];
    if (!requiredTypes || !requiredTypes.some((type) => types.includes(type))) return undefined;
    out[keyword] = value;
  }

  const withNull = node.nullable === true && !types.includes("null") ? [...types, "null"] : types;
  out["type"] = withNull.length === 1 ? withNull[0] : withNull;

  if (node.properties !== undefined) {
    const properties: Record<string, unknown> = {};
    for (const [name, child] of Object.entries(node.properties)) {
      const projected = projectNode(child, defs);
      if (!projected) return undefined;
      properties[name] = projected;
    }
    out["properties"] = properties;
  }
  if (node.required !== undefined) {
    // Runtime's validator ignores `required` names without a declared
    // property, and accepts a missing property that has a `default` (it
    // validates the raw handler value, so the default never reaches the
    // wire). Neither may stay required for a JSON Schema validator.
    out["required"] = [...new Set(node.required)].filter((name) => {
      const property = node.properties?.[name];
      return property !== undefined && !hasDefault(property, defs);
    });
  }
  if (typeof node.additionalProperties === "object") {
    const projected = projectNode(node.additionalProperties, defs);
    if (!projected) return undefined;
    out["additionalProperties"] = projected;
  }
  if (node.items === undefined) {
    // Runtime ignores array bounds when no `items` schema is declared.
    delete out["minItems"];
    delete out["maxItems"];
  } else {
    // A defaulted item schema lets Runtime accept `undefined` elements, which
    // JSON serializes as `null`.
    if (hasDefault(node.items, defs)) return undefined;
    const projected = projectNode(node.items, defs);
    if (!projected) return undefined;
    out["items"] = projected;
  }
  return out;
}

/** Runtime's validator checks only the listed values of an `enum`/`const`
 *  node and ignores its `type` and other constraints, so only the values are
 *  advertised. */
function projectLiteral(node: JsonSchema): Record<string, unknown> | undefined {
  if (node.nullable === true) return undefined;
  // With both present Runtime checks only `enum`; advertising `const` too
  // would be stricter than Runtime.
  if (node.enum !== undefined && node.const !== undefined) return undefined;
  if (node.enum !== undefined && (!Array.isArray(node.enum) || node.enum.length === 0)) return undefined;
  const out: Record<string, unknown> = {};
  for (const [keyword, value] of Object.entries(node)) {
    if (VALUE_CHECKS[keyword] && !VALUE_CHECKS[keyword](value)) return undefined;
    if (keyword === "enum" || keyword === "const") {
      out[keyword] = value;
    } else if (keyword === "title" || keyword === "description") {
      const text = resolveLocalizedText(value as LocalizedText, "en");
      if (text !== undefined) out[keyword] = text;
    } else if (ANNOTATIONS.has(keyword)) {
      out[keyword] = value;
    }
  }
  return out;
}

function projectRef(
  node: JsonSchema,
  defs: Readonly<Record<string, JsonSchema>>,
): Record<string, unknown> | undefined {
  const ref = node.$ref;
  if (typeof ref !== "string" || !ref.startsWith("#/$defs/")) return undefined;
  const name = ref.slice("#/$defs/".length);
  if (name.includes("/") || !(name in defs)) return undefined;
  const out: Record<string, unknown> = { $ref: ref };
  for (const [keyword, value] of Object.entries(node)) {
    if (keyword === "$ref" || keyword.startsWith("x-")) continue;
    if (VALUE_CHECKS[keyword] && !VALUE_CHECKS[keyword](value)) return undefined;
    if (keyword === "title" || keyword === "description") {
      const text = resolveLocalizedText(value as LocalizedText, "en");
      if (text !== undefined) out[keyword] = text;
      continue;
    }
    if (!ANNOTATIONS.has(keyword)) return undefined;
    out[keyword] = value;
  }
  return out;
}

/** A definition that is only a `$ref` and leads back to itself (`A → A`,
 *  `A → B → A`). Recursion through an object or array is fine; a loop of
 *  bare references has no schema at its end and overflows Ajv's compiler. */
function hasRefOnlyCycle(defs: Readonly<Record<string, JsonSchema>>): boolean {
  return Object.keys(defs).some((start) => {
    const seen = new Set<string>();
    let name: string | undefined = start;
    while (name !== undefined) {
      if (seen.has(name)) return true;
      seen.add(name);
      const ref: unknown = defs[name]?.$ref;
      name = typeof ref === "string" && ref.startsWith("#/$defs/") ? ref.slice("#/$defs/".length) : undefined;
    }
    return false;
  });
}

/** Whether Runtime can fill this property: a `default` on it or on any
 *  definition its `$ref` chain reaches. */
function hasDefault(node: JsonSchema, defs: Readonly<Record<string, JsonSchema>>): boolean {
  const seen = new Set<string>();
  let current: JsonSchema | undefined = node;
  while (current) {
    if (current.default !== undefined) return true;
    const ref: unknown = current.$ref;
    if (typeof ref !== "string" || seen.has(ref)) return false;
    seen.add(ref);
    current = defs[ref.slice("#/$defs/".length)];
  }
  return false;
}

/** `[]` when `type` is absent; `undefined` when it names something unknown. */
function typeList(type: JsonSchema["type"]): string[] | undefined {
  if (type === undefined) return [];
  if (typeof type !== "string" && !Array.isArray(type)) return undefined;
  const list: string[] = typeof type === "string" ? [type] : [...type];
  if (list.length === 0 || new Set(list).size !== list.length) return undefined;
  return list.every((item) => typeof item === "string" && TYPE_NAMES.has(item)) ? list : undefined;
}

function sameTypes(type: JsonSchema["type"], expected: readonly string[]): boolean {
  const list = typeList(type);
  return list !== undefined && list.length === expected.length && expected.every((item) => list.includes(item));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
