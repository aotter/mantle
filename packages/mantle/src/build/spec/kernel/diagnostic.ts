/**
 * Structured diagnostic shape — see ADR-0008. The compiler emits it for
 * static validation and for the runtime-shaped refusals of its SQL lowering.
 *
 * Codes are unprefixed UPPER_SNAKE strings; the `phase` field
 * disambiguates which loop emitted each diagnostic. The same `code`
 * may appear in multiple phases when it names the same root cause —
 * AI consumers can group by code OR filter by phase.
 *
 * `candidates` is security-sensitive at runtime; `redactForWire`
 * strips it before HTTP egress.
 */
export type Phase = "validate" | "runtime";

/**
 * Closed catalog of diagnostic codes the SDK emits. Every code here is raised
 * somewhere in the package source; the cross-phase and runtime-only sections
 * name codes the request modules raise with their own types. Adding a new code
 * is a grammar-revise event (ADR-0001).
 *
 * Single source of truth: the const array drives `DiagnosticCode`
 * (type), so adding a code is one edit.
 */
export const DIAGNOSTIC_CODES = [
  "AUTH_ROLE_REMOVED",
  "USER_FIELD_VALUES_UNENUMERATED",
  "USER_FIELD_INVALID",
  "USER_FIELD_CONFLICT",
  "USER_FIELD_POSITION",
  "USER_REF_SCOPE_ONLY",
  "USER_SCOPE_PUBLIC_ANON_EMPTY",
  "OUTCOME_UNKNOWN",
  "PARTIAL_FAILURE",
  // Validate-only.
  "INVALID_MANIFEST_ENVELOPE",
  "DUPLICATE_NAME",
  "VIEW_INPUT_INVALID_SHAPE",
  "VIEW_INPUT_RESERVED_NAME",
  "VIEW_CACHE_INVALID",
  "VIEW_UI_INVALID",
  "REQUIRED_FIELD_UNKNOWN",
  "INVALID_PATTERN",
  "JSON_SCHEMA_UNSUPPORTED",
  "JSON_SCHEMA_REF_INVALID",
  "JSON_SCHEMA_LIMIT_EXCEEDED",
  "SCHEMA_INDEX_INVALID",
  "SCHEMA_INDEX_FIELD_UNKNOWN",
  "UNIQUE_INDEX_FIELD_UNKNOWN",
  "SCHEMA_SEARCH_INVALID",
  "SCHEMA_SEARCH_FIELD_UNKNOWN",
  "SCHEMA_TTL_INVALID",
  // #1822: a malformed `Schema.spec.lock`, and a lock `EXISTS` no declared index serves.
  "SCHEMA_LOCK_INVALID",
  "LOCK_INDEX_MISSING",
  // #1822: `Schema.spec.publishing` malformed, or on a Schema that is not `lifecycle: publishing`.
  "SCHEMA_PUBLISHING_INVALID",
  "SCHEMA_UI_INVALID",
  "SCHEMA_NAME_CASE_COLLISION",
  // ADR-0043: two Schemas project to one `store.db` reader name, or a name is reserved.
  "SCHEMA_READER_NAME_COLLISION",
  "FIELD_NAME_CASE_COLLISION",
  // Store SQL compile (ADR-0034): raised by the CLI compiler and, for the
  // shared allowlist, by the runtime's plan validation.
  "SQL_SYNTAX",
  "SQL_UNSUPPORTED",
  "SQL_FUNCTION",
  "SQL_RELATION",
  "SQL_COLUMN",
  "SQL_WRITE",
  "SQL_SHAPE",
  "SQL_TYPE",
  // Cross-phase (validate / runtime as applicable).
  "HANDLER_NOT_REGISTERED",
  "TRIGGER_TARGET_PROCEDURE_UNKNOWN",
  "TRIGGER_PATH_COLLISION",
  "TRIGGER_PATH_INVALID",
  "MCP_TOOL_NAME_COLLISION",
  "MCP_TOOL_DESCRIPTION_MISSING",
  "MANTLE_REF_INVALID",
  "PROCEDURE_TARGET_INVALID",
  "NOT_FOUND",
  "METHOD_NOT_ALLOWED",
  // Locale + translates: validate.
  "TRANSLATES_PARENT_UNKNOWN",
  "TRANSLATES_REQUIRES_LOCALIZED",
  "TRANSLATES_REQUIRES_CONTENT_FIELD",
  "TRANSLATES_FIELD_NOT_IN_PARENT",
  "TRANSLATES_FIELD_NOT_IN_CHILD",
  "TRANSLATES_PARENT_IS_LOCALIZED",
  "SCHEMA_TTL_TRANSLATION_UNSUPPORTED",
  // Runtime-only. Consumer tests may preserve or restamp the phase.
  "INPUT_VALIDATION_FAILED",
  "UNAUTHENTICATED",
  "AUTH_DENIED",
  "CONFLICT",
  "INTERNAL_ERROR",
  "OUTPUT_VALIDATION_FAILED",
  // Media uploads (runtime-only). Adapter signs presigned PUTs; commit
  // verifies metadata. Codes surface from Create / Commit use cases.
  "MEDIA_NOT_CONFIGURED",
  "SITE_NOT_CONFIGURED",
  "MEDIA_UPLOAD_EXPIRED",
  "MEDIA_OBJECT_NOT_FOUND",
  "MEDIA_MIME_REJECTED",
  "MEDIA_SVG_REJECTED",
  "MEDIA_PURPOSE_REJECTED",
  "MEDIA_VARIANTS_INCOMPLETE",
  "MEDIA_VARIANT_SIZE_EXCEEDED",
  "MEDIA_VARIANTS_SUSPICIOUS_SIZE",
  "MEDIA_ASSET_NOT_FOUND",
  "MEDIA_NOT_OWNED",
] as const;

export type DiagnosticCode = (typeof DIAGNOSTIC_CODES)[number];

export interface SourcePosition {
  readonly line: number;
  readonly column: number;
  readonly offset: number;
}

export interface SourceSpan {
  readonly start: SourcePosition;
  readonly end: SourcePosition;
}

/** Authored location retained independently from a rendered diagnostic path. */
export interface SourceLocation {
  readonly sourceId: string;
  readonly documentIndex: number;
  /** JSON Pointer inside the YAML document. */
  readonly path: string;
  readonly span?: SourceSpan;
}

export interface Diagnostic {
  readonly code: DiagnosticCode;
  readonly phase: Phase;
  readonly severity: "error" | "warning";
  readonly path: string;
  readonly source?: SourceLocation;
  readonly value?: unknown;
  readonly expected?: string;
  readonly candidates?: readonly string[];
  readonly suggestion?: string;
  readonly message: string;
}

/**
 * Build a Diagnostic with a derived default `message`. Call sites may supply
 * contextual prose, but the structured fields remain authoritative.
 */
export function makeDiagnostic(
  input: Omit<Diagnostic, "message"> & { message?: string },
): Diagnostic {
  const { code, phase, severity, path, source, value, expected, candidates, suggestion } = input;
  let msg = input.message;
  if (!msg) {
    const parts: string[] = [`[${phase}/${code}] at ${path}`];
    if (expected) parts.push(`expected ${expected}`);
    if (value !== undefined) parts.push(`got ${formatValue(value)}`);
    if (suggestion) parts.push(`(did you mean ${suggestion}?)`);
    msg = parts.join("; ");
  }
  return {
    code,
    phase,
    severity,
    path,
    ...(source ? { source } : {}),
    value,
    expected,
    candidates,
    suggestion,
    message: msg,
  };
}

/** Phase-stamping helpers — equivalent to `makeDiagnostic({...input, phase})`
 *  but read cleaner at call sites. */
export const validateDiagnostic = (input: PhaselessInput): Diagnostic => makeDiagnostic({ ...input, phase: "validate" });
export const runtimeDiagnostic = (input: PhaselessInput): Diagnostic => makeDiagnostic({ ...input, phase: "runtime" });

type PhaselessInput = Omit<Diagnostic, "phase" | "message"> & { message?: string };

function formatValue(v: unknown): string {
  if (v === null) return "null";
  if (v === undefined) return "undefined";
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    const s = JSON.stringify(v);
    return s.length > 100 ? s.slice(0, 97) + "..." : s;
  } catch {
    return "[unserializable]";
  }
}

/**
 * Throwable carrier for one or more Diagnostics. Layers that surface
 * an error across a transport boundary (HTTP handler, MCP tool call,
 * render pipeline) throw this so the boundary catch can detect a
 * structured payload and emit it on the wire instead of falling back
 * to the INTERNAL_ERROR envelope reserved for genuinely unexpected
 * throws.
 */
export class DiagnosticError extends Error {
  readonly diagnostics: readonly Diagnostic[];
  constructor(diagnostic: Diagnostic | readonly Diagnostic[], options?: ErrorOptions) {
    const list = Array.isArray(diagnostic) ? diagnostic : [diagnostic as Diagnostic];
    const head = list[0];
    super(head ? head.message : "DiagnosticError", options);
    this.name = "DiagnosticError";
    this.diagnostics = list;
  }
}
