import { validateDiagnostic, type Diagnostic } from "../../kernel/diagnostic.js";
import type { SqlDiagnostic } from "../model/SqlIr.js";

/**
 * A SQL refusal as a kernel `Diagnostic` (validate phase). `path` is the JSON Pointer of the
 * manifest field that holds the SQL, `sourceId` the manifest it came from; `line`, `column`
 * and `offset` are positions inside that SQL text, and the offending token is the `value`.
 */
export function sqlDiagnosticToKernel(d: SqlDiagnostic, at: { path: string; sourceId?: string }): Diagnostic {
  const start = d.line !== undefined && d.column !== undefined ? { line: d.line, column: d.column, offset: d.offset ?? 0 } : undefined;
  return validateDiagnostic({
    code: d.code,
    severity: "error",
    path: at.path,
    message: d.message,
    ...(d.token !== undefined ? { value: d.token } : {}),
    ...(at.sourceId !== undefined
      ? { source: { sourceId: at.sourceId, documentIndex: 0, path: at.path, ...(start ? { span: { start, end: start } } : {}) } }
      : {}),
  });
}
