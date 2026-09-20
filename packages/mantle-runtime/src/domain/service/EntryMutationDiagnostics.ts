import {
  DiagnosticError,
  runtimeDiagnostic,
  type Diagnostic,
} from "@aotter/mantle-spec";
import {
  EntryStatusConflict,
  EntryUniqueConflict,
  EntryVersionConflict,
} from "../model/EntryRow.js";

/** Translate repository OCC failures at any entry-mutation boundary. */
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
    if (err instanceof EntryUniqueConflict) {
      throw new DiagnosticError(
        runtimeDiagnostic({
          code: "CONFLICT",
          severity: "error",
          path,
          value: err.fields,
          expected: "unique entry data per Schema uniqueIndexes",
          message: `Unique constraint violation in collection '${err.collection}': ${err.message}`,
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
