import type { ParsedManifestSet } from "../../domain/service/ManifestParser.js";

/**
 * Input to the manifest validation use case (Loop 1 of the SDK
 * authoring contract — ADR-0007). Loose primitives stay out per the
 * clean-arch DTO rule; everything the use case needs is named here.
 */
export interface ValidateManifestsRequest {
  readonly parsed: ParsedManifestSet;
  /** Optional concatenated handler source — when provided, the use
   *  case greps for each `Procedure.handler.ref` literal and emits a
   *  warning when not found. */
  readonly handlerSource?: string;
  /** Optional site config locales for the locale-vs-Schema consistency
   *  check (ADR-0010). Validate-from-CLI flows leave this absent
   *  (CLI can't reach the runtime DB); boot always passes it. */
  readonly siteLocales?: ReadonlyArray<string>;
}
