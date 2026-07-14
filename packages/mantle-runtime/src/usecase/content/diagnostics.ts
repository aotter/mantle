import {
  DiagnosticError,
  runtimeDiagnostic,
  type ContentState,
  type Diagnostic,
} from "@aotter/mantle-spec";
import {
  EntryStatusConflict,
  EntryVersionConflict,
} from "../../domain/model/EntryRow.js";

/**
 * Wrap a content-op repository call: convert chokepoint conflict
 * throws into structured `CONFLICT` diagnostics. Other throws
 * propagate.
 *
 * Used by every content-op use case so the catch shape stays uniform.
 */
export async function withConflictDiagnostic<T>(
  path: string,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof EntryVersionConflict) {
      throw new DiagnosticError(
        runtimeDiagnostic({
          code: "CONFLICT",
          severity: "error",
          path,
          value: { expected: err.expected, found: err.actual },
          expected: `version === ${err.expected}`,
          message: `Version mismatch on entry '${err.id}': expected ${err.expected}, found ${err.actual}.`,
        }),
      );
    }
    if (err instanceof EntryStatusConflict) {
      throw new DiagnosticError(
        runtimeDiagnostic({
          code: "CONFLICT",
          severity: "error",
          path,
          value: err.actual,
          expected: `status === '${err.expected}'`,
          message: `Status mismatch on entry '${err.id}': expected '${err.expected}', found '${err.actual}'. Probably a concurrent state change.`,
        }),
      );
    }
    throw err;
  }
}

export function notFoundDiagnostic(
  path: string,
  collection: string,
  id: string,
): Diagnostic {
  return runtimeDiagnostic({
    code: "NOT_FOUND",
    severity: "error",
    path,
    value: id,
    expected: `existing entry id in collection '${collection}'`,
    message: `No entry with id '${id}' in collection '${collection}'.`,
  });
}

export function illegalTransitionDiagnostic(
  path: string,
  from: ContentState,
  to: ContentState,
): Diagnostic {
  return runtimeDiagnostic({
    code: "CONFLICT",
    severity: "error",
    path,
    value: { from, to },
    expected: `valid transition from '${from}' (per Schema lifecycle)`,
    message: `Illegal state transition: ${from} → ${to}.`,
  });
}

export function schemaUnknownDiagnostic(
  path: string,
  collection: string,
  candidates: readonly string[],
): Diagnostic {
  return runtimeDiagnostic({
    code: "NOT_FOUND",
    severity: "error",
    path,
    value: collection,
    expected: "name of a declared Schema",
    candidates,
    message: `No Schema with name '${collection}'.`,
  });
}
