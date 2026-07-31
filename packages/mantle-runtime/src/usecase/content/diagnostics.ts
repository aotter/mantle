import {
  runtimeDiagnostic,
  type ContentState,
  type Diagnostic,
} from "@aotter/mantle-spec";
export {
  notFoundDiagnostic,
  withConflictDiagnostic,
} from "../../domain/service/EntryMutationDiagnostics.js";

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
