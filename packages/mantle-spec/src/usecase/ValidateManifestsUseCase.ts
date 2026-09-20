import {
  validateDiagnostic,
  type Diagnostic,
} from "../kernel/diagnostic.js";
import { checkSiteLocales } from "../domain/service/CrossSchemaChecker.js";
import {
  linkManifestSet,
  type LinkedManifestSet,
} from "../domain/service/ManifestLinker.js";
import type { ValidateManifestsRequest } from "./dto/ValidateManifestsRequest.js";
import type { ValidateManifestsResponse } from "./dto/ValidateManifestsResponse.js";

/** Link one parser-owned value and apply optional authoring checks. */
export class ValidateManifestsUseCase {
  execute(request: ValidateManifestsRequest): ValidateManifestsResponse {
    const linked = linkManifestSet(request.parsed);
    const diagnostics: Diagnostic[] = [...linked.diagnostics];
    if (linked.ok && request.siteLocales !== undefined) {
      diagnostics.push(...checkSiteLocales({
        schemas: linked.value.schemas.map((schema) => schema.manifest),
        phase: "validate",
        siteLocales: request.siteLocales,
      }));
    }
    if (linked.ok && request.handlerSource !== undefined) {
      diagnostics.push(...checkHandlerRefsInSource(linked.value, request.handlerSource));
    }
    const errorCount = diagnostics.filter((diagnostic) => diagnostic.severity === "error").length;
    return {
      diagnostics,
      errorCount,
      warningCount: diagnostics.length - errorCount,
      ...(linked.ok ? { linked: linked.value } : {}),
    };
  }

  static run(request: ValidateManifestsRequest): ValidateManifestsResponse {
    return new ValidateManifestsUseCase().execute(request);
  }
}

function checkHandlerRefsInSource(
  linked: LinkedManifestSet,
  sourceText: string,
): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const procedure of linked.procedures) {
    const handler = procedure.manifest.spec.handler;
    if (handler.kind !== "ref") continue;
    const escaped = handler.ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const quoted = new RegExp(`["'\`]${escaped}["'\`]`);
    const propertyKey = new RegExp(`(?:^|[\\s{,;])${escaped}\\s*:`, "m");
    if (quoted.test(sourceText) || propertyKey.test(sourceText)) continue;
    const path = "/spec/handler/ref";
    out.push(validateDiagnostic({
      code: "HANDLER_NOT_REGISTERED",
      severity: "warning",
      path,
      source: { ...procedure.source, path },
      value: handler.ref,
      expected: `'${handler.ref}' to appear in the handlers map as an object-property key`,
      message: `Procedure '${procedure.manifest.metadata.name}' handler.ref '${handler.ref}' was not found in any handler source file.`,
    }));
  }
  return out;
}
