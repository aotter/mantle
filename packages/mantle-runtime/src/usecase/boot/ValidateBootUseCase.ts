import {
  bootDiagnostic,
  checkSiteLocales,
  ValidateManifestsUseCase,
  type Diagnostic,
  type LinkedManifestSet,
  type Manifest,
} from "@aotter/mantle-spec";
import type {
  MantleStorageAdapter,
  PreparedMantleStorage,
} from "../../domain/port/MantleStorageAdapter.js";
import type { HandlerRegistry } from "../../domain/port/HandlerRegistry.js";
import {
  compileRuntimePlan,
  type RuntimePlan,
} from "../../domain/service/RuntimePlanCompiler.js";

export type ValidateBootResponse =
  | { readonly ok: true }
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };

export interface ValidateBootRequest {
  readonly plan?: RuntimePlan;
  /** Canonical input for new callers. */
  readonly linked?: LinkedManifestSet;
  /** Temporary alpha.7 bridge; delete in #673. */
  readonly manifests?: readonly Manifest[];
  readonly registry: HandlerRegistry;
  /** Selected adapter/module route prefixes checked during deployment readiness. */
  readonly reservedHttpPathPrefixes?: readonly string[];
  readonly siteLocales?: readonly string[];
}

export interface DeploymentPreparationOptions {
  readonly handlerNames?: readonly string[];
  readonly reservedHttpPathPrefixes?: readonly string[];
  readonly siteLocales?: readonly string[];
}

export async function prepareDeployment(
  plan: RuntimePlan,
  storage: MantleStorageAdapter,
  options: DeploymentPreparationOptions = {},
): Promise<PreparedMantleStorage> {
  const diagnostics = deploymentDiagnostics(plan, {
    ...options,
    handlerNames: options.handlerNames ?? [],
    nativeViewDialects: storage.nativeViewDialects ?? [],
  });
  if (diagnostics.length > 0) throw new BootValidationError(diagnostics);
  return storage.prepare(plan);
}

export function assertDeploymentPlan(
  plan: RuntimePlan,
  options: DeploymentPreparationOptions = {},
): void {
  const diagnostics = deploymentDiagnostics(plan, options);
  if (diagnostics.length > 0) throw new BootValidationError(diagnostics);
}

/** Deployment checks only; all pure graph rules belong to `linkManifestSet`. */
export class ValidateBootUseCase {
  execute(request: ValidateBootRequest): ValidateBootResponse {
    let plan = request.plan;
    if (!plan) {
      let linked = request.linked;
      if (!linked) {
        const validation = ValidateManifestsUseCase.run({
          manifests: request.manifests ?? [],
        });
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
      const compilation = compileRuntimePlan(linked);
      if (!compilation.ok) return { ok: false, diagnostics: compilation.diagnostics };
      plan = compilation.value;
    }

    const diagnostics = deploymentDiagnostics(plan, {
      handlerNames: request.registry.list(),
      reservedHttpPathPrefixes: request.reservedHttpPathPrefixes,
      siteLocales: request.siteLocales,
    });

    return diagnostics.length === 0
      ? { ok: true }
      : { ok: false, diagnostics };
  }

  assert(request: ValidateBootRequest): void {
    const result = this.execute(request);
    if (!result.ok) throw new BootValidationError(result.diagnostics);
  }
}

function deploymentDiagnostics(
  plan: RuntimePlan,
  options: DeploymentPreparationOptions & { readonly nativeViewDialects?: readonly string[] },
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  if (options.handlerNames) {
    const candidates = [...new Set(options.handlerNames)].sort();
    const handlerNames = new Set(candidates);
    for (const procedure of Object.values(plan.procedures)) {
      const handler = procedure.manifest.spec.handler;
      if (handler.kind !== "ref" || handlerNames.has(handler.ref)) continue;
      const path = `manifest:Procedure/${procedure.name}#/spec/handler/ref`;
      diagnostics.push(bootDiagnostic({
        code: "HANDLER_NOT_REGISTERED",
        severity: "error",
        path,
        value: handler.ref,
        expected: `a function passed through the handlers option under key '${handler.ref}'`,
        candidates,
        message: `Procedure '${procedure.name}' declares handler.ref '${handler.ref}' but no handler is registered for that key.`,
      }));
    }
  }
  const prefixes = [...new Set(options.reservedHttpPathPrefixes ?? [])].sort();
  for (const route of plan.httpRoutes) {
    const prefix = prefixes.find((candidate) =>
      candidate.length > 0 && hasPathPrefix(route.path, candidate)
    );
    if (!prefix) continue;
    const path = `manifest:Trigger/${route.trigger}#/spec/source/path`;
    diagnostics.push(bootDiagnostic({
      code: "TRIGGER_PATH_INVALID",
      severity: "error",
      path,
      value: route.path,
      expected: `path outside selected reserved prefix '${prefix}'`,
      message: `Trigger '${route.trigger}' has path '${route.path}', which is reserved under '${prefix}'.`,
    }));
  }
  if (options.siteLocales) {
    diagnostics.push(...checkSiteLocales({
      schemas: Object.values(plan.schemas).map((schema) => schema.manifest),
      phase: "boot",
      siteLocales: options.siteLocales,
    }));
  }
  if (options.nativeViewDialects) {
    const supported = new Set(options.nativeViewDialects);
    for (const view of Object.values(plan.views)) {
      if (view.query.kind !== "native" || supported.has(view.query.dialect)) continue;
      diagnostics.push(bootDiagnostic({
        code: "VIEW_DIALECT_UNSUPPORTED",
        severity: "error",
        path: `manifest:View/${view.name}#/spec/sql`,
        value: view.query.dialect,
        expected: supported.size > 0
          ? `one of: ${[...supported].sort().join(", ")}`
          : "a declarative View",
        message: `Storage adapter does not support native View dialect '${view.query.dialect}'.`,
      }));
    }
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
