import {
  validateDiagnostic,
  type Diagnostic,
} from "../kernel/diagnostic.js";
import { checkSiteLocales } from "../domain/service/CrossSchemaChecker.js";
import {
  linkManifestSet,
  type LinkedManifestSet,
} from "../domain/service/ManifestLinker.js";
import type { McpInputCheckOptions, ValidateManifestsRequest } from "./dto/ValidateManifestsRequest.js";
import type { JsonSchema } from "../domain/model/ManifestGrammar.js";
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
    if (linked.ok && request.mcpInput !== false) {
      diagnostics.push(...checkMcpToolInputShapes(linked.value, request.mcpInput ?? {}));
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

/**
 * A Procedure's HTTP input schema is reused verbatim as its MCP tool schema,
 * so shapes that are fine for a typed client can strand a cold agent (#971).
 * Advisory only, and only for Procedures reachable from an MCP Trigger.
 */
function checkMcpToolInputShapes(
  linked: LinkedManifestSet,
  options: McpInputCheckOptions,
): Diagnostic[] {
  const out: Diagnostic[] = [];
  const unionAmbiguity = options.unionAmbiguity ?? true;
  const maxArrayItems = options.maxArrayItems === undefined ? 100 : options.maxArrayItems;
  const exposed = new Set(
    linked.triggers
      .filter((trigger) => trigger.manifest.spec.source.kind === "mcp")
      .map((trigger) => trigger.manifest.spec.target.procedure),
  );
  for (const procedure of linked.procedures) {
    const name = procedure.manifest.metadata.name;
    if (!exposed.has(name)) continue;
    const input = procedure.manifest.spec.input;
    const diagnostic = (code: "MCP_TOOL_INPUT_UNION_AMBIGUOUS" | "MCP_TOOL_INPUT_UNBOUNDED", path: string, value: unknown, expected: string, message: string) =>
      validateDiagnostic({
        code,
        severity: "warning",
        path,
        source: { ...procedure.source, path },
        value,
        expected,
        message,
      });

    // The v0.1 grammar accepts `oneOf` only (`anyOf` is rejected at parse), so
    // that is the one union keyword to inspect.
    if (unionAmbiguity && Array.isArray(input.oneOf) && input.oneOf.length > 0) {
      const advertised = new Set(input.required ?? []);
      const hidden = new Set<string>();
      for (const branch of input.oneOf) {
        for (const field of branch.required ?? []) if (!advertised.has(field)) hidden.add(field);
      }
      const path = "/spec/input/oneOf";
      const advertisedText = `[${[...advertised].sort().join(", ")}]`;
      out.push(diagnostic(
        "MCP_TOOL_INPUT_UNION_AMBIGUOUS",
        path,
        [...hidden].sort(),
        "one MCP tool per branch, or a top-level required set that is true for every branch",
        hidden.size
          ? `Procedure '${name}' is an MCP tool whose input is a top-level oneOf; its advertised required set ` +
            `${advertisedText} hides [${[...hidden].sort().join(", ")}], which some branch needs, so a caller satisfying ` +
            `the schema can still be rejected. MCP clients render oneOf poorly; prefer separate tools (e.g. create/update).`
          : `Procedure '${name}' is an MCP tool whose input is a top-level oneOf. MCP clients render oneOf poorly and ` +
            `cannot tell an agent which branch it is filling; prefer separate tools (e.g. create/update).`,
      ));
    }

    if (maxArrayItems !== null) {
      for (const [field, property] of Object.entries(input.properties ?? {})) {
        const schema = property as JsonSchema;
        const path = `/spec/input/properties/${field}`;
        const types = new Set(Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : []);
        if (types.has("array")) {
          const bound = typeof schema.maxItems === "number" ? schema.maxItems : undefined;
          if (bound === undefined || bound > maxArrayItems) {
            out.push(diagnostic(
              "MCP_TOOL_INPUT_UNBOUNDED",
              path,
              bound ?? null,
              `maxItems <= ${maxArrayItems} on an MCP tool array input`,
              `Procedure '${name}' is an MCP tool with array input '${field}' ${bound === undefined ? "without maxItems" : `allowing ${bound} items`}; ` +
                `an agent must serialise the whole array into one tools/call.`,
            ));
          }
        } else if (types.has("object")
          // Free-form means no declared shape at all: a typed map
          // (`additionalProperties: { type: string }`) declares its values.
          && (schema.additionalProperties === undefined || schema.additionalProperties === true)
          && Object.keys(schema.properties ?? {}).length === 0) {
          out.push(diagnostic(
            "MCP_TOOL_INPUT_UNBOUNDED",
            path,
            null,
            "declared properties, or a narrower tool that does not take a free-form document",
            `Procedure '${name}' is an MCP tool with free-form object input '${field}' (no declared properties); ` +
              `its size is unbounded and an agent gets no shape to fill.`,
          ));
        }
      }
    }
  }
  return out;
}
