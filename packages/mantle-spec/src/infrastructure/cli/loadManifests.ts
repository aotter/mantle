import { readFile, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { cwd } from "node:process";
import { parseManifests } from "../../domain/service/ManifestParser.js";
import type { Manifest } from "../../domain/model/ManifestGrammar.js";
import {
  validateDiagnostic,
  type Diagnostic,
} from "../../kernel/diagnostic.js";

/**
 * Walk a manifest root, parse every YAML file, return the flat
 * Manifest list + any parse-level diagnostics. Used by every CLI
 * subcommand that consumes manifests (validate, introspect,
 * emit-openapi, emit-types).
 */
export interface LoadManifestsResult {
  readonly manifests: Manifest[];
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

  let entries: string[];
  try {
    entries = await collectYamlFiles(root);
  } catch (err) {
    parseErrors.push(
      validateDiagnostic({
        code: "MANIFEST_ROOT_NOT_FOUND",
        severity: "error",
        path: root,
        expected: "an existing directory containing *.yaml manifest files",
        message: `Could not read manifest root ${root}: ${err instanceof Error ? err.message : String(err)}`,
      }),
    );
    return { manifests, parseErrors, filePaths, root };
  }

  for (const file of entries) {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (err) {
      parseErrors.push(
        validateDiagnostic({
          code: "MANIFEST_READ_FAILED",
          severity: "error",
          path: file,
          message: `Failed to read ${file}: ${err instanceof Error ? err.message : String(err)}`,
        }),
      );
      continue;
    }
    try {
      const parsed = parseManifests(text);
      parseErrors.push(...parsed.diagnostics);
      parsed.manifests.forEach((m, i) => {
        manifests.push(m);
        const key = `${m.kind}/${m.metadata.name}`;
        const list = filePaths.get(key);
        if (list) list.push({ file, docIndex: i });
        else filePaths.set(key, [{ file, docIndex: i }]);
      });
    } catch (err) {
      // parseManifests converts every ManifestParseError into a
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
  }

  return { manifests, parseErrors, filePaths, root };
}

async function collectYamlFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    const items = await readdir(dir, { withFileTypes: true });
    for (const it of items) {
      const full = join(dir, it.name);
      if (it.isDirectory()) await walk(full);
      else if (it.isFile() && (it.name.endsWith(".yaml") || it.name.endsWith(".yml"))) {
        out.push(full);
      }
    }
  }
  const s = await stat(root);
  if (!s.isDirectory()) {
    throw new Error(`${root} is not a directory`);
  }
  await walk(root);
  out.sort();
  return out;
}
