import { LineCounter, parseAllDocuments } from "yaml";
import { validateDiagnostic, type Diagnostic, type SourceLocation, type SourceSpan } from "../../kernel/diagnostic.js";
import { API_VERSION, type LifecycleMode, type Manifest, type ManifestKind, type ProcedureManifest, type SchemaManifest, type TriggerManifest, type ViewManifest } from "../model/ManifestGrammar.js";
import { KNOWN_KINDS, ManifestParseError, rejectUnknownKeys } from "./ManifestFieldChecks.js";
import { collectSourceSpans, sourceLocation, sourceLocationForNode } from "./ManifestSourceSpans.js";
import { validateProcedureSpec, validateViewSpec } from "./ProcedureViewSpecChecks.js";
import { validateSchemaSpec } from "./SchemaSpecChecks.js";
import { validateTriggerSpec } from "./TriggerSpecChecks.js";
export { ManifestParseError } from "./ManifestFieldChecks.js";
export { sourceLocationAt } from "./ManifestSourceSpans.js";

/** One caller-owned manifest source. Core never resolves this ID as a path. */
export interface ManifestSource {
  readonly sourceId: string;
  readonly text: string;
}

export interface ManifestSourceSet {
  readonly sources: readonly ManifestSource[];
}

type ParsedSchemaManifest = Omit<SchemaManifest, "spec"> & {
  readonly spec: Omit<
    SchemaManifest["spec"],
    "uniqueIndexes" | "indexes" | "searchableFields" | "localized" | "lifecycle"
  > & {
    readonly uniqueIndexes: ReadonlyArray<ReadonlyArray<string>>;
    readonly indexes: ReadonlyArray<ReadonlyArray<string>>;
    readonly searchableFields: readonly string[];
    readonly localized: boolean;
    readonly lifecycle: LifecycleMode;
  };
};

/** Canonical atom value after all static authoring defaults are materialized. */
export type ParsedManifest =
  | ParsedSchemaManifest
  | ViewManifest
  | ProcedureManifest
  | TriggerManifest;

export interface ParsedManifestEntry {
  readonly manifest: ParsedManifest;
  readonly source: SourceLocation;
  /** YAML-node spans keyed by JSON Pointer; source identity lives in `source`. */
  readonly sourceSpans: Readonly<Record<string, SourceSpan>>;
}

declare const parsedManifestSetBrand: unique symbol;

/** Parser-owned value. Consumers cannot construct it as an ordinary object literal. */
export interface ParsedManifestSet {
  readonly entries: readonly ParsedManifestEntry[];
  readonly [parsedManifestSetBrand]: true;
}

export type ParseResult<T> =
  | { readonly ok: true; readonly value: T; readonly diagnostics: readonly Diagnostic[] }
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };

interface InternalParseResult {
  readonly entries: ParsedManifestEntry[];
  readonly diagnostics: Diagnostic[];
}

/**
 * Pure, source-aware parse boundary. Any error withholds the sealed value so a
 * later stage cannot consume a partial manifest graph.
 */
export function parseManifestSources(
  sourceSet: ManifestSourceSet,
): ParseResult<ParsedManifestSet> {
  const parsed = parseManifestSourcesInternal(sourceSet);
  if (parsed.diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    return { ok: false, diagnostics: parsed.diagnostics };
  }
  return {
    ok: true,
    value: Object.freeze({
      entries: Object.freeze(parsed.entries),
    }) as ParsedManifestSet,
    diagnostics: parsed.diagnostics,
  };
}

function parseManifestSourcesInternal(sourceSet: ManifestSourceSet): InternalParseResult {
  const entries: ParsedManifestEntry[] = [];
  const diagnostics: Diagnostic[] = [];
  const sources = sourceSet?.sources;
  if (!Array.isArray(sources)) {
    diagnostics.push(invalidSourceDiagnostic("/sources", "ManifestSourceSet.sources must be an array"));
    return { entries, diagnostics };
  }
  const seenIds = new Set<string>();
  for (let index = 0; index < sources.length; index++) {
    const source = sources[index];
    if (!source || typeof source !== "object") {
      diagnostics.push(invalidSourceDiagnostic(`/sources/${index}`, "manifest source must be an object"));
      continue;
    }
    if (typeof source.sourceId !== "string" || source.sourceId.length === 0) {
      diagnostics.push(invalidSourceDiagnostic(
        `/sources/${index}/sourceId`,
        "manifest sourceId must be a non-empty string",
      ));
      continue;
    }
    if (seenIds.has(source.sourceId)) {
      diagnostics.push(invalidSourceDiagnostic(
        `/sources/${index}/sourceId`,
        `manifest sourceId '${source.sourceId}' is duplicated`,
        source.sourceId,
      ));
      continue;
    }
    seenIds.add(source.sourceId);
    if (typeof source.text !== "string") {
      diagnostics.push(invalidSourceDiagnostic(
        `/sources/${index}/text`,
        `manifest source '${source.sourceId}' text must be a string`,
        source.sourceId,
      ));
      continue;
    }
    parseOneStream(source, entries, diagnostics);
  }
  return { entries, diagnostics };
}

function invalidSourceDiagnostic(path: string, message: string, sourceId?: string): Diagnostic {
  return validateDiagnostic({
    code: "INVALID_MANIFEST_ENVELOPE",
    severity: "error",
    path,
    ...(sourceId
      ? { source: { sourceId, documentIndex: 0, path } }
      : {}),
    message,
  });
}

function parseOneStream(
  source: ManifestSource,
  entries: ParsedManifestEntry[],
  diagnostics: Diagnostic[],
): void {
  const lineCounter = new LineCounter();
  const docs = parseAllDocuments(source.text, { merge: false, lineCounter });
  for (let i = 0; i < docs.length; i++) {
    const doc = docs[i]!;
    const docIndex = i;
    if (doc.errors.length > 0) {
      const error = doc.errors[0];
      const location = sourceLocation(
        source.sourceId,
        docIndex,
        "/",
        lineCounter,
        error?.pos ?? doc.range,
      );
      diagnostics.push(
        validateDiagnostic({
          code: "INVALID_MANIFEST_ENVELOPE",
          severity: "error",
          path: "/",
          source: location,
          message: `[doc ${docIndex}] YAML parse error: ${doc.errors.map((e) => e.message).join("; ")}`,
        }),
      );
      continue;
    }
    // `maxAliasCount: 100` matches the yaml library's recommended safe
    // default; the prior `-1` (unlimited) leaves the parser open to YAML
    // bombs (`a: &a [{a: *a, ...}]`) that can exhaust memory before any
    // grammar validator runs. The lib throws a ReferenceError when the
    // cap trips — surface as a structured diagnostic, not an uncaught.
    let value: unknown;
    try {
      value = doc.toJS({ maxAliasCount: 100 });
    } catch (e) {
      diagnostics.push(
        validateDiagnostic({
          code: "INVALID_MANIFEST_ENVELOPE",
          severity: "error",
          path: "/",
          source: sourceLocationForNode(source.sourceId, docIndex, "/", doc, lineCounter),
          message: `[doc ${docIndex}] YAML alias-expansion limit exceeded: ${e instanceof Error ? e.message : String(e)}`,
        }),
      );
      continue;
    }
    if (value == null) continue;
    try {
      entries.push({
        manifest: normalizeManifest(validateEnvelope(value, docIndex)),
        source: sourceLocationForNode(source.sourceId, docIndex, "/", doc, lineCounter),
        sourceSpans: collectSourceSpans(doc.contents, lineCounter),
      });
    } catch (e) {
      if (e instanceof ManifestParseError) {
        const path = e.pointer ?? "/";
        diagnostics.push(
          validateDiagnostic({
            code: e.code,
            severity: "error",
            path,
            source: sourceLocationForNode(source.sourceId, docIndex, path, doc, lineCounter),
            ...e.details,
            message: e.message,
          }),
        );
      } else {
        diagnostics.push(
          validateDiagnostic({
            code: "INVALID_MANIFEST_ENVELOPE",
            severity: "error",
            path: "/",
            source: sourceLocationForNode(source.sourceId, docIndex, "/", doc, lineCounter),
            message:
              e instanceof Error
                ? `[doc ${docIndex}] ${e.message}`
                : `[doc ${docIndex}] unknown parse error`,
          }),
        );
      }
    }
  }
}

function normalizeManifest(manifest: Manifest): ParsedManifest {
  if (manifest.kind === "Schema") {
    return {
      ...manifest,
      spec: {
        ...manifest.spec,
        uniqueIndexes: manifest.spec.uniqueIndexes ?? [],
        indexes: manifest.spec.indexes ?? [],
        searchableFields: manifest.spec.searchableFields ?? [],
        localized: manifest.spec.localized ?? false,
        lifecycle: manifest.spec.lifecycle ?? "publishing",
      },
    };
  }
  return manifest;
}

function pointerFor(docIndex: number, jsonPointer: string): string {
  const ptr = jsonPointer.startsWith("/") ? jsonPointer : `/${jsonPointer}`;
  return `manifest:doc/${docIndex}#${ptr}`;
}

function validateEnvelope(raw: unknown, docIndex: number): Manifest {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ManifestParseError("manifest must be a YAML mapping", docIndex);
  }
  const m = raw as Record<string, unknown>;
  rejectUnknownKeys(m, ["apiVersion", "kind", "metadata", "spec"], docIndex, "/");

  if (m["apiVersion"] !== API_VERSION) {
    throw new ManifestParseError(
      `apiVersion must be "${API_VERSION}"; got ${JSON.stringify(m["apiVersion"])}` +
        (m["apiVersion"] === "cms.mantle.aotter.net/v1" ? " (a 0.1.x manifest: follow node_modules/@aotter/mantle/docs/upgrade-0.1-to-0.2.md)" : ""),
      docIndex,
      "/apiVersion",
    );
  }
  const kind = m["kind"];
  if (typeof kind !== "string" || !KNOWN_KINDS.has(kind as ManifestKind)) {
    throw new ManifestParseError(
      `kind must be one of ${[...KNOWN_KINDS].join(", ")}; got ${JSON.stringify(kind)}`,
      docIndex,
      "/kind",
    );
  }
  const meta = m["metadata"];
  if (typeof meta !== "object" || meta === null) {
    throw new ManifestParseError("metadata is required and must be a mapping", docIndex, "/metadata");
  }
  const name = (meta as Record<string, unknown>)["name"];
  rejectUnknownKeys(meta as Record<string, unknown>, ["name"], docIndex, "/metadata");
  if (typeof name !== "string" || name.length === 0) {
    throw new ManifestParseError("metadata.name is required (non-empty string)", docIndex, "/metadata/name");
  }
  const spec = m["spec"];
  if (typeof spec !== "object" || spec === null) {
    throw new ManifestParseError("spec is required and must be a mapping", docIndex, "/spec");
  }

  switch (kind) {
    case "Schema":
      return validateSchemaSpec(raw as SchemaManifest, docIndex);
    case "View":
      return validateViewSpec(raw as ViewManifest, docIndex);
    case "Procedure":
      return validateProcedureSpec(raw as ProcedureManifest, docIndex);
    case "Trigger":
      return validateTriggerSpec(raw as TriggerManifest, docIndex);
    default:
      throw new ManifestParseError(`unhandled kind ${kind}`, docIndex);
  }
}
