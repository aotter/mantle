import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { cwd } from "node:process";
import {
  parseManifestSources,
  type ParsedManifestSet,
} from "../../domain/service/ManifestParser.js";
import {
  validateDiagnostic,
  type Diagnostic,
} from "../../kernel/diagnostic.js";

/**
 * Read `<manifest root>/site.yaml`, parse every YAML document, return the flat
 * sealed parser value + any parse-level diagnostics. Used by every CLI
 * subcommand that consumes manifests (validate, introspect,
 * emit-openapi, emit-types).
 */
export interface LoadManifestsResult {
  readonly parsed?: ParsedManifestSet;
  readonly parseErrors: Diagnostic[];
  /** Absolute path the loader resolved `rootArg` to; surfaced so
   *  callers don't re-resolve and risk drift. */
  readonly root: string;
}

export async function loadManifestsFromRoot(rootArg: string): Promise<LoadManifestsResult> {
  const root = resolve(cwd(), rootArg);
  const parseErrors: Diagnostic[] = [];
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
    return { parseErrors, root };
  }

  try {
    const parsed = parseManifestSources({ sources: [{ sourceId: file, text }] });
    parseErrors.push(...parsed.diagnostics.map((diagnostic) => ({
      ...diagnostic,
      path: diagnostic.source
        ? `${diagnostic.source.sourceId}#/${diagnostic.source.documentIndex}${diagnostic.source.path}`
        : diagnostic.path,
    })));
    if (!parsed.ok) return { parseErrors, root };
    parsedSet = parsed.value;
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

  return { parseErrors, root, ...(parsedSet ? { parsed: parsedSet } : {}) };
}
