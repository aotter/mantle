/** Schema.spec: its JSON Schema subset, local refs, indexes, search and Admin UI. */
import { MANTLE_BIND_KEYWORD, RESERVED_ENTRY_COLUMNS, RESERVED_PROCEDURE_INPUT_NAMES, type SchemaManifest } from "../model/ManifestGrammar.js";
import { ManifestParseError, V01_LIFECYCLE_MODES, escapeJsonPointerSegment, rejectUnknownKeys, validateLocalizedText } from "./ManifestFieldChecks.js";
import { checkSchemaAdminUi } from "./SchemaAdminUiChecker.js";
import { checkSchemaIndexes, schemaIndexDiagnosticCode } from "./SchemaIndexChecker.js";
import { checkSchemaSearchableFields } from "./SchemaSearchChecker.js";
import { MAX_TTL_SECONDS, isTtlSeconds } from "./SqlTypes.js";

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
      !isTtlSeconds(seconds)) {
      throw new ManifestParseError(`Schema.spec.ttl requires a top-level date-time string field and expireAfterSeconds a whole number from 0 to ${MAX_TTL_SECONDS}`, idx, "/spec/ttl", "SCHEMA_TTL_INVALID");
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
      // 0.1.x stamped the field on write; 0.2.0 stamps nothing from it, so accepting it would leave the field caller-supplied
      if (MANTLE_BIND_KEYWORD in property) {
        throw new ManifestParseError(
          `Schema '${m.metadata.name}' property '${propertyName}': x-mantle-bind is removed. Use spec.scope for the caller's own field, or set it in the Procedure's SQL (auth.uid(), now()).`,
          idx,
          `/spec/schema/properties/${propertyName}/${MANTLE_BIND_KEYWORD}`,
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
  /** every `$ref`: where it is, what it says, and the schema it resolves to */
  const refs: [string, string, Record<string, unknown>][] = [];
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
    if ("$ref" in value) refs.push([`${pointer}/$ref`, value["$ref"] as string, validateLocalSchemaRef(value["$ref"], rootObject, idx, kind, name, `${pointer}/$ref`)]);
    if (value["enum"] !== undefined && (!Array.isArray(value["enum"]) || value["enum"].length > MAX_JSON_SCHEMA_ENUM)) {
      throw new ManifestParseError(
        `${kind} '${name}' enum must be a list of at most ${MAX_JSON_SCHEMA_ENUM} values`,
        idx,
        `${pointer}/enum`,
        "JSON_SCHEMA_LIMIT_EXCEEDED",
      );
    }
    if (value["pattern"] !== undefined) {
      const problem = typeof value["pattern"] === "string" ? unsafePattern(value["pattern"]) : "a pattern is a string";
      if (problem) {
        throw new ManifestParseError(
          `${kind} '${name}' has a regex pattern at ${pointer} that could take exponential time: ${problem}`,
          idx,
          `${pointer}/pattern`,
          "INVALID_PATTERN",
          { value: value["pattern"], expected: `a regular expression of at most ${MAX_JSON_SCHEMA_PATTERN} characters with no repeated group that itself repeats or alternates` },
        );
      }
      try {
        new RegExp(value["pattern"] as string);
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
      // Adjacent variable quantifiers (`a*a*a*`, `\w*\w*`, `.*.*`) backtrack polynomially: maxLength^k on a string that fails
      const k = variableQuantifiers(value["pattern"] as string);
      const maxLength = value["maxLength"];
      if (k > 0 && !(typeof maxLength === "number" && Number.isInteger(maxLength) && maxLength >= 0 && maxLength ** k <= MAX_PATTERN_WORK)) {
        const limit = maxPatternLength(k);
        const quantifiers = `${k} variable quantifier${k === 1 ? "" : "s"} (*, +, ?, {m,} or {m,n})`;
        throw new ManifestParseError(
          typeof maxLength === "number"
            ? `${kind} '${name}' has a regex pattern at ${pointer} with ${quantifiers} and maxLength ${maxLength}: a caller's string could cost maxLength^${k} backtracking steps, over the ${MAX_PATTERN_WORK} limit. Declare maxLength of at most ${limit}, or use fewer variable quantifiers.`
            : `${kind} '${name}' has a regex pattern at ${pointer} with ${quantifiers} but no maxLength: a caller's string of any length could cost length^${k} backtracking steps. Declare maxLength of at most ${limit} (maxLength^${k} ≤ ${MAX_PATTERN_WORK}), or use fewer variable quantifiers.`,
          idx,
          `${pointer}/pattern`,
          "INVALID_PATTERN",
          { value: value["pattern"], expected: `a string with maxLength of at most ${limit}` },
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
  // A `$ref` that reaches itself through `$ref` and `oneOf` alone never reaches a value: the validator would recurse until the
  // stack overflows on every call. A cycle through `properties`, `items` or `additionalProperties` reads one level of the value
  // each turn, so it ends with the value.
  const target = new Map(refs.map(([, ref, node]) => [ref, node]));
  const next = (node: unknown): unknown[] => !node || typeof node !== "object" ? [] : [
    ...("$ref" in node ? [(node as Record<string, unknown>)["$ref"]] : []),
    ...(Array.isArray((node as Record<string, unknown>)["oneOf"]) ? ((node as Record<string, unknown>)["oneOf"] as unknown[]).flatMap(next) : []),
  ];
  const done = new Set<unknown>();
  const onPath = new Set<unknown>();
  let at = basePointer;
  const cycle = (ref: unknown): boolean => {
    if (onPath.has(ref)) return true;
    if (done.has(ref)) return false;
    onPath.add(ref);
    // a target outside the schemas visited above (a `$ref` into an `enum` value) is resolved by the same rule
    const node = typeof ref === "string" && target.has(ref) ? target.get(ref) : validateLocalSchemaRef(ref, rootObject, idx, kind, name, at);
    const found = next(node).some(cycle);
    onPath.delete(ref);
    done.add(ref);
    return found;
  };
  for (const [pointer, ref] of refs) {
    at = pointer;
    if (cycle(ref)) {
      throw new ManifestParseError(
        `${kind} '${name}' $ref '${ref}' refers back to itself without reading any part of the value`,
        idx,
        pointer,
        "JSON_SCHEMA_REF_INVALID",
        { value: ref, expected: "a $ref cycle only through properties, items or additionalProperties" },
      );
    }
  }
}

/** The most values one `enum` lists. */
export const MAX_JSON_SCHEMA_ENUM = 1_000;
/** The longest `pattern`. */
export const MAX_JSON_SCHEMA_PATTERN = 1_000;

/**
 * Why a JSON Schema `pattern` could backtrack exponentially (or undefined): a JavaScript regex backtracks, and a caller's string
 * runs it on every call. Refused, conservatively: a group repeated more than once whose body itself repeats a variable number of
 * times (`(a+)+`, `(a*b?)*`, `((ab)+c)+`) or alternates (`(a|ab)+`), and a backreference. Character classes and escapes are atoms.
 */
export function unsafePattern(pattern: string): string | undefined {
  return scanPattern(pattern).problem;
}

/**
 * How many quantifiers in `pattern` repeat a variable number of times — `*`, `+`, `?`, `{m,}` and `{m,n}` with m ≠ n — outside
 * character classes and escapes; a quantifier on a group counts once, and each one inside it counts too. A regex can backtrack
 * through about maxLength^k ways of splitting a string between k of them (`^a*a*a*$`), so the work bound below is maxLength^k.
 */
export function variableQuantifiers(pattern: string): number {
  return scanPattern(pattern).variable;
}

/** The most backtracking steps a `pattern` may cost on one string: maxLength^k, k its variable quantifiers. */
export const MAX_PATTERN_WORK = 10_000_000;

/** The longest maxLength a pattern with `k` variable quantifiers may declare: the largest n with n^k ≤ MAX_PATTERN_WORK. */
export function maxPatternLength(k: number): number {
  let n = Math.floor(MAX_PATTERN_WORK ** (1 / k));
  while ((n + 1) ** k <= MAX_PATTERN_WORK) n++;
  while (n > 0 && n ** k > MAX_PATTERN_WORK) n--;
  return n;
}

function scanPattern(pattern: string): { problem?: string; variable: number } {
  let variable = 0;
  if (pattern.length > MAX_JSON_SCHEMA_PATTERN) return { problem: `longer than ${MAX_JSON_SCHEMA_PATTERN} characters`, variable };
  type Frame = { quantified: boolean; alternates: boolean };
  const stack: Frame[] = [{ quantified: false, alternates: false }];
  let group: Frame | undefined; // the group just closed, when it is the atom a quantifier would apply to
  let atom = false; // there is an atom a quantifier would apply to
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    const top = stack.at(-1)!;
    // a quantifier: `*`, `+`, `?`, `{n}`, `{n,}`, `{n,m}` (a `{` of another shape is a literal)
    const brace = c === "{" ? /^\{(\d+)(,(\d*))?\}/.exec(pattern.slice(i)) : null;
    if (atom && (c === "*" || c === "+" || c === "?" || brace)) {
      const min = brace ? +brace[1]! : c === "+" ? 1 : 0;
      const max = brace ? (brace[2] === undefined ? min : brace[3] ? +brace[3] : Infinity) : c === "?" ? 1 : Infinity;
      if (brace) i += brace[0].length - 1;
      if (pattern[i + 1] === "?") i++; // lazy
      if (group && max > 1 && group.quantified) return { problem: "a repeated group whose body repeats (nested quantifiers)", variable };
      if (group && max > 1 && group.alternates) return { problem: "a repeated group whose body alternates", variable };
      if (max !== min) {
        top.quantified = true;
        variable++;
      }
      group = undefined;
      atom = false;
      continue;
    }
    group = undefined;
    atom = true;
    if (c === "\\") {
      const e = pattern[i + 1];
      if (e !== undefined && (/[1-9]/.test(e) || e === "k")) return { problem: "a backreference", variable };
      i++;
    } else if (c === "[") {
      let j = i + 1;
      if (pattern[j] === "^") j++;
      if (pattern[j] === "]") j++;
      while (j < pattern.length && pattern[j] !== "]") j += pattern[j] === "\\" ? 2 : 1;
      i = j;
    } else if (c === "(") {
      stack.push({ quantified: false, alternates: false });
      atom = false;
      if (pattern[i + 1] === "?") {
        const head = /^\?(?::|=|!|<=|<!|<[A-Za-z_$][\w$]*>)/.exec(pattern.slice(i + 1));
        if (head) i += head[0].length;
      }
    } else if (c === ")" && stack.length > 1) {
      const closed = stack.pop()!;
      const parent = stack.at(-1)!;
      parent.quantified ||= closed.quantified;
      parent.alternates ||= closed.alternates;
      group = closed;
    } else if (c === "|") {
      top.alternates = true;
      atom = false;
    } else if (c === "^" || c === "$") {
      atom = false;
    }
  }
  return { variable };
}

function validateLocalSchemaRef(
  ref: unknown,
  root: Record<string, unknown>,
  idx: number,
  kind: "Schema" | "View" | "Procedure",
  name: string,
  pointer: string,
): Record<string, unknown> {
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
  return current as Record<string, unknown>;
}
