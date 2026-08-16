import type { Manifest } from "../../domain/model/ManifestGrammar.js";
import type { ManifestFilePaths } from "../../domain/service/ManifestPathDiagnoser.js";
import type {
  ParsedManifest,
  ParsedManifestSet,
} from "../../domain/service/ManifestParser.js";

/** Temporary raw-manifest bridge for pre-0.1.2 callers. Delete in #673. */
export function legacyParsedManifestSet(
  manifests: readonly Manifest[],
  filePaths?: ManifestFilePaths,
): ParsedManifestSet {
  const occurrences = new Map<string, number>();
  const entries = manifests.map((manifest) => {
    const key = `${manifest.kind}/${manifest.metadata.name}`;
    const occurrence = occurrences.get(key) ?? 0;
    occurrences.set(key, occurrence + 1);
    const location = filePaths?.get(key)?.[occurrence];
    return {
      manifest: manifest as ParsedManifest,
      source: {
        sourceId: location?.file ?? `legacy:${key}`,
        documentIndex: location?.docIndex ?? occurrence,
        path: "/",
      },
      sourceSpans: {},
    };
  });
  return Object.freeze({ entries: Object.freeze(entries) }) as ParsedManifestSet;
}
