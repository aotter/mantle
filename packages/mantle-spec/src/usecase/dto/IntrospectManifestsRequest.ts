import type { ParsedManifestSet } from "../../domain/service/ManifestParser.js";
import type { Diagnostic } from "../../kernel/diagnostic.js";

export interface IntrospectManifestsRequest {
  readonly parsed?: ParsedManifestSet;
  readonly parseErrors: ReadonlyArray<Diagnostic>;
}
