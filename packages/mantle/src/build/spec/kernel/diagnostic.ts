/**
 * Structured diagnostic shape — see ADR-0008. Used uniformly across
 * static validation, boot-time, and runtime feedback. The public `test`
 * phase remains reserved for consumer-authored test diagnostics; Core's
 * shipped performance harnesses emit purpose-shaped reports instead.
 *
 * Codes are unprefixed UPPER_SNAKE strings; the `phase` field
 * disambiguates which loop emitted each diagnostic. The same `code`
 * may appear in multiple phases when it names the same root cause —
 * AI consumers can group by code OR filter by phase.
 *
 * `candidates` is security-sensitive at runtime; `redactForWire`
 * strips it before HTTP egress.
 */
export type Phase = "validate" | "test" | "boot" | "runtime";

/**
 * Closed catalog of diagnostic codes the SDK emits across all phases.
 * Per ADR-0008, spec **defines** the catalog; runtime / cli / adapters
 * **emit** them. Codes in the cross-phase and runtime-only sections
 * below are not raised by spec source — they live here because the
 * catalog is the public contract, not the union of what spec happens
 * to throw today. Adding a new code is a grammar-revise event
 * (ADR-0001).
 *
 * Single source of truth: the const array drives `DiagnosticCode`
 * (type), so adding a code is one edit.
 */
export const DIAGNOSTIC_CODES = [
  "RESOURCE_EXHAUSTED",
  "RESOURCE_UNAVAILABLE",
  "RATE_LIMITED",
  "OUTCOME_UNKNOWN",
  "PARTIAL_FAILURE",
  "PRECONDITION_FAILED",
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
  "AUTH_PREDICATE_NOT_IN_ENUM",
  "GUARD_PROCEDURE_UNKNOWN",
  "GUARD_SELF_REFERENCE",
  "GUARD_PROCEDURE_NOT_REF",
  "GUARD_CHAIN_NOT_ALLOWED",
  "SCHEMA_INDEX_INVALID",
  "SCHEMA_INDEX_FIELD_UNKNOWN",
  "UNIQUE_INDEX_FIELD_UNKNOWN",
  "SCHEMA_SEARCH_INVALID",
  "SCHEMA_SEARCH_FIELD_UNKNOWN",
  "SCHEMA_TTL_INVALID",
  "SCHEMA_UI_INVALID",
  // Admin extensions (ADR-lite 1376): a bad declaration, and a uiSchema name that is missing, of the wrong target or given bad options.
  "UI_EXTENSION_INVALID",
  "UI_EXTENSION_UNKNOWN",
  "UI_EXTENSION_TARGET",
  "UI_EXTENSION_OPTIONS",
  "SCHEMA_NAME_CASE_COLLISION",
  // ADR-0043: two Schemas project to one `store.db` reader name, or a name is reserved.
  "SCHEMA_READER_NAME_COLLISION",
  "FIELD_NAME_CASE_COLLISION",
  "MANIFEST_ROOT_NOT_FOUND",
  "MANIFEST_READ_FAILED",
  // `mantle generate` (ADR-0032 decision 12): a selected feature's package is not installed, or it needs an identity.
  "GENERATE_FEATURE_DEPENDENCY_MISSING",
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
  // Reserved for consumer-authored test diagnostics.
  "FIXTURE_SCHEMA_VIOLATION",
  // Cross-phase (validate / boot / runtime as applicable).
  "HANDLER_NOT_REGISTERED",
  "HANDLER_NOT_DECLARED",
  "PLAN_FINGERPRINT_MISMATCH",
  "SCHEDULE_NOT_WIRED",
  "STORAGE_CHANGE_BLOCKED",
  "STORAGE_TABLE_NOT_OWNED",
  "INVOCATION_DEPTH_EXCEEDED",
  "TRIGGER_TARGET_PROCEDURE_UNKNOWN",
  "SCHEDULE_INPUT_INVALID",
  "SCHEDULE_AUTH_INVALID",
  "TRIGGER_PATH_COLLISION",
  "TRIGGER_PATH_INVALID",
  "MCP_TOOL_NAME_COLLISION",
  "MCP_TOOL_DESCRIPTION_MISSING",
  "MCP_TOOL_INPUT_UNION_AMBIGUOUS",
  "MCP_TOOL_INPUT_UNBOUNDED",
  "MANTLE_REF_INVALID",
  "PROCEDURE_TARGET_INVALID",
  "PROCEDURE_NOT_FOUND",
  "NOT_FOUND",
  "METHOD_NOT_ALLOWED",
  // Lifecycle hooks: validate / boot.
  "LIFECYCLE_SCHEMA_UNKNOWN",
  "LIFECYCLE_HOOK_REJECTED",
  "LIFECYCLE_TARGET_NOT_REF",
  // Locale + translates: validate / boot.
  "SCHEMA_LOCALIZED_REQUIRES_SITE_LOCALES",
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
  "ENTITLEMENT_REQUIRED",
  "CONFLICT",
  "DISPATCHER_NOT_BUILT",
  "INTERNAL_ERROR",
  "OUTPUT_VALIDATION_FAILED",
  // Locale-data invariants: boot + runtime.
  "INVALID_LOCALE",
  // Media uploads (runtime-only). Adapter signs presigned PUTs; commit
  // verifies metadata. Codes surface from Create / Commit use cases.
  "MEDIA_NOT_CONFIGURED",
  "SITE_NOT_CONFIGURED",
  "MEDIA_UPLOAD_EXPIRED",
  "MEDIA_OBJECT_NOT_FOUND",
  "MEDIA_MIME_REJECTED",
  "MEDIA_SIZE_EXCEEDED",
  "MEDIA_SVG_REJECTED",
  "MEDIA_CHECKSUM_MISMATCH",
  "MEDIA_PURPOSE_REJECTED",
  "MEDIA_VARIANTS_INCOMPLETE",
  "MEDIA_VARIANT_SIZE_EXCEEDED",
  "MEDIA_VARIANTS_SUSPICIOUS_SIZE",
  "MEDIA_ASSET_NOT_FOUND",
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
  /** Safe effect/retry facts supplied by a port; never provider payloads. */
  readonly failure?: {
    readonly outcome: "not-applied" | "partial" | "unknown";
    readonly retry: "never" | "after-change" | "safe" | "reconcile";
    readonly resource?: string;
  };
  /** Why a `CONFLICT` write failed (ADR-0032 decision 1); `opIndex` names the statement in the batch (ADR-0034). */
  readonly conflict?: {
    readonly opIndex?: number;
    readonly reason: "lock" | "expect" | "unique";
  };
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
    ...(input.failure ? { failure: input.failure } : {}),
    ...(input.conflict ? { conflict: input.conflict } : {}),
  };
}

/** Phase-stamping helpers — equivalent to `makeDiagnostic({...input, phase})`
 *  but read cleaner at call sites. `phase: "test"` has no Core helper because
 *  the shipped performance harnesses emit purpose-shaped reports; the phase
 *  remains part of the public Diagnostic contract for consumer tests. */
export const validateDiagnostic = (input: PhaselessInput): Diagnostic => makeDiagnostic({ ...input, phase: "validate" });
export const bootDiagnostic = (input: PhaselessInput): Diagnostic => makeDiagnostic({ ...input, phase: "boot" });
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

const BRAND = Symbol.for("net.aotter.mantle.DiagnosticError");

/**
 * Throwable carrier for one or more Diagnostics. Layers that surface
 * an error across a transport boundary (HTTP handler, MCP tool call,
 * render pipeline) throw this so the boundary catch can detect a
 * structured payload and emit it on the wire instead of falling back
 * to the INTERNAL_ERROR envelope reserved for genuinely unexpected
 * throws.
 */
export class DiagnosticError extends Error {
  /**
   * A handler bundled with its own copy of this class (a closed-module artifact) still throws a DiagnosticError: `instanceof`
   * matches the brand, not the class identity, so the runtime keeps its code instead of reporting INTERNAL_ERROR.
   */
  static override [Symbol.hasInstance](value: unknown): boolean {
    if (this !== DiagnosticError) return Function.prototype[Symbol.hasInstance].call(this, value);
    return typeof value === "object" && value !== null && (value as Record<symbol, unknown>)[BRAND] === true;
  }
  readonly [BRAND] = true;
  readonly diagnostics: readonly Diagnostic[];
  constructor(diagnostic: Diagnostic | readonly Diagnostic[], options?: ErrorOptions) {
    const list = Array.isArray(diagnostic) ? diagnostic : [diagnostic as Diagnostic];
    const head = list[0];
    super(head ? head.message : "DiagnosticError", options);
    this.name = "DiagnosticError";
    this.diagnostics = list;
  }

  /** First diagnostic — convenience for single-diagnostic call sites. */
  get diagnostic(): Diagnostic {
    const d = this.diagnostics[0];
    if (!d) throw new Error("DiagnosticError carries no diagnostics");
    return d;
  }
}
