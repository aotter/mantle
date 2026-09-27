import {
  LineCounter,
  isMap,
  isNode,
  isScalar,
  isSeq,
  parseAllDocuments,
  type Document,
  type Node,
} from "yaml";
import {
  type Diagnostic,
  type DiagnosticCode,
  type SourceLocation,
  type SourceSpan,
  validateDiagnostic,
} from "../../kernel/diagnostic.js";
import {
  API_VERSION,
  MANTLE_BIND_KEYWORD,
  MANTLE_BIND_VALUES,
  LIFECYCLE_HOOKS,
  MCP_TRIGGER_SURFACES,
  VIEW_SURFACES,
  STAFF_ROLES,
  STORE_INPUT_REFERENCE_PREFIX,
  STORE_VALUE_REFERENCES,
  VIEW_INPUT_RESERVED,
  PROCEDURE_MCP_ANNOTATION_KEYS,
  PROCEDURE_TARGET_KEYS,
  RESERVED_ENTRY_COLUMNS,
  RESERVED_PROCEDURE_INPUT_NAMES,
  isStaffRole,
  type AuthPredicate,
  type HttpMethod,
  type JsonSchema,
  type LifecycleHook,
  type LifecycleMode,
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
import { checkFormUiSchema, checkSchemaAdminUi, checkViewAdminUi } from "./SchemaAdminUiChecker.js";

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
 * is a Schema, etc.) — see ADR-0007 and `docs/handbook/reference/manifest.md`.
 *
 * Diagnostics emitted here are intentionally narrow: bad envelope or
 * structurally malformed shipped grammar.
 *
 * The canonical API withholds its value when any document fails. The legacy
 * `{ manifests, diagnostics }` adapter below therefore returns no manifests
 * on failure rather than exposing a partial graph.
 *
 * Each caller-owned source may contain multiple YAML documents separated by
 * `---`; source identities and document indexes remain intact.
 */

/**
 * Throwable carrier used by the envelope-shape validators below
 * (`validateEnvelope`, kind-specific `validate*Spec`). Each throw
 * carries a JSON Pointer + diagnostic code; the top-level
 * The source parser catches the throw and converts it to a Diagnostic
 * for the public `{ manifests, diagnostics }` return shape.
 */
export class ManifestParseError extends Error {
  constructor(
    message: string,
    public readonly docIndex?: number,
    /** JSON Pointer into the manifest (e.g. `/spec/output`). */
    public readonly pointer?: string,
    public readonly code: DiagnosticCode = "INVALID_MANIFEST_ENVELOPE",
    public readonly details?: Pick<
      Diagnostic,
      "value" | "expected" | "candidates" | "suggestion"
    >,
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
  "schedule",
]);

const V01_HTTP_METHODS: ReadonlySet<HttpMethod> = new Set([
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
]);

const V01_LIFECYCLE_HOOKS: ReadonlySet<LifecycleHook> = new Set(LIFECYCLE_HOOKS);
const V01_MCP_TRIGGER_SURFACES: ReadonlySet<string> = new Set(MCP_TRIGGER_SURFACES);
const V01_VIEW_SURFACES: ReadonlySet<string> = new Set(VIEW_SURFACES);
const STORE_COMPARISONS: ReadonlySet<string> = new Set(["eq", "ne", "gt", "gte", "lt", "lte", "like", "in", "notIn", "isNull"]);
const STORE_REFERENCES: ReadonlySet<string> = new Set(STORE_VALUE_REFERENCES);
const SCALAR_TYPES: ReadonlySet<string> = new Set(["string", "number", "integer", "boolean"]);
/** Input names a whole-input `"$input"` value never carries. */
const WHOLE_INPUT_EXCLUDED: ReadonlySet<string> = new Set(["id", ...RESERVED_PROCEDURE_INPUT_NAMES]);
const V01_LIFECYCLE_MODES: ReadonlySet<string> = new Set(["publishing", "operational"]);

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  idx: number,
  pointer: string,
): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown !== undefined) {
    const unknownPointer = pointer === "/" ? `/${unknown}` : `${pointer}/${unknown}`;
    throw new ManifestParseError(
      `${unknownPointer.replaceAll("/", ".").slice(1)} is not supported`,
      idx,
      unknownPointer,
    );
  }
}

/** One caller-owned manifest source. Core never resolves this ID as a path. */
export interface ManifestSource {
  readonly sourceId: string;
  readonly text: string;
}

export interface ManifestSourceSet {
  readonly sources: readonly ManifestSource[];
}

type ParsedSchemaManifest = Omit<SchemaManifest, "spec"> & {
  readonly spec: Omit<
    SchemaManifest["spec"],
    "uniqueIndexes" | "indexes" | "searchableFields" | "localized" | "lifecycle"
  > & {
    readonly uniqueIndexes: ReadonlyArray<ReadonlyArray<string>>;
    readonly indexes: ReadonlyArray<ReadonlyArray<string>>;
    readonly searchableFields: readonly string[];
    readonly localized: boolean;
    readonly lifecycle: LifecycleMode;
  };
};

/** Canonical atom value after all static authoring defaults are materialized. */
export type ParsedManifest =
  | ParsedSchemaManifest
  | ViewManifest
  | ProcedureManifest
  | TriggerManifest;

export interface ParsedManifestEntry {
  readonly manifest: ParsedManifest;
  readonly source: SourceLocation;
  /** YAML-node spans keyed by JSON Pointer; source identity lives in `source`. */
  readonly sourceSpans: Readonly<Record<string, SourceSpan>>;
}

declare const parsedManifestSetBrand: unique symbol;

/** Parser-owned value. Consumers cannot construct it as an ordinary object literal. */
export interface ParsedManifestSet {
  readonly entries: readonly ParsedManifestEntry[];
  readonly [parsedManifestSetBrand]: true;
}

export type ParseResult<T> =
  | { readonly ok: true; readonly value: T; readonly diagnostics: readonly Diagnostic[] }
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };

interface InternalParseResult {
  readonly entries: ParsedManifestEntry[];
  readonly diagnostics: Diagnostic[];
}

/**
 * Pure, source-aware parse boundary. Any error withholds the sealed value so a
 * later stage cannot consume a partial manifest graph.
 */
export function parseManifestSources(
  sourceSet: ManifestSourceSet,
): ParseResult<ParsedManifestSet> {
  const parsed = parseManifestSourcesInternal(sourceSet);
  if (parsed.diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    return { ok: false, diagnostics: parsed.diagnostics };
  }
  return {
    ok: true,
    value: Object.freeze({
      entries: Object.freeze(parsed.entries),
    }) as ParsedManifestSet,
    diagnostics: parsed.diagnostics,
  };
}

function parseManifestSourcesInternal(sourceSet: ManifestSourceSet): InternalParseResult {
  const entries: ParsedManifestEntry[] = [];
  const diagnostics: Diagnostic[] = [];
  const sources = sourceSet?.sources;
  if (!Array.isArray(sources)) {
    diagnostics.push(invalidSourceDiagnostic("/sources", "ManifestSourceSet.sources must be an array"));
    return { entries, diagnostics };
  }
  const seenIds = new Set<string>();
  for (let index = 0; index < sources.length; index++) {
    const source = sources[index];
    if (!source || typeof source !== "object") {
      diagnostics.push(invalidSourceDiagnostic(`/sources/${index}`, "manifest source must be an object"));
      continue;
    }
    if (typeof source.sourceId !== "string" || source.sourceId.length === 0) {
      diagnostics.push(invalidSourceDiagnostic(
        `/sources/${index}/sourceId`,
        "manifest sourceId must be a non-empty string",
      ));
      continue;
    }
    if (seenIds.has(source.sourceId)) {
      diagnostics.push(invalidSourceDiagnostic(
        `/sources/${index}/sourceId`,
        `manifest sourceId '${source.sourceId}' is duplicated`,
        source.sourceId,
      ));
      continue;
    }
    seenIds.add(source.sourceId);
    if (typeof source.text !== "string") {
      diagnostics.push(invalidSourceDiagnostic(
        `/sources/${index}/text`,
        `manifest source '${source.sourceId}' text must be a string`,
        source.sourceId,
      ));
      continue;
    }
    parseOneStream(source, entries, diagnostics);
  }
  return { entries, diagnostics };
}

function invalidSourceDiagnostic(path: string, message: string, sourceId?: string): Diagnostic {
  return validateDiagnostic({
    code: "INVALID_MANIFEST_ENVELOPE",
    severity: "error",
    path,
    ...(sourceId
      ? { source: { sourceId, documentIndex: 0, path } }
      : {}),
    message,
  });
}

function parseOneStream(
  source: ManifestSource,
  entries: ParsedManifestEntry[],
  diagnostics: Diagnostic[],
): void {
  const lineCounter = new LineCounter();
  const docs = parseAllDocuments(source.text, { merge: false, lineCounter });
  for (let i = 0; i < docs.length; i++) {
    const doc = docs[i]!;
    const docIndex = i;
    if (doc.errors.length > 0) {
      const error = doc.errors[0];
      const location = sourceLocation(
        source.sourceId,
        docIndex,
        "/",
        lineCounter,
        error?.pos ?? doc.range,
      );
      diagnostics.push(
        validateDiagnostic({
          code: "INVALID_MANIFEST_ENVELOPE",
          severity: "error",
          path: "/",
          source: location,
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
          path: "/",
          source: sourceLocationForNode(source.sourceId, docIndex, "/", doc, lineCounter),
          message: `[doc ${docIndex}] YAML alias-expansion limit exceeded: ${e instanceof Error ? e.message : String(e)}`,
        }),
      );
      continue;
    }
    if (value == null) continue;
    try {
      entries.push({
        manifest: normalizeManifest(validateEnvelope(value, docIndex)),
        source: sourceLocationForNode(source.sourceId, docIndex, "/", doc, lineCounter),
        sourceSpans: collectSourceSpans(doc.contents, lineCounter),
      });
    } catch (e) {
      if (e instanceof ManifestParseError) {
        const path = e.pointer ?? "/";
        diagnostics.push(
          validateDiagnostic({
            code: e.code,
            severity: "error",
            path,
            source: sourceLocationForNode(source.sourceId, docIndex, path, doc, lineCounter),
            ...e.details,
            message: e.message,
          }),
        );
      } else {
        diagnostics.push(
          validateDiagnostic({
            code: "INVALID_MANIFEST_ENVELOPE",
            severity: "error",
            path: "/",
            source: sourceLocationForNode(source.sourceId, docIndex, "/", doc, lineCounter),
            message:
              e instanceof Error
                ? `[doc ${docIndex}] ${e.message}`
                : `[doc ${docIndex}] unknown parse error`,
          }),
        );
      }
    }
  }
}

/** Resolve the narrowest retained authored span for a parsed semantic path. */
export function sourceLocationAt(
  entry: ParsedManifestEntry,
  path: string,
): SourceLocation {
  let candidate = path;
  let span = entry.sourceSpans[candidate];
  while (!span && candidate !== "/") {
    const slash = candidate.lastIndexOf("/");
    candidate = slash <= 0 ? "/" : candidate.slice(0, slash);
    span = entry.sourceSpans[candidate];
  }
  return {
    sourceId: entry.source.sourceId,
    documentIndex: entry.source.documentIndex,
    path,
    ...(span ? { span } : {}),
  };
}

function collectSourceSpans(
  root: Node | null,
  lineCounter: LineCounter,
): Readonly<Record<string, SourceSpan>> {
  const spans: Record<string, SourceSpan> = {};
  const visit = (node: Node | null, path: string): void => {
    if (!node) return;
    const span = sourceSpan(lineCounter, node.range);
    if (span) spans[path] = span;
    if (isMap(node)) {
      for (const pair of node.items) {
        if (!isScalar(pair.key)) continue;
        const key = String(pair.key.value).replace(/~/g, "~0").replace(/\//g, "~1");
        visit(isNode(pair.value) ? pair.value : null, path === "/" ? `/${key}` : `${path}/${key}`);
      }
    } else if (isSeq(node)) {
      node.items.forEach((item, index) =>
        visit(isNode(item) ? item : null, path === "/" ? `/${index}` : `${path}/${index}`)
      );
    }
  };
  visit(root, "/");
  return Object.freeze(spans);
}

function sourceLocationForNode(
  sourceId: string,
  documentIndex: number,
  path: string,
  doc: Document.Parsed,
  lineCounter: LineCounter,
): SourceLocation {
  const parts = path === "/"
    ? []
    : path.slice(1).split("/").map((part) => {
        const decoded = part.replace(/~1/g, "/").replace(/~0/g, "~");
        return /^\d+$/.test(decoded) ? Number(decoded) : decoded;
      });
  let range: readonly number[] | null | undefined;
  for (let length = parts.length; length >= 0 && !range; length--) {
    const node = length === 0 ? doc.contents : doc.getIn(parts.slice(0, length), true);
    if (node && typeof node === "object" && "range" in node) {
      range = (node as { readonly range?: readonly number[] | null }).range;
    }
  }
  return sourceLocation(sourceId, documentIndex, path, lineCounter, range ?? doc.range);
}

function sourceLocation(
  sourceId: string,
  documentIndex: number,
  path: string,
  lineCounter: LineCounter,
  range?: readonly number[] | null,
): SourceLocation {
  const span = sourceSpan(lineCounter, range);
  return { sourceId, documentIndex, path, ...(span ? { span } : {}) };
}

function sourceSpan(
  lineCounter: LineCounter,
  range?: readonly number[] | null,
): SourceSpan | undefined {
  if (!range || range.length < 2) return undefined;
  const startOffset = range[0];
  const endOffset = range.length > 2 ? range[2] : range[1];
  if (startOffset === undefined || endOffset === undefined) return undefined;
  const start = lineCounter.linePos(startOffset);
  const end = lineCounter.linePos(endOffset);
  return {
    start: { line: start.line, column: start.col, offset: startOffset },
    end: { line: end.line, column: end.col, offset: endOffset },
  };
}

function normalizeManifest(manifest: Manifest): ParsedManifest {
  if (manifest.kind === "Schema") {
    return {
      ...manifest,
      spec: {
        ...manifest.spec,
        uniqueIndexes: manifest.spec.uniqueIndexes ?? [],
        indexes: manifest.spec.indexes ?? [],
        searchableFields: manifest.spec.searchableFields ?? [],
        localized: manifest.spec.localized ?? false,
        lifecycle: manifest.spec.lifecycle ?? "publishing",
      },
    };
  }
  return manifest;
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
  rejectUnknownKeys(m, ["apiVersion", "kind", "metadata", "spec"], docIndex, "/");

  if (m["apiVersion"] !== API_VERSION) {
    throw new ManifestParseError(
      `apiVersion must be "${API_VERSION}"; got ${JSON.stringify(m["apiVersion"])}`,
      docIndex,
      "/apiVersion",
      "INVALID_MANIFEST_ENVELOPE",
      m["apiVersion"] === "cms.mantle.aotter.net/v1"
        ? { value: m["apiVersion"], expected: API_VERSION, suggestion: "Run the mantle-update skill to migrate v1 manifests to v2." }
        : undefined,
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
  rejectUnknownKeys(meta as Record<string, unknown>, ["name"], docIndex, "/metadata");
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
  rejectUnknownKeys(
    s,
    [
      "title",
      "description",
      "schema",
      "uiSchema",
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
      throw new ManifestParseError("Schema.spec.scope must bind exactly one field to $ctx.user.id", idx, "/spec/scope");
    }
    const [field, ref] = Object.entries(scope)[0]!;
    const property = properties && typeof properties === "object" && !Array.isArray(properties)
      ? (properties as Record<string, Record<string, unknown>>)[field] : undefined;
    if (ref !== "$ctx.user.id" || !property || property["type"] !== "string" || property["nullable"] === true || property["oneOf"] !== undefined ||
      !Array.isArray(schema["required"]) || !schema["required"].includes(field) ||
      ![...(m.spec.uniqueIndexes ?? []), ...(m.spec.indexes ?? [])].some((index) => index[0] === field)) {
      throw new ManifestParseError("Schema.spec.scope requires a required string field with a leftmost index and the exact $ctx.user.id reference", idx, "/spec/scope");
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

function validateViewSpec(m: ViewManifest, idx: number): ViewManifest {
  const s = m.spec as unknown as Record<string, unknown>;
  rejectUnknownKeys(
    s,
    ["title", "description", "uiSchema", "select", "sql", "surface", "cache", "requires", "input"],
    idx,
    "/spec",
  );
  validateLocalizedText(s["title"], idx, "/spec/title", "View.spec.title", false);
  validateLocalizedText(s["description"], idx, "/spec/description", "View.spec.description", false);
  const hasSelect = s["select"] !== undefined;
  const hasSql = typeof s["sql"] === "string" && (s["sql"] as string).trim().length > 0;
  if (Number(hasSelect) + Number(hasSql) !== 1) {
    throw new ManifestParseError("View.spec requires exactly one of `select` or `sql`", idx, "/spec");
  }
  const surface = s["surface"];
  if (typeof surface !== "string" || !V01_VIEW_SURFACES.has(surface)) {
    throw new ManifestParseError(
      `View.spec.surface is required and must be one of ${[...V01_VIEW_SURFACES].join(", ")}; got ${JSON.stringify(surface)}`,
      idx,
      "/spec/surface",
    );
  }
  if ("cache" in s) validateViewCache(s["cache"], m, idx);
  if ("requires" in s && s["requires"] != null) validateRequires(s["requires"], idx, "View");
  const adminUiProblem = checkViewAdminUi(m).problems[0];
  if (adminUiProblem) {
    throw new ManifestParseError(adminUiProblem.message, idx, adminUiProblem.pointer, "VIEW_UI_INVALID");
  }
  let input: JsonSchema | undefined;
  if ("input" in s && s["input"] != null) {
    input = validateViewInput(s["input"], idx);
    validateJsonSchema(input, idx, "View", m.metadata.name, "/spec/input");
  }
  if (hasSelect) validateViewSelect(s["select"], idx, input);
  else validateViewSql(s["sql"] as string, input, idx);
  return m;
}

function validateViewSelect(raw: unknown, idx: number, input: JsonSchema | undefined): void {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ManifestParseError("View.spec.select must be an object", idx, "/spec/select");
  }
  const query = raw as Record<string, unknown>;
  rejectUnknownKeys(query, ["from", "columns", "where", "orderBy", "limit"], idx, "/spec/select");
  if (typeof query["from"] !== "string" || !query["from"]) {
    throw new ManifestParseError("View.spec.select.from must name a Schema", idx, "/spec/select/from");
  }
  if (query["columns"] !== undefined && (!Array.isArray(query["columns"]) || !query["columns"].length || !query["columns"].every((column: unknown) => typeof column === "string" && column.length > 0))) {
    throw new ManifestParseError("View.spec.select.columns must be a non-empty array of column names", idx, "/spec/select/columns");
  }
  const order = query["orderBy"];
  if (order !== undefined && (typeof order !== "object" || order === null || Array.isArray(order) || Object.keys(order).length !== 1 || !Object.values(order).every((direction) => direction === "asc" || direction === "desc"))) {
    throw new ManifestParseError("View.spec.select.orderBy must name one column and direction", idx, "/spec/select/orderBy");
  }
  if (query["limit"] !== undefined && (!Number.isSafeInteger(query["limit"]) || (query["limit"] as number) < 1 || (query["limit"] as number) > 500)) {
    throw new ManifestParseError("View.spec.select.limit must be 1–500", idx, "/spec/select/limit");
  }
  if (query["where"] !== undefined) validateStoreWhere(query["where"], idx, "/spec/select/where", input, "View");
}

/**
 * One validator for every Store `where` in a manifest (View `select` and
 * inline Procedure programs). A value reference in a `where` must name a
 * required scalar input, so a predicate never silently widens.
 */
function validateStoreWhere(
  raw: unknown,
  idx: number,
  pointer: string,
  input: JsonSchema | undefined,
  atom: "View" | "Procedure",
  budget = { nodes: 0 },
  depth = 0,
): void {
  const invalid = (message: string, at = pointer): never => { throw new ManifestParseError(message, idx, at); };
  if (++budget.nodes > 256 || depth > 16) invalid(`${atom} where exceeds its query budget`);
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || !Object.keys(raw).length) invalid(`${atom} where must be a non-empty object`);
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const at = `${pointer}/${key}`;
    if (key === "and" || key === "or") {
      if (!Array.isArray(value) || !value.length) invalid(`${key} must be a non-empty array`, at);
      (value as unknown[]).forEach((item, index) => validateStoreWhere(item, idx, `${at}/${index}`, input, atom, budget, depth + 1));
    } else if (key === "not") {
      validateStoreWhere(value, idx, at, input, atom, budget, depth + 1);
    } else if (value && typeof value === "object" && !Array.isArray(value) && !Object.hasOwn(value, "$literal")) {
      for (const [operator, operand] of Object.entries(value)) {
        const opPath = `${at}/${operator}`;
        if (!STORE_COMPARISONS.has(operator)) invalid(`Unknown ${atom} comparison '${operator}'`, opPath);
        if (operator === "isNull") {
          if (typeof operand !== "boolean") invalid("isNull must be boolean", opPath);
        } else if (operator === "in" || operator === "notIn") {
          if (Array.isArray(operand)) operand.forEach((item, index) => validateStoreValue(item, idx, `${opPath}/${index}`, input, atom, true));
          else if (operand && typeof operand === "object") {
            const sub = operand as Record<string, unknown>;
            rejectUnknownKeys(sub, ["select", "from", "where"], idx, opPath);
            if (typeof sub["select"] !== "string" || typeof sub["from"] !== "string") invalid("Subquery requires select and from", opPath);
            if (sub["where"] !== undefined) validateStoreWhere(sub["where"], idx, `${opPath}/where`, input, atom, budget, depth + 1);
          } else invalid(`${operator} requires an array or subquery`, opPath);
        } else validateStoreValue(operand, idx, opPath, input, atom, true);
      }
    } else validateStoreValue(value, idx, at, input, atom, true);
  }
}

/**
 * A Store value: a scalar literal, `{ $literal: string }`, `$ctx.user.id`,
 * `$now`, or `$input.<name>` naming a declared scalar input property.
 * `required` demands that the property is also listed in `input.required`.
 */
function validateStoreValue(
  value: unknown,
  idx: number,
  at: string,
  input: JsonSchema | undefined,
  atom: "View" | "Procedure",
  required: boolean,
): void {
  if (Array.isArray(value)) {
    throw new ManifestParseError(`${atom} values must be scalars or value references`, idx, at);
  }
  if (value && typeof value === "object") {
    const literal = value as Record<string, unknown>;
    if (Object.keys(literal).length === 1 && typeof literal["$literal"] === "string") return;
    throw new ManifestParseError(`${atom} values must be scalars or value references`, idx, at);
  }
  if (typeof value !== "string" || !value.startsWith("$")) return;
  if (STORE_REFERENCES.has(value)) return;
  const name = value.startsWith(STORE_INPUT_REFERENCE_PREFIX) ? value.slice(STORE_INPUT_REFERENCE_PREFIX.length) : "";
  const property = name ? input?.properties?.[name] : undefined;
  if (!property) {
    throw new ManifestParseError(
      `Unknown ${atom} value reference '${value}'; use $input.<declared property>, $ctx.user.id, $now or { $literal }.`,
      idx,
      at,
      "STORE_REFERENCE_UNKNOWN",
    );
  }
  if (!SCALAR_TYPES.has(String(property.type))) {
    throw new ManifestParseError(`${atom} reference '${value}' must name a scalar input property`, idx, at, "STORE_REFERENCE_UNKNOWN");
  }
  if (required && !input?.required?.includes(name)) {
    throw new ManifestParseError(
      `${atom} reference '${value}' is used in a predicate, so '${name}' must be listed in input.required`,
      idx,
      at,
      "STORE_REFERENCE_NOT_REQUIRED",
    );
  }
}

function validateViewCache(raw: unknown, view: ViewManifest, idx: number): void {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ManifestParseError("View.spec.cache must be an object", idx, "/spec/cache", "VIEW_CACHE_INVALID");
  }
  const cache = raw as Record<string, unknown>;
  rejectUnknownKeys(cache, ["sharedMaxAge"], idx, "/spec/cache");
  const maxAge = cache["sharedMaxAge"];
  if (!Number.isInteger(maxAge) || (maxAge as number) < 1 || (maxAge as number) > 86_400) {
    throw new ManifestParseError(
      "View.spec.cache.sharedMaxAge must be an integer from 1 to 86400",
      idx,
      "/spec/cache/sharedMaxAge",
      "VIEW_CACHE_INVALID",
    );
  }
  if (view.spec.surface !== "public" || view.spec.sql || view.spec.requires) {
    throw new ManifestParseError(
      "View.spec.cache requires an unguarded public select View",
      idx,
      "/spec/cache",
      "VIEW_CACHE_INVALID",
    );
  }
}

function validateViewSql(sql: string, input: JsonSchema | undefined, idx: number): void {
  const trimmed = sql.trim();
  if (!/^select\b/i.test(trimmed) || trimmed.includes(";")) {
    throw new ManifestParseError("View.spec.sql must be one SELECT statement without a semicolon", idx, "/spec/sql");
  }
  const properties = (input?.properties ?? {}) as Record<string, unknown>;
  const required = new Set(input?.required ?? []);
  for (const match of trimmed.matchAll(/:([A-Za-z_][A-Za-z0-9_]*)/g)) {
    const name = match[1]!;
    if (!Object.prototype.hasOwnProperty.call(properties, name)) {
      throw new ManifestParseError(
        `View.spec.sql references unknown input '${name}'; declare it under View.spec.input.properties.`,
        idx,
        "/spec/sql",
        "STORE_REFERENCE_UNKNOWN",
      );
    }
    if (!required.has(name)) {
      throw new ManifestParseError(
        `View.spec.sql references optional input '${name}'; bound SQL inputs must appear in View.spec.input.required.`,
        idx,
        "/spec/sql",
        "STORE_REFERENCE_NOT_REQUIRED",
      );
    }
  }
}

function validateViewInput(raw: unknown, idx: number): JsonSchema {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ManifestParseError("View.spec.input must be a JSON Schema object", idx, "/spec/input", "VIEW_INPUT_INVALID_SHAPE");
  }
  const p = raw as Record<string, unknown>;
  if (p["type"] !== "object") {
    throw new ManifestParseError(
      `View.spec.input.type must be "object"; got ${JSON.stringify(p["type"])}`,
      idx,
      "/spec/input/type",
      "VIEW_INPUT_INVALID_SHAPE",
    );
  }
  const props = p["properties"];
  if (typeof props !== "object" || props === null || Array.isArray(props)) {
    throw new ManifestParseError(
      "View.spec.input.properties is required (declare each accepted input)",
      idx,
      "/spec/input/properties",
      "VIEW_INPUT_INVALID_SHAPE",
    );
  }
  for (const reserved of VIEW_INPUT_RESERVED) {
    if (Object.hasOwn(props, reserved)) {
      throw new ManifestParseError(
        `View.spec.input.properties.${reserved} is reserved (the runtime owns ${VIEW_INPUT_RESERVED.join(", ")} for pagination); rename the input.`,
        idx,
        `/spec/input/properties/${reserved}`,
        "VIEW_INPUT_RESERVED_NAME",
      );
    }
  }
  return raw as JsonSchema;
}

function validateProcedureSpec(m: ProcedureManifest, idx: number): ProcedureManifest {
  const s = m.spec as unknown as Record<string, unknown>;
  rejectUnknownKeys(
    s,
    ["title", "description", "requires", "input", "uiSchema", "output", "handler", "mcp", "target"],
    idx,
    "/spec",
  );
  if (s["mcp"] !== undefined) {
    const mcp = s["mcp"];
    if (typeof mcp !== "object" || mcp === null || Array.isArray(mcp)) {
      throw new ManifestParseError("Procedure.spec.mcp must be an object of boolean tool annotations", idx, "/spec/mcp");
    }
    rejectUnknownKeys(mcp as Record<string, unknown>, [...PROCEDURE_MCP_ANNOTATION_KEYS], idx, "/spec/mcp");
    for (const key of PROCEDURE_MCP_ANNOTATION_KEYS) {
      const value = (mcp as Record<string, unknown>)[key];
      if (value !== undefined && typeof value !== "boolean") {
        throw new ManifestParseError(`Procedure.spec.mcp.${key} must be a boolean`, idx, `/spec/mcp/${key}`);
      }
    }
    const hints = mcp as { readOnlyHint?: boolean; destructiveHint?: boolean };
    if (hints.readOnlyHint === true && hints.destructiveHint === true) {
      throw new ManifestParseError("Procedure.spec.mcp cannot be both readOnlyHint: true and destructiveHint: true", idx, "/spec/mcp");
    }
  }
  if (s["target"] !== undefined) validateProcedureTargetShape(s["target"], idx);
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
  validateJsonSchema(s["input"], idx, "Procedure", m.metadata.name, "/spec/input");
  const uiProblem = checkFormUiSchema(s["input"] as JsonSchema, s["uiSchema"], "Procedure")[0];
  if (uiProblem) {
    throw new ManifestParseError(uiProblem.message, idx, uiProblem.pointer, "SCHEMA_UI_INVALID");
  }
  if (typeof s["output"] !== "object" || s["output"] === null) {
    throw new ManifestParseError("Procedure.spec.output is required (JSON Schema)", idx, "/spec/output");
  }
  validateJsonSchema(s["output"], idx, "Procedure", m.metadata.name, "/spec/output");
  const handler = s["handler"] as Record<string, unknown> | undefined;
  if (!handler) {
    throw new ManifestParseError("Procedure.spec.handler is required", idx, "/spec/handler");
  }
  validateHandlerBinding(handler, idx, s["input"] as JsonSchema);
  if ("requires" in s && s["requires"] != null) {
    validateRequires(s["requires"], idx, "Procedure");
  }
  return m;
}

/** Shape only; graph validation checks the Schema and input properties. */
function validateProcedureTargetShape(target: unknown, idx: number): void {
  if (typeof target !== "object" || target === null || Array.isArray(target)) {
    throw new ManifestParseError(
      "Procedure.spec.target must be an object { schema, id, version? }",
      idx,
      "/spec/target",
      "PROCEDURE_TARGET_INVALID",
    );
  }
  rejectUnknownKeys(target as Record<string, unknown>, [...PROCEDURE_TARGET_KEYS], idx, "/spec/target");
  for (const key of PROCEDURE_TARGET_KEYS) {
    const value = (target as Record<string, unknown>)[key];
    if (value === undefined && key === "version") continue;
    if (typeof value !== "string" || value.length === 0) {
      throw new ManifestParseError(
        `Procedure.spec.target.${key} must be a non-empty string`,
        idx,
        `/spec/target/${key}`,
        "PROCEDURE_TARGET_INVALID",
      );
    }
  }
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

function validateJsonSchema(
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

function escapeJsonPointerSegment(value: string): string {
  return value.replace(/~/g, "~0").replace(/\//g, "~1");
}

function validateHandlerBinding(h: Record<string, unknown>, idx: number, input: JsonSchema): void {
  if ("kind" in h) {
    throw new ManifestParseError(
      "Procedure.spec.handler.kind is not v2 grammar; a handler is { ref } or { store }",
      idx,
      "/spec/handler/kind",
      "INVALID_MANIFEST_ENVELOPE",
      { value: h["kind"], suggestion: "v1 `kind: ref | builtin` handlers are gone; run the mantle-update skill." },
    );
  }
  const hasRef = "ref" in h;
  const hasStore = "store" in h;
  if (Number(hasRef) + Number(hasStore) !== 1) {
    throw new ManifestParseError(
      "Procedure.spec.handler must be exactly one of { ref } or { store }",
      idx,
      "/spec/handler",
    );
  }
  if (hasRef) {
    rejectUnknownKeys(h, ["ref"], idx, "/spec/handler");
    if (typeof h["ref"] !== "string" || (h["ref"] as string).length === 0) {
      throw new ManifestParseError("Procedure.spec.handler.ref is required (non-empty registration key)", idx, "/spec/handler/ref");
    }
    return;
  }
  rejectUnknownKeys(h, ["store"], idx, "/spec/handler");
  const program = h["store"];
  if (!Array.isArray(program) || program.length === 0) {
    throw new ManifestParseError("Procedure.spec.handler.store must be a non-empty array of write ops", idx, "/spec/handler/store", "STORE_PROGRAM_INVALID");
  }
  program.forEach((op, index) => validateStoreProgramOp(op, idx, `/spec/handler/store/${index}`, input));
}

/** Shape and references of one inline write op; Schema columns, indexes
 *  and hook rules are checked by the graph validator. */
function validateStoreProgramOp(raw: unknown, idx: number, at: string, input: JsonSchema): void {
  const invalid = (message: string, pointer = at): never => {
    throw new ManifestParseError(message, idx, pointer, "STORE_PROGRAM_INVALID");
  };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) invalid("A Store program op must be an object");
  const op = raw as Record<string, unknown>;
  const verbs = ["insert", "update", "delete"].filter((verb) => verb in op);
  if (verbs.length !== 1) invalid("A Store program op needs exactly one of insert, update or delete");
  const verb = verbs[0]!;
  if (typeof op[verb] !== "string" || !op[verb]) invalid(`${verb} must name a Schema`, `${at}/${verb}`);
  const fields = (key: "values" | "set"): void => {
    const value = op[key];
    if (value === "$input") return;
    if (typeof value !== "object" || value === null || Array.isArray(value) || !Object.keys(value).length) {
      invalid(`${key} must be a non-empty object or "$input"`, `${at}/${key}`);
    }
    for (const [column, item] of Object.entries(value as Record<string, unknown>)) {
      if (column === "status" && key === "set") {
        // A status change is a lifecycle transition, so it is always explicit.
        if (item !== "draft" && item !== "published" && item !== "archived") {
          invalid("set.status must be draft, published or archived", `${at}/set/status`);
        }
        continue;
      }
      if (WHOLE_INPUT_EXCLUDED.has(column) || RESERVED_ENTRY_COLUMNS.includes(column as never)) {
        invalid(`${key}.${column} is a native column the Store manages`, `${at}/${key}/${column}`);
      }
      validateStoreValue(item, idx, `${at}/${key}/${column}`, input, "Procedure", false);
    }
  };
  const guard = (key: "lock" | "expect"): void => {
    if (!(key in op)) return;
    if (key === "expect") {
      if (!Number.isSafeInteger(op["expect"]) || (op["expect"] as number) < 0) invalid("expect must be a non-negative integer", `${at}/expect`);
    } else validateStoreValue(op["lock"], idx, `${at}/lock`, input, "Procedure", true);
  };
  if (verb === "insert") {
    rejectUnknownKeys(op, ["insert", "values", "id", "onConflict"], idx, at);
    fields("values");
    if ("id" in op) validateStoreValue(op["id"], idx, `${at}/id`, input, "Procedure", true);
    const conflict = op["onConflict"];
    if (conflict !== undefined && conflict !== "ignore") {
      if (typeof conflict !== "object" || conflict === null || Array.isArray(conflict)) invalid('onConflict must be "ignore" or { columns, update }', `${at}/onConflict`);
      const spec = conflict as Record<string, unknown>;
      rejectUnknownKeys(spec, ["columns", "update"], idx, `${at}/onConflict`);
      for (const key of ["columns", "update"] as const) {
        const list = spec[key];
        if (!Array.isArray(list) || !list.length || !list.every((item) => typeof item === "string" && item)) {
          invalid(`onConflict.${key} must be a non-empty array of column names`, `${at}/onConflict/${key}`);
        }
      }
    }
    return;
  }
  if (verb === "update") {
    rejectUnknownKeys(op, ["update", "set", "where", "lock", "expect"], idx, at);
    fields("set");
  } else {
    rejectUnknownKeys(op, ["delete", "where", "lock", "expect"], idx, at);
  }
  if (op["where"] === undefined) invalid(`${verb} requires where`, `${at}/where`);
  validateStoreWhere(op["where"], idx, `${at}/where`, input, "Procedure");
  guard("lock");
  guard("expect");
}

function validateRequires(req: unknown, idx: number, atom: "Procedure" | "View"): void {
  if (typeof req !== "object" || req === null) {
    throw new ManifestParseError(`${atom}.spec.requires must be an object`, idx);
  }
  const r = req as Record<string, unknown>;
  rejectUnknownKeys(r, ["auth", "guard"], idx, "/spec/requires");
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
  rejectUnknownKeys(a, ["all"], idx, "/spec/requires/auth");
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
    validateAuthPredicate(
      all[i],
      idx,
      `${atom}.spec.requires.auth.all[${i}]`,
      `/spec/requires/auth/all/${i}`,
    );
  }
}

function validateAuthPredicate(
  p: unknown,
  idx: number,
  path: string,
  pointer: string,
): asserts p is AuthPredicate {
  if (p === "ctx.user" || p === "ctx.auth") return;
  if (typeof p === "object" && p !== null && !Array.isArray(p)) {
    const o = p as Record<string, unknown>;
    if ("ctx.auth.scope" in o) {
      rejectUnknownKeys(o, ["ctx.auth.scope"], idx, pointer);
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
      rejectUnknownKeys(o, ["ctx.staff"], idx, pointer);
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
  throw new ManifestParseError(
    `${path} must be 'ctx.user', 'ctx.auth', { 'ctx.auth.scope': <scope> }, or { 'ctx.staff': [<role>, ...] }; got ${JSON.stringify(p)}`,
    idx,
  );
}

function validateHttpSource(source: Record<string, unknown>, idx: number): void {
  rejectUnknownKeys(source, ["kind", "method", "path"], idx, "/spec/source");
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
  rejectUnknownKeys(source, ["kind", "schema", "on"], idx, "/spec/source");
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
}

function validateMcpSource(source: Record<string, unknown>, idx: number): void {
  rejectUnknownKeys(source, ["kind", "surface"], idx, "/spec/source");
  const surface = source["surface"];
  if (typeof surface !== "string" || !V01_MCP_TRIGGER_SURFACES.has(surface)) {
    throw new ManifestParseError(
      `Trigger.spec.source.surface must be one of ${[...V01_MCP_TRIGGER_SURFACES].join(", ")}; got ${JSON.stringify(surface)}`,
      idx,
      "/spec/source/surface",
    );
  }
}

function validateScheduleSource(source: Record<string, unknown>, idx: number): void {
  rejectUnknownKeys(source, ["kind", "cron", "enabled"], idx, "/spec/source");
  const cron = source["cron"];
  // Five-field POSIX cron; weekday 0=Sunday through 6=Saturday. Hosts
  // translate it to their own dialect (ADR-0032 decision 5).
  const bounds = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]] as const;
  const fields = typeof cron === "string" ? cron.split(" ") : [];
  const valid = fields.length === 5 && fields.every((field, index) => {
    const [min, max] = bounds[index]!;
    return field.split(",").every((part) => {
      const match = /^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/.exec(part);
      if (!match) return false;
      const start: number = match[1] === "*" ? min : Number(match[1]);
      const end: number = match[2] === undefined ? (match[1] === "*" ? max : start) : Number(match[2]);
      const step = match[3] === undefined ? 1 : Number(match[3]);
      return start >= min && end <= max && start <= end && step >= 1 && (match[3] === undefined || match[1] === "*" || match[2] !== undefined);
    });
  });
  if (!valid) throw new ManifestParseError(
    "Trigger.spec.source.cron must be a five-field POSIX UTC cron expression (minute hour day month weekday, 0=Sunday)",
    idx, "/spec/source/cron",
  );
  if (source["enabled"] !== undefined && typeof source["enabled"] !== "boolean") {
    throw new ManifestParseError("Trigger.spec.source.enabled must be boolean", idx, "/spec/source/enabled");
  }
}

function validateTriggerSpec(m: TriggerManifest, idx: number): TriggerManifest {
  const s = m.spec as unknown as Record<string, unknown>;
  rejectUnknownKeys(s, ["source", "target"], idx, "/spec");
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
  else if (sourceKind === "schedule") validateScheduleSource(source, idx);
  const target = s["target"] as Record<string, unknown> | undefined;
  if (!target || typeof target["procedure"] !== "string") {
    throw new ManifestParseError("Trigger.spec.target.procedure is required (string)", idx, "/spec/target/procedure");
  }
  rejectUnknownKeys(target, ["procedure"], idx, "/spec/target");
  return m;
}

