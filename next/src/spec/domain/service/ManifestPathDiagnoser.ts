/**
 * Diagnostic-path helpers for cross-manifest validators. Pure
 * functions, no env.
 *
 * `manifestPath` formats a JSON Pointer path the CLI / boot validator
 * can render either as a synthetic `manifest:Kind/name#/...` URI or
 * (when the caller supplies a file-paths map) as the consumer's actual
 * `file.yaml#/<docIndex>/...` source location.
 *
 * `bestMatch` runs Levenshtein edit distance against a candidate list
 * and returns the closest match within distance < 3. Used for "did you
 * mean?" suggestions in `TRIGGER_TARGET_PROCEDURE_UNKNOWN`,
 * `VIEW_FROM_UNKNOWN_SCHEMA`, etc.
 */
/** Per-manifest source location surfaced by the CLI loader. */
export interface ManifestSourceLocation {
  readonly file: string;
  readonly docIndex: number;
}

/**
 * Multi-occurrence file-paths map: each `kind/name` key holds an
 * ordered list of source locations (length > 1 when the same name
 * appears in multiple YAML docs/files, which is itself a
 * DUPLICATE_NAME error but the locations need to remain individually
 * addressable so duplicate diagnostics point at the right copies).
 */
export type ManifestFilePaths = ReadonlyMap<string, readonly ManifestSourceLocation[]>;

export function manifestPath(
  kind: string,
  name: string,
  jsonPointer: string,
  filePaths?: ManifestFilePaths,
  /** 1-based occurrence index when the name has multiple file
   *  locations (duplicate manifests). Defaults to 1 (first copy). */
  occurrence: number = 1,
): string {
  const locations = filePaths?.get(`${kind}/${name}`);
  const fp = locations?.[Math.max(0, occurrence - 1)] ?? locations?.[0];
  if (fp) return `${fp.file}#/${fp.docIndex}${jsonPointer}`;
  return `manifest:${kind}/${name}#${jsonPointer}`;
}

export function bestMatch(target: string, candidates: ReadonlyArray<string>): string | undefined {
  let best: string | undefined;
  let bestD = 3;
  for (const c of candidates) {
    const d = editDistance(target, c);
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best;
}

function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) dp[i]![0] = i;
  for (let j = 0; j <= b.length; j++) dp[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i]![j] = Math.min(dp[i - 1]![j]! + 1, dp[i]![j - 1]! + 1, dp[i - 1]![j - 1]! + cost);
    }
  }
  return dp[a.length]![b.length]!;
}
