/** Preserve Core's actionable attribute refusals instead of an absent-program error. */
import type { GenerateDiagnostic } from "../domain/model.js";
export function attrDiagnostics(warnings: readonly string[]): GenerateDiagnostic[] {
  return [...new Set(warnings.filter(message => /auth\.attr|attribute-scoped|scoped by auth/.test(message)).map(message => message.replace(/^(plan#\/[^ ]+) \([^)]*\): /, "$1: ")))].map(message => ({
    code: "GENERATE_UNSUPPORTED",
    path: /^plan#\/([^: ]+)/.exec(message)?.[1] ?? "views",
    message,
  }));
}
