/** Schema.spec: its JSON Schema subset, local refs, indexes, search and Admin UI. */
import { MANTLE_BIND_KEYWORD, MANTLE_BIND_VALUES, RESERVED_ENTRY_COLUMNS, RESERVED_PROCEDURE_INPUT_NAMES, type SchemaManifest } from "../model/ManifestGrammar.js";
import { ManifestParseError, V01_LIFECYCLE_MODES, escapeJsonPointerSegment, rejectUnknownKeys, validateLocalizedText } from "./ManifestFieldChecks.js";
import { checkSchemaAdminUi } from "./SchemaAdminUiChecker.js";
import { checkSchemaIndexes, schemaIndexDiagnosticCode } from "./SchemaIndexChecker.js";
import { checkSchemaSearchableFields } from "./SchemaSearchChecker.js";

export function validateSchemaSpec(m: SchemaManifest, idx: number): SchemaManifest {
  const s = m.spec as unknown as Record<string, unknown>;
  rejectUnknownKeys(
    s,
    [
      "title",
      "description",
      "schema",
      "uiSchema",
      "checks",
      "uniqueIndexes",
      "indexes",
      "searchableFields",
      "localized",
      "translates",
      "lifecycle",
      "ttl",
      "scope",
    ],
    idx,
    "/spec",
  );
  if (typeof s["schema"] !== "object" || s["schema"] === null) {
    throw new ManifestParseError("Schema.spec.schema is required", idx, "/spec/schema");
  }
  validateLocalizedText(
    s["title"],
    idx,
    "/spec/title",
    "Schema.spec.title",
    true,
  );
  validateLocalizedText(
    s["description"],
    idx,
    "/spec/description",
    "Schema.spec.description",
    false,
  );
  const indexProblem = checkSchemaIndexes(m).problems[0];
  if (indexProblem) {
    throw new ManifestParseError(
      indexProblem.message,
      idx,
      indexProblem.pointer,
      schemaIndexDiagnosticCode(indexProblem, true),
    );
  }
  const searchProblem = checkSchemaSearchableFields(m)[0];
  if (searchProblem) {
    throw new ManifestParseError(
      searchProblem.message,
      idx,
      searchProblem.pointer,
      searchProblem.category === "shape"
        ? "INVALID_MANIFEST_ENVELOPE"
        : searchProblem.category === "field-unknown"
          ? "SCHEMA_SEARCH_FIELD_UNKNOWN"
          : "SCHEMA_SEARCH_INVALID",
    );
  }
  const adminUiProblem = checkSchemaAdminUi(m).problems[0];
  if (adminUiProblem) {
    throw new ManifestParseError(
      adminUiProblem.message,
      idx,
      adminUiProblem.pointer,
      "SCHEMA_UI_INVALID",
    );
  }
  if ("checks" in s && (!Array.isArray(s["checks"]) || s["checks"].some((c) => typeof c !== "string" || !c.trim()))) {
    throw new ManifestParseError("Schema.spec.checks must be a list of SQL boolean expressions", idx, "/spec/checks");
  }
  if ("localized" in s && typeof s["localized"] !== "boolean") {
    throw new ManifestParseError(
      `Schema.spec.localized must be a boolean; got ${JSON.stringify(s["localized"])}`,
      idx,
      "/spec/localized",
    );
  }
  const schema = s["schema"] as Record<string, unknown>;
  const properties = schema["properties"];
  if (s["ttl"] !== undefined) {
    const ttl = s["ttl"];
    if (!ttl || typeof ttl !== "object" || Array.isArray(ttl)) {
      throw new ManifestParseError("Schema.spec.ttl must be a mapping", idx, "/spec/ttl", "SCHEMA_TTL_INVALID");
    }
    const policy = ttl as Record<string, unknown>;
    rejectUnknownKeys(policy, ["field", "expireAfterSeconds"], idx, "/spec/ttl");
    const field = policy["field"];
    const seconds = policy["expireAfterSeconds"];
    const property = typeof field === "string" && properties && typeof properties === "object" && !Array.isArray(properties)
      ? (properties as Record<string, Record<string, unknown>>)[field] : undefined;
    const types = property && (typeof property["type"] === "string" ? [property["type"]] : property["type"]);
    if (typeof field !== "string" || !field || !property || property["format"] !== "date-time" ||
      !Array.isArray(types) || !types.includes("string") || types.some((type) => type !== "string" && type !== "null") ||
      typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0 || seconds > Number.MAX_SAFE_INTEGER / 1000) {
      throw new ManifestParseError("Schema.spec.ttl requires a top-level date-time string field and finite nonnegative expireAfterSeconds", idx, "/spec/ttl", "SCHEMA_TTL_INVALID");
    }
  }
  const propertyNames = properties && typeof properties === "object" && !Array.isArray(properties)
    ? Object.keys(properties)
    : [];
  if (s["scope"] !== undefined) {
    const scope = s["scope"];
    if (!scope || typeof scope !== "object" || Array.isArray(scope) || Object.keys(scope).length !== 1) {
      throw new ManifestParseError("Schema.spec.scope must bind exactly one field to auth.uid()", idx, "/spec/scope");
    }
    const [field, ref] = Object.entries(scope)[0]!;
    const property = properties && typeof properties === "object" && !Array.isArray(properties)
      ? (properties as Record<string, Record<string, unknown>>)[field] : undefined;
    if (ref !== "auth.uid()" || !property || property["type"] !== "string" || property["nullable"] === true || property["oneOf"] !== undefined ||
      !Array.isArray(schema["required"]) || !schema["required"].includes(field) ||
      ![...(m.spec.uniqueIndexes ?? []), ...(m.spec.indexes ?? [])].some((index) => index[0] === field)) {
      throw new ManifestParseError("Schema.spec.scope requires a required string field with a leftmost index and the exact auth.uid() reference", idx, "/spec/scope");
    }
    if (property[MANTLE_BIND_KEYWORD] !== undefined && property[MANTLE_BIND_KEYWORD] !== "ctx.user") {
      throw new ManifestParseError("Schema.spec.scope field cannot be stamped from a different identity", idx, `/spec/schema/properties/${field}/${MANTLE_BIND_KEYWORD}`);
    }
    if ((m.spec.uniqueIndexes ?? []).some((index) => index[0] !== field)) {
      throw new ManifestParseError("Scoped Schema unique indexes must begin with the scope field", idx, "/spec/uniqueIndexes");
    }
  }
  if (s["localized"] !== true && propertyNames.includes("locale")) {
    throw new ManifestParseError(
      "Non-localized Schema must not declare the reserved entry field 'locale'; use a domain name such as 'orderLocale', or set localized: true.",
      idx,
      "/spec/schema/properties/locale",
    );
  }
  for (const reserved of RESERVED_ENTRY_COLUMNS) {
    if (!propertyNames.includes(reserved)) continue;
    throw new ManifestParseError(
      `Schema '${m.metadata.name}' must not declare the native entry column '${reserved}' as a data property; use a domain name such as 'submittedAt' or 'orderStatus'. Native columns are readable in Views and indexable through spec.indexes without being declared (handbook: reference/schema.md#reserved-entry-columns).`,
      idx,
      `/spec/schema/properties/${reserved}`,
    );
  }
  for (const reserved of RESERVED_PROCEDURE_INPUT_NAMES) {
    if (!propertyNames.includes(reserved)) continue;
    throw new ManifestParseError(
      `Schema '${m.metadata.name}' must not declare reserved Procedure input name '${reserved}' as a data property (ADR-0022). New reserved names need an ADR.`,
      idx,
      `/spec/schema/properties/${reserved}`,
    );
  }
  const required = schema["required"];
  if (Array.isArray(required)) {
    const unknownIndex = required.findIndex((field) =>
      typeof field === "string" && !propertyNames.includes(field)
    );
    if (unknownIndex >= 0) {
      const field = required[unknownIndex];
      throw new ManifestParseError(
        `Schema '${m.metadata.name}' lists '${String(field)}' in required but never declares it under properties — the constraint is silently unenforced.`,
        idx,
        `/spec/schema/required/${unknownIndex}`,
        "REQUIRED_FIELD_UNKNOWN",
        {
          value: field,
          expected: "name of a property declared in spec.schema.properties",
          candidates: propertyNames,
        },
      );
    }
  }
  validateJsonSchema(s["schema"], idx, "Schema", m.metadata.name, "/spec/schema");
  if (properties && typeof properties === "object" && !Array.isArray(properties)) {
    for (const [propertyName, property] of Object.entries(properties)) {
      if (!property || typeof property !== "object" || Array.isArray(property)) continue;
      const bind = (property as Record<string, unknown>)["x-mantle-bind"];
      if (typeof bind === "string" && !(MANTLE_BIND_VALUES as readonly string[]).includes(bind)) {
        throw new ManifestParseError(
          `Schema '${m.metadata.name}' property '${propertyName}' has illegal x-mantle-bind value.`,
          idx,
          `/spec/schema/properties/${propertyName}/x-mantle-bind`,
          "BIND_VALUE_NOT_IN_ENUM",
          {
            value: bind,
            expected: `one of ${MANTLE_BIND_VALUES.join(", ")}`,
            candidates: [...MANTLE_BIND_VALUES],
          },
        );
      }
    }
  }
  if ("lifecycle" in s) {
    const lc = s["lifecycle"];
    if (typeof lc !== "string" || !V01_LIFECYCLE_MODES.has(lc)) {
      throw new ManifestParseError(
        `Schema.spec.lifecycle must be one of ${[...V01_LIFECYCLE_MODES].join(", ")}; got ${JSON.stringify(lc)}`,
        idx,
        "/spec/lifecycle",
      );
    }
  }
  if ("translates" in s && s["translates"] != null) {
    const t = s["translates"];
    if (typeof t !== "object" || Array.isArray(t)) {
      throw new ManifestParseError(
        "Schema.spec.translates must be an object { parent, on }",
        idx,
        "/spec/translates",
      );
    }
    const tr = t as Record<string, unknown>;
    rejectUnknownKeys(tr, ["parent", "on"], idx, "/spec/translates");
    if (typeof tr["parent"] !== "string" || (tr["parent"] as string).length === 0) {
      throw new ManifestParseError(
        "Schema.spec.translates.parent is required (non-empty Schema name)",
        idx,
        "/spec/translates/parent",
      );
    }
    if (typeof tr["on"] !== "string" || (tr["on"] as string).length === 0) {
      throw new ManifestParseError(
        "Schema.spec.translates.on is required (non-empty field name)",
        idx,
        "/spec/translates/on",
      );
    }
    if (s["localized"] !== true) {
      throw new ManifestParseError(
        "Schema.spec.translates requires Schema.spec.localized: true (a non-localized translation table is meaningless)",
        idx,
        "/spec/translates",
        "TRANSLATES_REQUIRES_LOCALIZED",
      );
    }
    if (!propertyNames.some((name) => name !== "locale" && name !== tr["on"])) {
      throw new ManifestParseError(
        "Schema.spec.translates requires at least one locale-specific field besides 'locale' and the join field",
        idx,
        "/spec/schema/properties",
        "TRANSLATES_REQUIRES_CONTENT_FIELD",
      );
    }
    if (!propertyNames.includes(tr["on"] as string)) {
      throw new ManifestParseError(
        `Schema '${m.metadata.name}' translates.on field '${String(tr["on"])}' is not declared on this Schema's own properties.`,
        idx,
        "/spec/translates/on",
        "TRANSLATES_FIELD_NOT_IN_CHILD",
        {
          value: tr["on"],
          expected: `field declared in Schema '${m.metadata.name}' spec.schema.properties`,
          candidates: propertyNames,
        },
      );
    }
  }
  return m;
}

const UNSUPPORTED_JSON_SCHEMA_KEYWORDS = new Set([
  "anyOf",
  "allOf",
  "not",
  "if",
  "then",
  "else",
  "$anchor",
  "$dynamicAnchor",
  "$dynamicRef",
  "definitions",
  "patternProperties",
  "prefixItems",
  "contains",
  "dependentSchemas",
  "propertyNames",
  "unevaluatedProperties",
]);

export function validateJsonSchema(
  root: unknown,
  idx: number,
  kind: "Schema" | "View" | "Procedure",
  name: string,
  basePointer: string,
): void {
  if (!root || typeof root !== "object" || Array.isArray(root)) {
    throw new ManifestParseError(`${kind} '${name}' JSON Schema must be an object`, idx, basePointer);
  }
  const rootObject = root as Record<string, unknown>;
  let nodes = 0;
  const visit = (node: unknown, pointer: string, depth: number): void => {
    if (!node || typeof node !== "object" || Array.isArray(node)) {
      throw new ManifestParseError(`${kind} '${name}' has a non-object JSON Schema at ${pointer}`, idx, pointer);
    }
    if (depth > 100 || ++nodes > 10_000) {
      throw new ManifestParseError(
        `${kind} '${name}' exceeds the JSON Schema complexity limit`,
        idx,
        pointer,
        "JSON_SCHEMA_LIMIT_EXCEEDED",
      );
    }
    const value = node as Record<string, unknown>;
    for (const keyword of UNSUPPORTED_JSON_SCHEMA_KEYWORDS) {
      if (keyword in value) {
        throw new ManifestParseError(
          `${kind} '${name}' uses unsupported JSON Schema keyword '${keyword}'`,
          idx,
          `${pointer}/${escapeJsonPointerSegment(keyword)}`,
          "JSON_SCHEMA_UNSUPPORTED",
        );
      }
    }
    if ("$ref" in value) validateLocalSchemaRef(value["$ref"], rootObject, idx, kind, name, `${pointer}/$ref`);
    if (typeof value["pattern"] === "string") {
      try {
        new RegExp(value["pattern"]);
      } catch (error) {
        throw new ManifestParseError(
          `${kind} '${name}' has an uncompilable regex pattern at ${pointer}: ${error instanceof Error ? error.message : String(error)}`,
          idx,
          `${pointer}/pattern`,
          "INVALID_PATTERN",
          {
            value: value["pattern"],
            expected: "a valid JavaScript regular expression",
          },
        );
      }
    }
    const properties = value["properties"];
    if (properties !== undefined && (!properties || typeof properties !== "object" || Array.isArray(properties))) {
      throw new ManifestParseError(`${kind} '${name}' properties must be an object`, idx, `${pointer}/properties`);
    }
    if (properties && typeof properties === "object") {
      for (const [property, child] of Object.entries(properties)) {
        visit(child, `${pointer}/properties/${escapeJsonPointerSegment(property)}`, depth + 1);
      }
    }
    if (value["items"] !== undefined) visit(value["items"], `${pointer}/items`, depth + 1);
    if (typeof value["additionalProperties"] === "object" && value["additionalProperties"] !== null) {
      visit(value["additionalProperties"], `${pointer}/additionalProperties`, depth + 1);
    } else if (
      value["additionalProperties"] !== undefined &&
      typeof value["additionalProperties"] !== "boolean"
    ) {
      throw new ManifestParseError(
        `${kind} '${name}' additionalProperties must be a boolean or schema`,
        idx,
        `${pointer}/additionalProperties`,
      );
    }
    const defs = value["$defs"];
    if (defs !== undefined) {
      if (!defs || typeof defs !== "object" || Array.isArray(defs)) {
        throw new ManifestParseError(`${kind} '${name}' $defs must be an object`, idx, `${pointer}/$defs`);
      }
      for (const [definition, child] of Object.entries(defs)) {
        visit(child, `${pointer}/$defs/${escapeJsonPointerSegment(definition)}`, depth + 1);
      }
    }
    const oneOf = value["oneOf"];
    if (oneOf !== undefined) {
      if (!Array.isArray(oneOf) || oneOf.length === 0) {
        throw new ManifestParseError(`${kind} '${name}' oneOf must be a non-empty array`, idx, `${pointer}/oneOf`);
      }
      oneOf.forEach((child, index) => visit(child, `${pointer}/oneOf/${index}`, depth + 1));
    }
  };
  visit(root, basePointer, 0);
}

function validateLocalSchemaRef(
  ref: unknown,
  root: Record<string, unknown>,
  idx: number,
  kind: "Schema" | "View" | "Procedure",
  name: string,
  pointer: string,
): void {
  if (typeof ref !== "string" || !ref.startsWith("#/$defs/")) {
    throw new ManifestParseError(
      `${kind} '${name}' $ref must be a same-document pointer beginning '#/$defs/'`,
      idx,
      pointer,
      "JSON_SCHEMA_REF_INVALID",
      { value: ref, expected: "#/$defs/<definition>" },
    );
  }
  let tokens: string[] | undefined;
  try {
    tokens = decodeURIComponent(ref.slice(2)).split("/");
  } catch {
    tokens = undefined;
  }
  let current: unknown = tokens ? root : undefined;
  for (const token of tokens ?? []) {
    if (/~(?:[^01]|$)/.test(token)) current = undefined;
    else if (current && typeof current === "object") {
      const key = token.replace(/~1/g, "/").replace(/~0/g, "~");
      current = Object.prototype.hasOwnProperty.call(current, key)
        ? (current as Record<string, unknown>)[key]
        : undefined;
    } else current = undefined;
  }
  if (!current || typeof current !== "object" || Array.isArray(current)) {
    throw new ManifestParseError(
      `${kind} '${name}' cannot resolve local $ref '${ref}'`,
      idx,
      pointer,
      "JSON_SCHEMA_REF_INVALID",
      { value: ref, expected: "a JSON Schema object in this document" },
    );
  }
}
