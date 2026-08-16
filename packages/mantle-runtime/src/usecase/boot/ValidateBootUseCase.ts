import {
  bootDiagnostic,
  checkSiteLocales,
  ValidateManifestsUseCase,
  type Diagnostic,
  type LinkedManifestSet,
  type Manifest,
} from "@aotter/mantle-spec";
import type { HandlerRegistry } from "../../domain/port/HandlerRegistry.js";

export type ValidateBootResponse =
  | { readonly ok: true }
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };

export interface ValidateBootRequest {
  /** Canonical input for new callers. */
  readonly linked?: LinkedManifestSet;
  /** Temporary alpha.7 bridge; delete in #673. */
  readonly manifests?: readonly Manifest[];
  readonly registry: HandlerRegistry;
  /** Selected adapter/module route prefixes checked during deployment readiness. */
  readonly reservedHttpPathPrefixes?: readonly string[];
  readonly siteLocales?: readonly string[];
}

/** Deployment checks only; all pure graph rules belong to `linkManifestSet`. */
export class ValidateBootUseCase {
  execute(request: ValidateBootRequest): ValidateBootResponse {
    let linked = request.linked;
    if (!linked) {
      const validation = ValidateManifestsUseCase.run({ manifests: request.manifests ?? [] });
      if (validation.errorCount > 0 || !validation.linked) {
        return {
          ok: false,
          diagnostics: validation.diagnostics.map((diagnostic) => ({
            ...diagnostic,
            phase: "boot",
          })),
        };
      }
      linked = validation.linked;
    }

    const diagnostics: Diagnostic[] = [];
    const handlerCandidates = request.registry.list();
    for (const procedure of linked.procedures) {
      const handler = procedure.manifest.spec.handler;
      if (handler.kind !== "ref" || request.registry.has(handler.ref)) continue;
      const path = "/spec/handler/ref";
      diagnostics.push(bootDiagnostic({
        code: "HANDLER_NOT_REGISTERED",
        severity: "error",
        path,
        source: { ...procedure.source, path },
        value: handler.ref,
        expected: `a function passed through the handlers option under key '${handler.ref}'`,
        candidates: handlerCandidates,
        message: `Procedure '${procedure.manifest.metadata.name}' declares handler.ref '${handler.ref}' but no handler is registered for that key.`,
      }));
    }

    diagnostics.push(...checkReservedHttpPrefixes(
      linked,
      request.reservedHttpPathPrefixes,
    ));
    diagnostics.push(...checkSiteLocales({
      schemas: linked.schemas.map((schema) => schema.manifest),
      phase: "boot",
      siteLocales: request.siteLocales ?? [],
    }));

    return diagnostics.length === 0
      ? { ok: true }
      : { ok: false, diagnostics };
  }

  assert(request: ValidateBootRequest): void {
    const result = this.execute(request);
    if (!result.ok) throw new BootValidationError(result.diagnostics);
  }
}

const CURRENT_RESERVED_HTTP_PATH_PREFIXES = ["/api/auth", "/api/views"] as const;

function checkReservedHttpPrefixes(
  linked: LinkedManifestSet,
  adapterPrefixes: readonly string[] = [],
): Diagnostic[] {
  const prefixes = [...new Set([...CURRENT_RESERVED_HTTP_PATH_PREFIXES, ...adapterPrefixes])];
  const diagnostics: Diagnostic[] = [];
  for (const trigger of linked.triggers) {
    const source = trigger.manifest.spec.source;
    if (source.kind !== "http") continue;
    const prefix = prefixes.find((candidate) =>
      candidate.length > 0 && hasPathPrefix(source.path, candidate)
    );
    if (!prefix) continue;
    const path = "/spec/source/path";
    diagnostics.push(bootDiagnostic({
      code: "TRIGGER_PATH_INVALID",
      severity: "error",
      path,
      source: { ...trigger.source, path },
      value: source.path,
      expected: `path outside selected reserved prefix '${prefix}'`,
      message: `Trigger '${trigger.manifest.metadata.name}' has path '${source.path}', which is reserved under '${prefix}'.`,
    }));
  }
  return diagnostics;
}

function hasPathPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`) || path.startsWith(`${prefix}{`);
}

export class BootValidationError extends Error {
  constructor(public readonly diagnostics: readonly Diagnostic[]) {
    const summary = diagnostics
      .map((diagnostic) =>
        `  - ${diagnostic.code} (phase: ${diagnostic.phase}) at ${diagnostic.path}: ${diagnostic.message}`
      )
      .join("\n");
    super(`Runtime boot validation failed (${diagnostics.length} error(s)):\n${summary}`);
    this.name = "BootValidationError";
  }
}
