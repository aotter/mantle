import type {
  ParsedManifestEntry,
  ParsedManifestSet,
} from "../../src/domain/service/ManifestParser.js";

/** Package-private escape hatch for tests that own a post-parse fixture. */
export function parsedManifestSetFixture(
  entries: readonly ParsedManifestEntry[],
): ParsedManifestSet {
  return Object.freeze({ entries: Object.freeze([...entries]) }) as ParsedManifestSet;
}
