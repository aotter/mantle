import {
  DiagnosticError,
  runtimeDiagnostic,
  type Diagnostic,
} from "@aotter/mantle-spec";
import {
  EntryStatusConflict,
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
    if (isUniqueConstraintError(err)) {
      throw new DiagnosticError(
        runtimeDiagnostic({
          code: "CONFLICT",
          severity: "error",
          path,
          expected: "unique entry data per Schema uniqueIndexes",
          message: `Unique constraint violation during entry write: ${(err as Error).message}`,
        }),
      );
    }
    throw err;
  }
}

export function isUniqueConstraintError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message || "";
  if (
    msg.includes("UNIQUE constraint failed") ||
    msg.includes("unique constraint") ||
    msg.includes("duplicate key") ||
    (err as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE" ||
    (err as { code?: string }).code === "SQLITE_CONSTRAINT" ||
    (err as { code?: string }).code === "23505"
  ) {
    return true;
  }
  return false;
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
