import {
  linkManifestSet,
  parseManifestSources,
  type Diagnostic,
  type LinkedManifestSet,
  type Manifest,
  type ParsedManifestSet,
  ValidateManifestsUseCase,
} from "../src/index.js";

export interface TestParseResult {
  readonly manifests: readonly Manifest[];
  readonly diagnostics: readonly Diagnostic[];
  readonly parsed?: ParsedManifestSet;
  readonly linked?: LinkedManifestSet;
}

export function parseManifests(input: string | readonly string[]): TestParseResult {
  const texts = typeof input === "string" ? [input] : input;
  const parsed = parseManifestSources({
    sources: texts.map((text, index) => ({ sourceId: `manifest:input/${index}`, text })),
  });
  const diagnostics = parsed.diagnostics.map((diagnostic) => diagnostic.source
    ? {
        ...diagnostic,
        path: `manifest:doc/${diagnostic.source.documentIndex}#${diagnostic.source.path}`,
      }
    : diagnostic);
  if (!parsed.ok) return { manifests: [], diagnostics };
  const linked = linkManifestSet(parsed.value);
  return {
    manifests: parsed.value.entries.map((entry) => entry.manifest),
    diagnostics,
    parsed: parsed.value,
    ...(linked.ok ? { linked: linked.value } : {}),
  };
}

export function validateManifests(request: {
  readonly manifests: readonly Manifest[];
  readonly handlerSource?: string;
  readonly siteLocales?: readonly string[];
}) {
  const parsed = parseManifestSources({
    sources: request.manifests.map((manifest, index) => ({
      sourceId: `test:${index}`,
      text: JSON.stringify(manifest),
    })),
  });
  if (!parsed.ok) {
    const errorCount = parsed.diagnostics.filter((diagnostic) =>
      diagnostic.severity === "error"
    ).length;
    return {
      diagnostics: parsed.diagnostics,
      errorCount,
      warningCount: parsed.diagnostics.length - errorCount,
    };
  }
  return ValidateManifestsUseCase.run({
    parsed: parsed.value,
    handlerSource: request.handlerSource,
    siteLocales: request.siteLocales,
  });
}
