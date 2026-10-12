/** Preserve Core's actionable search refusals instead of an absent-program error. */
import type { GenerateDiagnostic } from "../domain/model.js";
export function searchDiagnostics(warnings: readonly string[]): GenerateDiagnostic[] {
  return [...new Set(warnings.filter(message => /mantle\.search|search fields/.test(message)).map(message => message.replace(/^(plan#\/[^ ]+) \([^)]*\): /, "$1: ")))].map(message => ({
    code: "GENERATE_UNSUPPORTED",
    path: /^plan#\/([^: ]+)/.exec(message)?.[1] ?? "views",
    message: `${message}. Declare searchableFields on the source Schema; search_rank needs mantle.search on the same alias in the same query.`,
  }));
}
