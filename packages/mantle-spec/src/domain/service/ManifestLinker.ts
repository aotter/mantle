import type { Diagnostic, SourceLocation } from "../../kernel/diagnostic.js";
import type { ManifestFilePaths } from "./ManifestPathDiagnoser.js";
import {
  sourceLocationAt,
  type ParsedManifest,
  type ParsedManifestEntry,
  type ParsedManifestSet,
  type ParseResult,
} from "./ManifestParser.js";
import { validateManifestGraph } from "./ManifestGraphValidator.js";

type ParsedSchema = Extract<ParsedManifest, { kind: "Schema" }>;
type ParsedView = Extract<ParsedManifest, { kind: "View" }>;
type ParsedProcedure = Extract<ParsedManifest, { kind: "Procedure" }>;
type ParsedTrigger = Extract<ParsedManifest, { kind: "Trigger" }>;

export interface ResolvedManifestReference<M extends ParsedManifest> {
  readonly manifest: M;
  readonly source: SourceLocation;
}

export interface LinkedSchema extends ResolvedManifestReference<ParsedSchema> {
  readonly translationParent?: ResolvedManifestReference<ParsedSchema>;
}

export interface LinkedView extends ResolvedManifestReference<ParsedView> {
  readonly from?: ResolvedManifestReference<ParsedSchema>;
  readonly guard?: ResolvedManifestReference<ParsedProcedure>;
}

export interface LinkedProcedure extends ResolvedManifestReference<ParsedProcedure> {
  readonly builtinSchema?: ResolvedManifestReference<ParsedSchema>;
  readonly collectionActionSchema?: ResolvedManifestReference<ParsedSchema>;
  readonly guard?: ResolvedManifestReference<ParsedProcedure>;
}

export interface LinkedTrigger extends ResolvedManifestReference<ParsedTrigger> {
  readonly target: ResolvedManifestReference<ParsedProcedure>;
  readonly lifecycleSchema?: ResolvedManifestReference<ParsedSchema>;
}

declare const linkedManifestSetBrand: unique symbol;

export interface LinkedManifestSet {
  readonly schemas: readonly LinkedSchema[];
  readonly views: readonly LinkedView[];
  readonly procedures: readonly LinkedProcedure[];
  readonly triggers: readonly LinkedTrigger[];
  readonly [linkedManifestSetBrand]: true;
}

export type LinkResult<T> = ParseResult<T>;

/** Pure cross-manifest resolution. A failed graph never exposes a linked value. */
export function linkManifestSet(
  parsed: ParsedManifestSet,
): LinkResult<LinkedManifestSet> {
  const manifests = parsed.entries.map((entry) => entry.manifest);
  const filePaths = sourceFilePaths(parsed.entries);
  const graph = validateManifestGraph(manifests, filePaths);
  const diagnostics = graph.diagnostics.map((diagnostic) =>
    attachSource(diagnostic, parsed.entries)
  );
  if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    return { ok: false, diagnostics };
  }

  const entriesByManifest = new Map(parsed.entries.map((entry) => [entry.manifest, entry]));
  const schemasByName = new Map(graph.schemas.map((manifest) => [manifest.metadata.name, manifest]));
  const proceduresByName = new Map(
    graph.procedures.map((manifest) => [manifest.metadata.name, manifest]),
  );
  const resolve = <M extends ParsedManifest>(manifest: M): ResolvedManifestReference<M> => {
    const entry = entriesByManifest.get(manifest);
    if (!entry) throw new Error(`linked manifest '${manifest.kind}/${manifest.metadata.name}' lost its source`);
    return Object.freeze({ manifest, source: entry.source });
  };
  const resolveSchema = (name: string): ResolvedManifestReference<ParsedSchema> =>
    resolve(schemasByName.get(name) as ParsedSchema);
  const resolveProcedure = (name: string): ResolvedManifestReference<ParsedProcedure> =>
    resolve(proceduresByName.get(name) as ParsedProcedure);

  const schemas = graph.schemas.map((manifest) => Object.freeze({
    ...resolve(manifest as ParsedSchema),
    ...(manifest.spec.translates
      ? { translationParent: resolveSchema(manifest.spec.translates.parent) }
      : {}),
  }));
  const views = graph.views.map((manifest) => Object.freeze({
    ...resolve(manifest as ParsedView),
    ...(manifest.spec.from ? { from: resolveSchema(manifest.spec.from) } : {}),
    ...(manifest.spec.requires?.guard
      ? { guard: resolveProcedure(manifest.spec.requires.guard.procedure) }
      : {}),
  }));
  const procedures = graph.procedures.map((manifest) => Object.freeze({
    ...resolve(manifest as ParsedProcedure),
    ...(manifest.spec.handler.kind === "builtin"
      ? { builtinSchema: resolveSchema(manifest.spec.handler.schema) }
      : {}),
    ...(typeof manifest.spec.uiSchema?.["collectionAction"] === "string"
      ? { collectionActionSchema: resolveSchema(manifest.spec.uiSchema["collectionAction"] as string) }
      : {}),
    ...(manifest.spec.requires?.guard
      ? { guard: resolveProcedure(manifest.spec.requires.guard.procedure) }
      : {}),
  }));
  const triggers = graph.triggers.map((manifest) => Object.freeze({
    ...resolve(manifest as ParsedTrigger),
    target: resolveProcedure(manifest.spec.target.procedure),
    ...(manifest.spec.source.kind === "lifecycle"
      ? { lifecycleSchema: resolveSchema(manifest.spec.source.schema) }
      : {}),
  }));

  return {
    ok: true,
    value: Object.freeze({
      schemas: Object.freeze(schemas),
      views: Object.freeze(views),
      procedures: Object.freeze(procedures),
      triggers: Object.freeze(triggers),
    }) as LinkedManifestSet,
    diagnostics,
  };
}

function sourceFilePaths(entries: readonly ParsedManifestEntry[]): ManifestFilePaths {
  const paths = new Map<string, Array<{ file: string; docIndex: number }>>();
  for (const entry of entries) {
    const key = `${entry.manifest.kind}/${entry.manifest.metadata.name}`;
    const location = {
      file: entry.source.sourceId,
      docIndex: entry.source.documentIndex,
    };
    const list = paths.get(key);
    if (list) list.push(location);
    else paths.set(key, [location]);
  }
  return paths;
}

function attachSource(
  diagnostic: Diagnostic,
  entries: readonly ParsedManifestEntry[],
): Diagnostic {
  const matches = entries
    .map((entry) => ({
      entry,
      prefix: `${entry.source.sourceId}#/${entry.source.documentIndex}`,
    }))
    .filter(({ prefix }) => diagnostic.path.startsWith(prefix))
    .sort((a, b) => b.prefix.length - a.prefix.length);
  const match = matches[0];
  if (!match) return diagnostic;
  const path = diagnostic.path.slice(match.prefix.length) || "/";
  return { ...diagnostic, path, source: sourceLocationAt(match.entry, path) };
}
