import type { Diagnostic } from "../../kernel/diagnostic.js";
import type { LinkedManifestSet } from "../../domain/service/ManifestLinker.js";

/**
 * Output of the manifest validation use case. `errorCount` and
 * `warningCount` are pre-computed for adapters that need exit-code
 * decisions or summary lines; `diagnostics` is the full list.
 */
export interface ValidateManifestsResponse {
  readonly diagnostics: ReadonlyArray<Diagnostic>;
  readonly errorCount: number;
  readonly warningCount: number;
  readonly linked?: LinkedManifestSet;
}
