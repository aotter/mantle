import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { cwd } from "node:process";
import {
  parseManifestSources,
  type ParsedManifestSet,
} from "../../domain/service/ManifestParser.js";
import type { Manifest } from "../../domain/model/ManifestGrammar.js";
import {
  validateDiagnostic,
  type Diagnostic,
} from "../../kernel/diagnostic.js";

/**
 * Read `<manifest root>/site.yaml`, parse every YAML document, return the flat
 * Manifest list + any parse-level diagnostics. Used by every CLI
 * subcommand that consumes manifests (validate, introspect,
 * emit-openapi, emit-types).
 */
export interface LoadManifestsResult {
  readonly manifests: Manifest[];
  readonly parsed?: ParsedManifestSet;
  readonly parseErrors: Diagnostic[];
  /** `kind/name` → ordered list of source locations. Length > 1 when
   *  the same name appears in multiple YAML docs / files (itself a
   *  DUPLICATE_NAME error, but the individual file paths need to
   *  remain addressable so duplicate diagnostics point at the right
   *  copies — see ManifestPathDiagnoser `occurrence` param). */
  readonly filePaths: Map<string, { file: string; docIndex: number }[]>;
  /** Absolute path the loader resolved `rootArg` to; surfaced so
   *  callers don't re-resolve and risk drift. */
  readonly root: string;
}

export async function loadManifestsFromRoot(rootArg: string): Promise<LoadManifestsResult> {
  const root = resolve(cwd(), rootArg);
  const manifests: Manifest[] = [];
  const parseErrors: Diagnostic[] = [];
  const filePaths = new Map<string, { file: string; docIndex: number }[]>();
  let parsedSet: ParsedManifestSet | undefined;
  const file = join(root, "site.yaml");

  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    parseErrors.push(
      validateDiagnostic({
        code: "MANIFEST_ROOT_NOT_FOUND",
        severity: "error",
        path: file,
        expected: "a manifest file named manifests/site.yaml",
        message: `Could not read manifest file ${file}: ${err instanceof Error ? err.message : String(err)}`,
      }),
    );
    return { manifests, parseErrors, filePaths, root };
  }

  try {
    const parsed = parseManifestSources({ sources: [{ sourceId: file, text }] });
    parseErrors.push(...parsed.diagnostics.map((diagnostic) => ({
      ...diagnostic,
      path: diagnostic.source
        ? `${diagnostic.source.sourceId}#/${diagnostic.source.documentIndex}${diagnostic.source.path}`
        : diagnostic.path,
    })));
    if (!parsed.ok) return { manifests, parseErrors, filePaths, root };
    parsedSet = parsed.value;
    parsed.value.entries.forEach(({ manifest: m, source }) => {
      manifests.push(m);
      const key = `${m.kind}/${m.metadata.name}`;
      const list = filePaths.get(key);
      const location = { file: source.sourceId, docIndex: source.documentIndex };
      if (list) list.push(location);
      else filePaths.set(key, [location]);
    });
  } catch (err) {
    // parseManifestSources converts every ManifestParseError into a
    // diagnostic internally; anything that escapes is unexpected
    // (e.g. a YAML-library throw), so surface it generically.
    parseErrors.push(
      validateDiagnostic({
        code: "INVALID_MANIFEST_ENVELOPE",
        severity: "error",
        path: file,
        message: err instanceof Error ? err.message : String(err),
      }),
    );
  }

  return { manifests, parseErrors, filePaths, root, ...(parsedSet ? { parsed: parsedSet } : {}) };
}
