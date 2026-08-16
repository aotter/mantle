import type { Manifest } from "../../domain/model/ManifestGrammar.js";
import type { ManifestFilePaths } from "../../domain/service/ManifestPathDiagnoser.js";
import type { ParsedManifestSet } from "../../domain/service/ManifestParser.js";

/**
 * Input to the manifest validation use case (Loop 1 of the SDK
 * authoring contract — ADR-0007). Loose primitives stay out per the
 * clean-arch DTO rule; everything the use case needs is named here.
 */
export interface ValidateManifestsRequest {
  /** Canonical input for new callers. */
  readonly parsed?: ParsedManifestSet;
  /** Temporary alpha.7 bridge; delete in #673. */
  readonly manifests?: ReadonlyArray<Manifest>;
  /** Optional concatenated handler source — when provided, the use
   *  case greps for each `Procedure.handler.ref` literal and emits a
   *  warning when not found. */
  readonly handlerSource?: string;
  /** Optional file-path index (`Kind/name` → ordered list of file +
   *  docIndex). When the CLI loads from disk, it populates this so
   *  diagnostic paths point at the consumer's actual files. The list
   *  shape (vs. single entry) lets duplicate-manifest diagnostics
   *  surface every offending source location instead of all pointing
   *  at whichever copy the loader saw last. */
  readonly filePaths?: ManifestFilePaths;
  /** Optional site config locales for the locale-vs-Schema consistency
   *  check (ADR-0010). Validate-from-CLI flows leave this absent
   *  (CLI can't reach the runtime DB); boot always passes it. */
  readonly siteLocales?: ReadonlyArray<string>;
}
