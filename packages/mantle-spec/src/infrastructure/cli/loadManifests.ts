import { readdir, readFile } from "node:fs/promises";
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
 * Read every immediate YAML file in a caller-owned manifest directory, parse
 * every document, and return the sealed parser value + parse diagnostics. Used
 * by every CLI subcommand that consumes manifests.
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

  let files: string[];
  try {
    files = (await readdir(root))
      .filter((name) => /\.ya?ml$/i.test(name))
      .map((name) => join(root, name))
      .sort();
  } catch (err) {
    parseErrors.push(
      validateDiagnostic({
        code: "MANIFEST_ROOT_NOT_FOUND",
        severity: "error",
        path: root,
        expected: "a readable directory containing one or more .yaml or .yml files",
        message: `Could not read manifest directory ${root}: ${err instanceof Error ? err.message : String(err)}`,
      }),
    );
    return { parseErrors, root };
  }

  if (files.length === 0) {
    parseErrors.push(
      validateDiagnostic({
        code: "MANIFEST_ROOT_NOT_FOUND",
        severity: "error",
        path: root,
        expected: "one or more .yaml or .yml files",
        message: `No YAML manifest files found in ${root}`,
      }),
    );
    return { parseErrors, root };
  }

  const sources = [];
  for (const file of files) {
    try {
      sources.push({ sourceId: file, text: await readFile(file, "utf8") });
    } catch (err) {
      parseErrors.push(
        validateDiagnostic({
          code: "MANIFEST_ROOT_NOT_FOUND",
          severity: "error",
          path: file,
          expected: "a readable YAML manifest file",
          message: `Could not read manifest file ${file}: ${err instanceof Error ? err.message : String(err)}`,
        }),
      );
      return { parseErrors, root };
    }
  }

  try {
    const parsed = parseManifestSources({ sources });
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
        path: root,
        message: err instanceof Error ? err.message : String(err),
      }),
    );
  }

  return { parseErrors, root, ...(parsedSet ? { parsed: parsedSet } : {}) };
}
