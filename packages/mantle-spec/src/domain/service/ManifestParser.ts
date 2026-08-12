import { parseAllDocuments } from "yaml";
import {
  type Diagnostic,
  type DiagnosticCode,
  validateDiagnostic,
} from "../../kernel/diagnostic.js";
import {
  API_VERSION,
  BUILTIN_OPS,
  LIFECYCLE_HOOKS,
  MCP_TRIGGER_SURFACES,
  STAFF_ROLES,
  FILTER_COMPARISON_OPS,
  VIEW_PARAMS_RESERVED,
  isParamRef,
  hasCtxUserRefKey,
  isCtxUserRef,
  isStaffRole,
  type AuthPredicate,
  type BuiltinOp,
  type FilterAst,
  type HttpMethod,
  type JsonSchema,
  type LifecycleHook,
  type Manifest,
  type ManifestKind,
  type ProcedureManifest,
  type SchemaManifest,
  type TriggerManifest,
  type ViewManifest,
} from "../model/ManifestGrammar.js";
import {
  checkSchemaIndexes,
  schemaIndexDiagnosticCode,
} from "./SchemaIndexChecker.js";
import { checkSchemaSearchableFields } from "./SchemaSearchChecker.js";

/**
 * Shared shape validator for `LocalizedText` fields (`Schema.spec.title`
 * / `.description`, `Procedure.spec.title` / `.description` — #430;
 * `View.spec.title` — #443).
 * Accepts:
 *   - a non-empty string, or
 *   - a plain object (not an array) with at least one own-enumerable
 *     key, where every key AND every value is a non-empty string.
 * Rejects everything else — including an empty string, an empty
 * object, an array (arrays are `typeof "object"` in JS so they need an
 * explicit `Array.isArray` guard), and any non-string property value.
 * When `required` is `false` and `value` is `undefined`, this is a
 * silent no-op (the field is simply absent).
 */
function validateLocalizedText(
  value: unknown,
  idx: number,
  pointer: string,
  fieldLabel: string,
  required: boolean,
): void {
  if (value === undefined) {
    if (required) {
      throw new ManifestParseError(
        `${fieldLabel} is required (non-empty string, or an object mapping locale → non-empty string)`,
        idx,
        pointer,
      );
    }
    return;
  }
  if (typeof value === "string") {
    if (value.length === 0) {
      throw new ManifestParseError(
        `${fieldLabel} must be a non-empty string when present (or an object mapping locale → non-empty string)`,
        idx,
        pointer,
      );
    }
    return;
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) {
      throw new ManifestParseError(
        `${fieldLabel} object form must have at least one locale → string entry; got {}`,
        idx,
        pointer,
      );
    }
    for (const [key, entryValue] of entries) {
      if (key.length === 0) {
        throw new ManifestParseError(
          `${fieldLabel} object form keys must be non-empty locale codes; got an empty key`,
          idx,
          pointer,
        );
      }
      if (typeof entryValue !== "string" || entryValue.length === 0) {
        throw new ManifestParseError(
          `${fieldLabel} object form value for locale '${key}' must be a non-empty string; got ${JSON.stringify(entryValue)}`,
          idx,
          `${pointer}/${key}`,
        );
      }
    }
    return;
  }
  throw new ManifestParseError(
    `${fieldLabel} must be a non-empty string, or an object mapping locale → non-empty string; got ${JSON.stringify(value)}`,
    idx,
    pointer,
  );
}

/**
 * Day-1 envelope-and-shape parser. Loop 1 (`mantle validate`) does
 * the cross-manifest checks (Trigger.target.procedure exists, View.from
 * is a Schema, etc.) — see ADR-0007 and `docs/design-atoms.md`.
 *
 * Diagnostics emitted here are intentionally narrow: bad envelope,
 * structurally malformed spec, use of a DRAFT or v0.1.x-not-yet-shipped
 * key the v0.1.0 parser does not accept.
 *
 * Return shape is `{ manifests, diagnostics }`: parse-fatal docs are
 * skipped (manifest absent from `manifests`) and reported via a
 * `severity: "error"` diagnostic. Per ADR-0008 the caller (the CLI / boot
 * validator / consumer) routes diagnostics; we don't throw.
 *
 * Multi-doc YAML support per ADR-0001 § "Authoring shape" — one feature
 * per file, atoms separated by `---`.
 */

/**
 * Throwable carrier used by the envelope-shape validators below
 * (`validateEnvelope`, kind-specific `validate*Spec`). Each throw
 * carries a JSON Pointer + diagnostic code; the top-level
 * `parseManifests` catches the throw and converts it to a Diagnostic
 * for the public `{ manifests, diagnostics }` return shape.
 */
export class ManifestParseError extends Error {
  constructor(
    message: string,
    public readonly docIndex?: number,
    /** JSON Pointer into the manifest (e.g. `/spec/output`). */
    public readonly pointer?: string,
    public readonly code: DiagnosticCode = "INVALID_MANIFEST_ENVELOPE",
  ) {
    super(docIndex != null ? `[doc ${docIndex}] ${message}` : message);
    this.name = "ManifestParseError";
  }
}

const KNOWN_KINDS: ReadonlySet<ManifestKind> = new Set([
  "Schema",
  "View",
  "Procedure",
  "Trigger",
]);

const V01_TRIGGER_SOURCE_KINDS: ReadonlySet<string> = new Set([
  "http",
  "lifecycle",
  "mcp",
]);
const DRAFT_TRIGGER_SOURCE_KINDS: ReadonlySet<string> = new Set([
  "cron",
  "queue",
]);

const V01_HTTP_METHODS: ReadonlySet<HttpMethod> = new Set([
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
]);

const V01_HANDLER_KINDS: ReadonlySet<string> = new Set(["ref", "builtin"]);
const V01_BUILTIN_OPS: ReadonlySet<BuiltinOp> = new Set(BUILTIN_OPS);
const V01_LIFECYCLE_HOOKS: ReadonlySet<LifecycleHook> = new Set(LIFECYCLE_HOOKS);
const V01_HOOK_ERROR_POLICIES: ReadonlySet<string> = new Set(["abort", "continue"]);
const V01_MCP_TRIGGER_SURFACES: ReadonlySet<string> = new Set(MCP_TRIGGER_SURFACES);
const DRAFT_FILTER_OPS: ReadonlySet<string> = new Set(["contains", "not", "in", "like"]);
const FILTER_COMPARISON_OP_SET: ReadonlySet<string> = new Set(FILTER_COMPARISON_OPS);
const V01_LIFECYCLE_MODES: ReadonlySet<string> = new Set(["publishing", "editorial", "operational"]);

/** Result of `parseManifests`. */
export interface ParseManifestsResult {
  readonly manifests: Manifest[];
  readonly diagnostics: Diagnostic[];
}

/**
 * Parse YAML text (single doc, multi-doc, or a list of either) into
 * typed manifests + diagnostics. Per ADR-0001 multi-doc YAML support,
 * `---` separators inside one string yield one manifest per doc.
 */
export function parseManifests(input: string | readonly string[]): ParseManifestsResult {
  const inputs = typeof input === "string" ? [input] : input;
  const manifests: Manifest[] = [];
  const diagnostics: Diagnostic[] = [];
  let globalDocIndex = 0;
  for (const yamlText of inputs) {
    const docCount = parseOneStream(yamlText, globalDocIndex, manifests, diagnostics);
    globalDocIndex += docCount;
  }
  return { manifests, diagnostics };
}

export interface ParseManifestsOrThrowOptions {
  /** Optional context label woven into the thrown error message
   *  (e.g. `"starter manifests"`). Helps multi-source consumers
   *  identify which call site produced the failure. */
  readonly context?: string;
}

/**
 * Convenience wrapper around `parseManifests` for the common case
 * where any diagnostic is fatal (worker module-init, CLI tools).
 * Throws an `Error` with one diagnostic per line —
 * `[CODE] path: message` — when `result.diagnostics.length > 0`.
 *
 * Adapters and starters should prefer this over hand-rolling the
 * "format diagnostics → throw" three-liner so the error envelope
 * stays consistent across consumers (matters for AI authors reading
 * boot failures in `wrangler tail`).
 */
export function parseManifestsOrThrow(
  input: string | readonly string[],
  options?: ParseManifestsOrThrowOptions,
): readonly Manifest[] {
  const result = parseManifests(input);
  if (result.diagnostics.length > 0) {
    const summary = result.diagnostics
      .map((d) => `  - [${d.code}] ${d.path}: ${d.message}`)
      .join("\n");
    const ctx = options?.context ? ` in ${options.context}` : "";
    throw new Error(`Manifest parse failed${ctx}:\n${summary}`);
  }
  return result.manifests;
}

function parseOneStream(
  yamlText: string,
  baseDocIndex: number,
  manifests: Manifest[],
  diagnostics: Diagnostic[],
): number {
  const docs = parseAllDocuments(yamlText, { merge: false });
  for (let i = 0; i < docs.length; i++) {
    const doc = docs[i]!;
    const docIndex = baseDocIndex + i;
    if (doc.errors.length > 0) {
      diagnostics.push(
        validateDiagnostic({
          code: "INVALID_MANIFEST_ENVELOPE",
          severity: "error",
          path: pointerFor(docIndex, "/"),
          message: `[doc ${docIndex}] YAML parse error: ${doc.errors.map((e) => e.message).join("; ")}`,
        }),
      );
      continue;
    }
    // `maxAliasCount: 100` matches the yaml library's recommended safe
    // default; the prior `-1` (unlimited) leaves the parser open to YAML
    // bombs (`a: &a [{a: *a, ...}]`) that can exhaust memory before any
    // grammar validator runs. The lib throws a ReferenceError when the
    // cap trips — surface as a structured diagnostic, not an uncaught.
    let value: unknown;
    try {
      value = doc.toJS({ maxAliasCount: 100 });
    } catch (e) {
      diagnostics.push(
        validateDiagnostic({
          code: "INVALID_MANIFEST_ENVELOPE",
          severity: "error",
          path: pointerFor(docIndex, "/"),
          message: `[doc ${docIndex}] YAML alias-expansion limit exceeded: ${e instanceof Error ? e.message : String(e)}`,
        }),
      );
      continue;
    }
    if (value == null) continue;
    try {
      manifests.push(validateEnvelope(value, docIndex));
    } catch (e) {
      if (e instanceof ManifestParseError) {
        diagnostics.push(
          validateDiagnostic({
            code: e.code,
            severity: "error",
            path: pointerFor(docIndex, e.pointer ?? "/"),
            message: e.message,
          }),
        );
      } else {
        diagnostics.push(
          validateDiagnostic({
            code: "INVALID_MANIFEST_ENVELOPE",
            severity: "error",
            path: pointerFor(docIndex, "/"),
            message:
              e instanceof Error
                ? `[doc ${docIndex}] ${e.message}`
                : `[doc ${docIndex}] unknown parse error`,
          }),
        );
      }
    }
  }
  return docs.length;
}

function pointerFor(docIndex: number, jsonPointer: string): string {
  const ptr = jsonPointer.startsWith("/") ? jsonPointer : `/${jsonPointer}`;
  return `manifest:doc/${docIndex}#${ptr}`;
}

function validateEnvelope(raw: unknown, docIndex: number): Manifest {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ManifestParseError("manifest must be a YAML mapping", docIndex);
  }
  const m = raw as Record<string, unknown>;

  if (m["apiVersion"] !== API_VERSION) {
    throw new ManifestParseError(
      `apiVersion must be "${API_VERSION}"; got ${JSON.stringify(m["apiVersion"])}`,
      docIndex,
      "/apiVersion",
    );
  }
  const kind = m["kind"];
  if (typeof kind !== "string" || !KNOWN_KINDS.has(kind as ManifestKind)) {
    throw new ManifestParseError(
      `kind must be one of ${[...KNOWN_KINDS].join(", ")}; got ${JSON.stringify(kind)}`,
      docIndex,
      "/kind",
    );
  }
  const meta = m["metadata"];
  if (typeof meta !== "object" || meta === null) {
    throw new ManifestParseError("metadata is required and must be a mapping", docIndex, "/metadata");
  }
  const name = (meta as Record<string, unknown>)["name"];
  if (typeof name !== "string" || name.length === 0) {
    throw new ManifestParseError("metadata.name is required (non-empty string)", docIndex, "/metadata/name");
  }
  const spec = m["spec"];
  if (typeof spec !== "object" || spec === null) {
    throw new ManifestParseError("spec is required and must be a mapping", docIndex, "/spec");
  }

  switch (kind) {
    case "Schema":
      return validateSchemaSpec(raw as SchemaManifest, docIndex);
    case "View":
      return validateViewSpec(raw as ViewManifest, docIndex);
    case "Procedure":
      return validateProcedureSpec(raw as ProcedureManifest, docIndex);
    case "Trigger":
      return validateTriggerSpec(raw as TriggerManifest, docIndex);
    default:
      throw new ManifestParseError(`unhandled kind ${kind}`, docIndex);
  }
}

function validateSchemaSpec(m: SchemaManifest, idx: number): SchemaManifest {
  const s = m.spec as unknown as Record<string, unknown>;
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
  if ("indexedFields" in s) {
    throw new ManifestParseError(
      "Schema.spec.indexedFields is DRAFT and superseded by ordered composite Schema.spec.indexes; not supported in v0.1",
      idx,
      "/spec/indexedFields",
      "DRAFT_KEY_USED",
    );
  }
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
  if ("localized" in s && typeof s["localized"] !== "boolean") {
    throw new ManifestParseError(
      `Schema.spec.localized must be a boolean; got ${JSON.stringify(s["localized"])}`,
      idx,
      "/spec/localized",
    );
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
      );
    }
  }
  if ("policies" in s) {
    throw new ManifestParseError(
      "Schema.spec.policies is DRAFT (see ADR-0001 § \"What's DRAFT\" / Schema); not supported in v0.1",
      idx,
      "/spec/policies",
      "DRAFT_KEY_USED",
    );
  }
  return m;
}

function validateViewSpec(m: ViewManifest, idx: number): ViewManifest {
  const s = m.spec as unknown as Record<string, unknown>;
  validateLocalizedText(
    s["title"],
    idx,
    "/spec/title",
    "View.spec.title",
    false,
  );
  if (typeof s["from"] !== "string" || (s["from"] as string).length === 0) {
    throw new ManifestParseError("View.spec.from is required (non-empty string)", idx, "/spec/from");
  }
  // `surface` is optional (absent ⇒ public). When present it reuses
  // the `MCP_TRIGGER_SURFACES` vocabulary (`public` | `staff`) —
  // `staff` moves the View off the public REST mount to the
  // staff-gated admin path (#433).
  if ("surface" in s && s["surface"] != null) {
    const surface = s["surface"];
    if (typeof surface !== "string" || !V01_MCP_TRIGGER_SURFACES.has(surface)) {
      throw new ManifestParseError(
        `View.spec.surface must be one of ${[...V01_MCP_TRIGGER_SURFACES].join(", ")}; got ${JSON.stringify(surface)}`,
        idx,
        "/spec/surface",
      );
    }
  }
  if ("requires" in s && s["requires"] != null) {
    validateRequires(s["requires"], idx, "View");
  }
  let paramSchema: JsonSchema | undefined;
  if ("params" in s && s["params"] != null) {
    paramSchema = validateViewParams(s["params"], idx);
  }
  if ("filter" in s && s["filter"] != null) {
    validateFilterAst(s["filter"], idx, "View.spec.filter", "/spec/filter", paramSchema);
  }
  if ("orderBy" in s && s["orderBy"] != null) {
    validateViewOrderBy(s["orderBy"], idx);
  }
  for (const draft of ["recursive", "gatedBy", "join", "policies"] as const) {
    if (draft in s) {
      throw new ManifestParseError(
        `View.spec.${draft} is DRAFT (see ADR-0001 § "What's DRAFT" / View); not supported in v0.1`,
        idx,
        `/spec/${draft}`,
        "DRAFT_KEY_USED",
      );
    }
  }
  return m;
}

/**
 * `direction` is typed `"asc" | "desc"`, but manifests are parsed from
 * YAML so any string can arrive at runtime. The compiler maps it to a
 * closed set, but an out-of-enum value is an authoring mistake we must
 * surface as a pre-deploy Diagnostic rather than silently coerce.
 */
function validateViewOrderBy(raw: unknown, idx: number): void {
  if (!Array.isArray(raw)) {
    throw new ManifestParseError(
      "View.spec.orderBy must be an array of { field, direction? }",
      idx,
      "/spec/orderBy",
      "VIEW_ORDERBY_INVALID",
    );
  }
  raw.forEach((entry, i) => {
    if (typeof entry !== "object" || entry === null) {
      throw new ManifestParseError(
        "View.spec.orderBy entries must be objects with a `field`",
        idx,
        `/spec/orderBy/${i}`,
        "VIEW_ORDERBY_INVALID",
      );
    }
    const o = entry as Record<string, unknown>;
    if (typeof o["field"] !== "string" || (o["field"] as string).length === 0) {
      throw new ManifestParseError(
        "View.spec.orderBy[].field is required (non-empty string)",
        idx,
        `/spec/orderBy/${i}/field`,
        "VIEW_ORDERBY_INVALID",
      );
    }
    if (o["direction"] !== undefined && o["direction"] !== "asc" && o["direction"] !== "desc") {
      throw new ManifestParseError(
        `View.spec.orderBy[].direction must be "asc" or "desc" (got ${JSON.stringify(o["direction"])})`,
        idx,
        `/spec/orderBy/${i}/direction`,
        "VIEW_ORDERBY_INVALID",
      );
    }
  });
}

function validateViewParams(raw: unknown, idx: number): JsonSchema {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ManifestParseError(
      "View.spec.params must be a JSON Schema object",
      idx,
      "/spec/params",
      "VIEW_PARAMS_INVALID_SHAPE",
    );
  }
  const p = raw as Record<string, unknown>;
  if (p["type"] !== "object") {
    throw new ManifestParseError(
      `View.spec.params.type must be "object"; got ${JSON.stringify(p["type"])}`,
      idx,
      "/spec/params/type",
      "VIEW_PARAMS_INVALID_SHAPE",
    );
  }
  const props = p["properties"];
  if (typeof props !== "object" || props === null || Array.isArray(props)) {
    throw new ManifestParseError(
      "View.spec.params.properties is required (declare each accepted query-string param)",
      idx,
      "/spec/params/properties",
      "VIEW_PARAMS_INVALID_SHAPE",
    );
  }
  const propNames = Object.keys(props as Record<string, unknown>);
  for (const reserved of VIEW_PARAMS_RESERVED) {
    if (propNames.includes(reserved)) {
      throw new ManifestParseError(
        `View.spec.params.properties.${reserved} is reserved (the runtime owns ${VIEW_PARAMS_RESERVED.join(", ")} for pagination); rename the param.`,
        idx,
        `/spec/params/properties/${reserved}`,
        "VIEW_PARAMS_RESERVED_NAME",
      );
    }
  }
  return raw as JsonSchema;
}

function validateFilterAst(
  node: unknown,
  idx: number,
  path: string,
  jsonPointer: string,
  paramSchema: JsonSchema | undefined,
): void {
  if (typeof node !== "object" || node === null || Array.isArray(node)) {
    throw new ManifestParseError(
      `${path} must be an object node (${FILTER_COMPARISON_OPS.join(" | ")} | and | or)`,
      idx,
      jsonPointer,
    );
  }
  const n = node as Record<string, unknown>;
  const keys = Object.keys(n);
  if (keys.length !== 1) {
    throw new ManifestParseError(
      `${path} must have exactly one key (${FILTER_COMPARISON_OPS.join(" | ")} | and | or); got ${JSON.stringify(keys)}`,
      idx,
      jsonPointer,
    );
  }
  const op = keys[0]!;
  if (FILTER_COMPARISON_OP_SET.has(op)) {
    const comparison = n[op];
    if (typeof comparison !== "object" || comparison === null || Array.isArray(comparison)) {
      throw new ManifestParseError(`${path}.${op} must be an object`, idx, `${jsonPointer}/${op}`);
    }
    const e = comparison as Record<string, unknown>;
    if (typeof e["field"] !== "string" || (e["field"] as string).length === 0) {
      throw new ManifestParseError(
        `${path}.${op}.field is required (non-empty string)`,
        idx,
        `${jsonPointer}/${op}/field`,
      );
    }
    if (!("value" in e)) {
      throw new ManifestParseError(`${path}.${op}.value is required`, idx, `${jsonPointer}/${op}/value`);
    }
    if (hasCtxUserRefKey(e["value"])) {
      if (op !== "eq" || !isCtxUserRef(e["value"])) {
        throw new ManifestParseError(
          `${path}.${op}.value must use the exact identity sentinel { "$ctx.user": "id" } with eq.`,
          idx,
          `${jsonPointer}/${op}/value`,
          "VIEW_FILTER_CTX_USER_REF_INVALID",
        );
      }
    } else if (isParamRef(e["value"])) {
      validateParamRef(e["value"].$param, idx, `${jsonPointer}/${op}/value/$param`, paramSchema);
    }
    return;
  }
  if (op === "and" || op === "or") {
    const arr = n[op];
    if (!Array.isArray(arr) || arr.length === 0) {
      throw new ManifestParseError(`${path}.${op} must be a non-empty array`, idx, `${jsonPointer}/${op}`);
    }
    for (let i = 0; i < arr.length; i++) {
      validateFilterAst(arr[i], idx, `${path}.${op}[${i}]`, `${jsonPointer}/${op}/${i}`, paramSchema);
    }
    return;
  }
  if (DRAFT_FILTER_OPS.has(op)) {
    throw new ManifestParseError(
      `${path} operator '${op}' is DRAFT (see ADR-0001 § "What's DRAFT" / View); not supported in v0.1`,
      idx,
      jsonPointer,
      "DRAFT_KEY_USED",
    );
  }
  throw new ManifestParseError(
    `${path} operator must be one of ${FILTER_COMPARISON_OPS.join(", ")}, and, or; got '${op}'`,
    idx,
    jsonPointer,
  );
}

function validateParamRef(
  name: string,
  idx: number,
  pointer: string,
  paramSchema: JsonSchema | undefined,
): void {
  if (name.length === 0) {
    throw new ManifestParseError(
      "filter param ref { $param: '' } is invalid; supply a non-empty param name.",
      idx,
      pointer,
    );
  }
  if (!paramSchema) {
    throw new ManifestParseError(
      `filter references param '${name}' but View.spec.params is not declared. Add a params JSON Schema or use a literal value.`,
      idx,
      pointer,
      "VIEW_FILTER_PARAM_REF_UNKNOWN",
    );
  }
  const props = (paramSchema.properties ?? {}) as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(props, name)) {
    throw new ManifestParseError(
      `filter references unknown param '${name}'; declare it under View.spec.params.properties.`,
      idx,
      pointer,
      "VIEW_FILTER_PARAM_REF_UNKNOWN",
    );
  }
  const required = paramSchema.required ?? [];
  if (!required.includes(name)) {
    throw new ManifestParseError(
      `filter references optional param '${name}'; v0.1.0 requires every param-ref'd name to appear in View.spec.params.required (optional-skip semantics are reserved for v0.1.x).`,
      idx,
      pointer,
      "VIEW_FILTER_PARAM_REF_NOT_REQUIRED",
    );
  }
}

function validateProcedureSpec(m: ProcedureManifest, idx: number): ProcedureManifest {
  const s = m.spec as unknown as Record<string, unknown>;
  validateLocalizedText(
    s["title"],
    idx,
    "/spec/title",
    "Procedure.spec.title",
    false,
  );
  validateLocalizedText(
    s["description"],
    idx,
    "/spec/description",
    "Procedure.spec.description",
    false,
  );
  if (typeof s["input"] !== "object" || s["input"] === null) {
    throw new ManifestParseError("Procedure.spec.input is required (JSON Schema)", idx, "/spec/input");
  }
  if (typeof s["output"] !== "object" || s["output"] === null) {
    throw new ManifestParseError("Procedure.spec.output is required (JSON Schema)", idx, "/spec/output");
  }
  const handler = s["handler"] as Record<string, unknown> | undefined;
  if (!handler) {
    throw new ManifestParseError("Procedure.spec.handler is required", idx, "/spec/handler");
  }
  validateHandlerBinding(handler, idx);
  if ("requires" in s && s["requires"] != null) {
    validateRequires(s["requires"], idx, "Procedure");
  }
  for (const draft of ["errors", "retry", "idempotency"] as const) {
    if (draft in s) {
      throw new ManifestParseError(
        `Procedure.spec.${draft} is DRAFT (see ADR-0001 § "What's DRAFT" / Procedure); not supported in v0.1`,
        idx,
        `/spec/${draft}`,
        "DRAFT_KEY_USED",
      );
    }
  }
  return m;
}

function validateHandlerBinding(h: Record<string, unknown>, idx: number): void {
  const kind = h["kind"];
  if (typeof kind !== "string") {
    throw new ManifestParseError(
      `Procedure.spec.handler.kind is required (one of ${[...V01_HANDLER_KINDS].join(", ")})`,
      idx,
      "/spec/handler/kind",
    );
  }
  if (!V01_HANDLER_KINDS.has(kind)) {
    throw new ManifestParseError(
      `Procedure.spec.handler.kind must be one of ${[...V01_HANDLER_KINDS].join(", ")}; got '${kind}'`,
      idx,
      "/spec/handler/kind",
    );
  }
  if (kind === "ref") {
    if (typeof h["ref"] !== "string" || (h["ref"] as string).length === 0) {
      throw new ManifestParseError(
        "Procedure.spec.handler.ref is required (non-empty registration key)",
        idx,
        "/spec/handler/ref",
      );
    }
    return;
  }
  const op = h["op"];
  if (typeof op !== "string" || !V01_BUILTIN_OPS.has(op as BuiltinOp)) {
    throw new ManifestParseError(
      `Procedure.spec.handler.op must be one of ${[...V01_BUILTIN_OPS].join(", ")}; got ${JSON.stringify(op)}`,
      idx,
      "/spec/handler/op",
    );
  }
  if (typeof h["schema"] !== "string" || (h["schema"] as string).length === 0) {
    throw new ManifestParseError(
      "Procedure.spec.handler.schema is required (Schema metadata.name) when handler.kind is 'builtin'",
      idx,
      "/spec/handler/schema",
    );
  }
  if ("ref" in h) {
    throw new ManifestParseError(
      "Procedure.spec.handler.ref is invalid when handler.kind is 'builtin' (ref + builtin are mutually exclusive)",
      idx,
      "/spec/handler/ref",
    );
  }
}

function validateRequires(req: unknown, idx: number, atom: "Procedure" | "View"): void {
  if (typeof req !== "object" || req === null) {
    throw new ManifestParseError(`${atom}.spec.requires must be an object`, idx);
  }
  const r = req as Record<string, unknown>;
  // window / quota are Procedure-only DRAFT keys; reject early on both
  // atoms so a misplaced key surfaces with a clear diagnostic.
  for (const draft of ["window", "quota"] as const) {
    if (draft in r) {
      throw new ManifestParseError(
        `${atom}.spec.requires.${draft} is DRAFT (see ADR-0001 § "What's DRAFT" / Procedure); not supported in v0.1`,
        idx,
        undefined,
        "DRAFT_KEY_USED",
      );
    }
  }
  if ("guard" in r) {
    const guard = r["guard"];
    if (typeof guard !== "object" || guard === null || Array.isArray(guard)) {
      throw new ManifestParseError(`${atom}.spec.requires.guard must be an object`, idx);
    }
    const g = guard as Record<string, unknown>;
    if (typeof g["procedure"] !== "string" || g["procedure"].length === 0) {
      throw new ManifestParseError(
        `${atom}.spec.requires.guard.procedure must be a non-empty Procedure name`,
        idx,
      );
    }
    const extra = Object.keys(g).find((key) => key !== "procedure");
    if (extra !== undefined) {
      throw new ManifestParseError(
        `${atom}.spec.requires.guard.${extra} is not supported; guard accepts only \`procedure\``,
        idx,
      );
    }
  }
  if (!("auth" in r) || r["auth"] == null) return;
  const auth = r["auth"];
  if (typeof auth !== "object" || auth === null) {
    throw new ManifestParseError(`${atom}.spec.requires.auth must be an object`, idx);
  }
  const a = auth as Record<string, unknown>;
  if ("any" in a) {
    throw new ManifestParseError(
      `${atom}.spec.requires.auth.any is DRAFT; v0.1 supports only \`all\``,
      idx,
      undefined,
      "DRAFT_KEY_USED",
    );
  }
  if (!("all" in a)) {
    throw new ManifestParseError(
      `${atom}.spec.requires.auth must declare \`all\` (v0.1)`,
      idx,
    );
  }
  const all = a["all"];
  if (!Array.isArray(all) || all.length === 0) {
    throw new ManifestParseError(
      `${atom}.spec.requires.auth.all must be a non-empty array`,
      idx,
    );
  }
  for (let i = 0; i < all.length; i++) {
    validateAuthPredicate(all[i], idx, `${atom}.spec.requires.auth.all[${i}]`);
  }
}

function validateAuthPredicate(p: unknown, idx: number, path: string): asserts p is AuthPredicate {
  if (p === "ctx.user" || p === "ctx.auth") return;
  if (typeof p === "object" && p !== null && !Array.isArray(p)) {
    const o = p as Record<string, unknown>;
    if ("ctx.auth.scope" in o) {
      const scope = o["ctx.auth.scope"];
      if (typeof scope !== "string" || scope.length === 0) {
        throw new ManifestParseError(
          `${path}: 'ctx.auth.scope' value must be a non-empty string`,
          idx,
        );
      }
      return;
    }
    if ("ctx.staff" in o) {
      const roles = o["ctx.staff"];
      if (!Array.isArray(roles) || roles.length === 0 || roles.some((r) => typeof r !== "string")) {
        throw new ManifestParseError(
          `${path}: 'ctx.staff' value must be a non-empty array of role-name strings`,
          idx,
        );
      }
      const badRole = (roles as readonly string[]).find((r) => !isStaffRole(r));
      if (badRole !== undefined) {
        throw new ManifestParseError(
          `${path}: 'ctx.staff' role '${badRole}' is not in STAFF_ROLES (${[...STAFF_ROLES].join(", ")})`,
          idx,
          undefined,
          "AUTH_PREDICATE_NOT_IN_ENUM",
        );
      }
      return;
    }
  }
  if (typeof p === "object" && p !== null) {
    const draftKeys = ["owns", "withinMinutes", "contains"];
    const used = draftKeys.find((k) => k in (p as Record<string, unknown>));
    if (used) {
      throw new ManifestParseError(
        `${path}: predicate '${used}' is DRAFT (see ADR-0001 § "What's DRAFT" / Procedure); not supported in v0.1`,
        idx,
        undefined,
        "DRAFT_KEY_USED",
      );
    }
  }
  throw new ManifestParseError(
    `${path} must be 'ctx.user', 'ctx.auth', { 'ctx.auth.scope': <scope> }, or { 'ctx.staff': [<role>, ...] }; got ${JSON.stringify(p)}`,
    idx,
  );
}

function validateHttpSource(source: Record<string, unknown>, idx: number): void {
  const method = source["method"];
  if (typeof method !== "string" || !V01_HTTP_METHODS.has(method as HttpMethod)) {
    throw new ManifestParseError(
      `Trigger.spec.source.method must be one of ${[...V01_HTTP_METHODS].join(", ")} (v0.1); got ${JSON.stringify(method)}`,
      idx,
      "/spec/source/method",
    );
  }
  const path = source["path"];
  if (typeof path !== "string" || path.length === 0 || !path.startsWith("/")) {
    throw new ManifestParseError(
      "Trigger.spec.source.path is required (non-empty string starting with '/')",
      idx,
      "/spec/source/path",
    );
  }
}

function validateLifecycleSource(source: Record<string, unknown>, idx: number): void {
  if (typeof source["schema"] !== "string" || (source["schema"] as string).length === 0) {
    throw new ManifestParseError(
      "Trigger.spec.source.schema is required (Schema metadata.name) when source.kind is 'lifecycle'",
      idx,
      "/spec/source/schema",
    );
  }
  const on = source["on"];
  if (!Array.isArray(on) || on.length === 0) {
    throw new ManifestParseError(
      `Trigger.spec.source.on must be a non-empty array of hook names (one of ${[...V01_LIFECYCLE_HOOKS].join(", ")})`,
      idx,
      "/spec/source/on",
    );
  }
  for (let i = 0; i < on.length; i++) {
    const hook = on[i];
    if (typeof hook !== "string" || !V01_LIFECYCLE_HOOKS.has(hook as LifecycleHook)) {
      throw new ManifestParseError(
        `Trigger.spec.source.on[${i}] must be one of ${[...V01_LIFECYCLE_HOOKS].join(", ")}; got ${JSON.stringify(hook)}`,
        idx,
        `/spec/source/on/${i}`,
      );
    }
  }
  if ("errorPolicy" in source) {
    const ep = source["errorPolicy"];
    if (typeof ep !== "string" || !V01_HOOK_ERROR_POLICIES.has(ep)) {
      throw new ManifestParseError(
        `Trigger.spec.source.errorPolicy must be 'abort' or 'continue'; got ${JSON.stringify(ep)}`,
        idx,
        "/spec/source/errorPolicy",
      );
    }
    if (ep === "abort" && (on as ReadonlyArray<string>).some((h) => typeof h === "string" && h.startsWith("after_"))) {
      throw new ManifestParseError(
        "Trigger.spec.source.errorPolicy: 'abort' is invalid when any after_* hook is in `on` — after_* runs after the response is sent, so abort cannot reach the caller. Move after_* hooks to a separate trigger, or use 'continue'.",
        idx,
        "/spec/source/errorPolicy",
      );
    }
  }
  if ("method" in source || "path" in source) {
    throw new ManifestParseError(
      "Trigger.spec.source.{method,path} are invalid when source.kind is 'lifecycle' (those keys belong to source.kind: 'http')",
      idx,
      "/spec/source",
    );
  }
}

function validateMcpSource(source: Record<string, unknown>, idx: number): void {
  const surface = source["surface"];
  if (typeof surface !== "string" || !V01_MCP_TRIGGER_SURFACES.has(surface)) {
    throw new ManifestParseError(
      `Trigger.spec.source.surface must be one of ${[...V01_MCP_TRIGGER_SURFACES].join(", ")}; got ${JSON.stringify(surface)}`,
      idx,
      "/spec/source/surface",
    );
  }
  if ("method" in source || "path" in source) {
    throw new ManifestParseError(
      "Trigger.spec.source.{method,path} are invalid when source.kind is 'mcp' (those keys belong to source.kind: 'http')",
      idx,
      "/spec/source",
    );
  }
  if ("schema" in source || "on" in source || "errorPolicy" in source) {
    throw new ManifestParseError(
      "Trigger.spec.source.{schema,on,errorPolicy} are invalid when source.kind is 'mcp' (those keys belong to source.kind: 'lifecycle')",
      idx,
      "/spec/source",
    );
  }
}

function validateTriggerSpec(m: TriggerManifest, idx: number): TriggerManifest {
  const s = m.spec as unknown as Record<string, unknown>;
  const source = s["source"] as Record<string, unknown> | undefined;
  if (!source) {
    throw new ManifestParseError("Trigger.spec.source is required", idx, "/spec/source");
  }
  const sourceKind = source["kind"];
  if (typeof sourceKind !== "string") {
    throw new ManifestParseError(
      `Trigger.spec.source.kind is required (one of ${[...V01_TRIGGER_SOURCE_KINDS].join(", ")})`,
      idx,
      "/spec/source/kind",
    );
  }
  if (DRAFT_TRIGGER_SOURCE_KINDS.has(sourceKind)) {
    throw new ManifestParseError(
      `Trigger.spec.source.kind '${sourceKind}' is DRAFT (see ADR-0001 § "What's DRAFT" / Trigger); not supported in v0.1`,
      idx,
      "/spec/source/kind",
      "DRAFT_KEY_USED",
    );
  }
  if (!V01_TRIGGER_SOURCE_KINDS.has(sourceKind)) {
    throw new ManifestParseError(
      `Trigger.spec.source.kind must be one of ${[...V01_TRIGGER_SOURCE_KINDS].join(", ")}; got '${sourceKind}'`,
      idx,
      "/spec/source/kind",
    );
  }
  if (sourceKind === "http") validateHttpSource(source, idx);
  else if (sourceKind === "lifecycle") validateLifecycleSource(source, idx);
  else if (sourceKind === "mcp") validateMcpSource(source, idx);
  const target = s["target"] as Record<string, unknown> | undefined;
  if (!target || typeof target["procedure"] !== "string") {
    throw new ManifestParseError("Trigger.spec.target.procedure is required (string)", idx, "/spec/target/procedure");
  }
  if ("project" in target) {
    throw new ManifestParseError(
      "Trigger.spec.target.project is DRAFT (see ADR-0001 § \"What's DRAFT\" / Trigger); not supported in v0.1",
      idx,
      undefined,
      "DRAFT_KEY_USED",
    );
  }
  if ("atomicity" in s) {
    throw new ManifestParseError(
      "Trigger.spec.atomicity is DRAFT (see ADR-0001 § \"What's DRAFT\" / Trigger); not supported in v0.1",
      idx,
      undefined,
      "DRAFT_KEY_USED",
    );
  }
  return m;
}

export { partitionManifests } from "./ManifestPartition.js";

export type { FilterAst };
