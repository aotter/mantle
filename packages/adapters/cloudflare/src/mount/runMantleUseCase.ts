import {
  DiagnosticError,
  httpStatusFor,
  redactForWire,
  runtimeDiagnostic,
  type Diagnostic,
} from "@aotter/mantle-spec";

/** Run a Core or application use case behind Mantle's HTTP diagnostic boundary. */
export async function runMantleUseCase<T>(
  operation: string,
  execute: () => T | Promise<T>,
): Promise<Response> {
  try {
    const result = await execute();
    if (isDiagnosticFailure(result)) {
      return Response.json(
        { ok: false, diagnostic: redactForWire(result.diagnostic) },
        { status: httpStatusFor(result.diagnostic) },
      );
    }
    return Response.json(result);
  } catch (error) {
    if (error instanceof DiagnosticError) {
      return Response.json(
        { ok: false, diagnostic: redactForWire(error.diagnostic) },
        { status: httpStatusFor(error.diagnostic) },
      );
    }
    // Storage/Auth errors can contain account IDs, query fragments, or secrets.
    console.error(`[mantle ${operation}] unhandled error`, error);
    return Response.json({
      ok: false,
      diagnostic: runtimeDiagnostic({
        code: "INTERNAL_ERROR",
        severity: "error",
        path: operation,
        message: "An internal error occurred.",
      }),
    }, { status: 500 });
  }
}

function isDiagnosticFailure(
  value: unknown,
): value is { readonly ok: false; readonly diagnostic: Diagnostic } {
  if (!value || typeof value !== "object") return false;
  const result = value as { readonly ok?: unknown; readonly diagnostic?: unknown };
  if (result.ok !== false || !result.diagnostic || typeof result.diagnostic !== "object") {
    return false;
  }
  const diagnostic = result.diagnostic as Partial<Diagnostic>;
  return typeof diagnostic.code === "string"
    && typeof diagnostic.path === "string"
    && typeof diagnostic.message === "string"
    && diagnostic.severity === "error";
}
