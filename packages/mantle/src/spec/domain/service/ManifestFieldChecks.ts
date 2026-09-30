/** Field checks every manifest kind shares: LocalizedText, unknown keys, the kind and enum sets, and the parse error. */
import type { Diagnostic, DiagnosticCode } from "../../kernel/diagnostic.js";
import { LIFECYCLE_HOOKS, MCP_TRIGGER_SURFACES, VIEW_SURFACES, type HttpMethod, type LifecycleHook, type ManifestKind } from "../model/ManifestGrammar.js";

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
export function validateLocalizedText(
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
 * Day-1 envelope-and-shape parser. The linker (`mantle generate`) does
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

export const KNOWN_KINDS: ReadonlySet<ManifestKind> = new Set([
  "Schema",
  "View",
  "Procedure",
  "Trigger",
]);

export const V01_TRIGGER_SOURCE_KINDS: ReadonlySet<string> = new Set([
  "http",
  "lifecycle",
  "mcp",
  "schedule",
]);

export const V01_HTTP_METHODS: ReadonlySet<HttpMethod> = new Set([
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
]);

export const V01_LIFECYCLE_HOOKS: ReadonlySet<LifecycleHook> = new Set(LIFECYCLE_HOOKS);
export const V01_MCP_TRIGGER_SURFACES: ReadonlySet<string> = new Set(MCP_TRIGGER_SURFACES);
export const V01_VIEW_SURFACES: ReadonlySet<string> = new Set(VIEW_SURFACES);
export const V01_LIFECYCLE_MODES: ReadonlySet<string> = new Set(["publishing", "operational"]);

export function rejectUnknownKeys(
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

export function escapeJsonPointerSegment(value: string): string {
  return value.replace(/~/g, "~0").replace(/\//g, "~1");
}
