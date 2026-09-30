import { makeDiagnostic, redactForWire } from "../spec/index.js";
import type { CallerResolver, Surface } from "../core/index.js";

/**
 * The one authentication boundary of a service's entry (ADR-0032 decision 8): resolve the Caller once per request, then run the
 * surface. An invalid credential is answered here, before any surface runs, and is never treated as anonymous.
 */
export function withCaller(resolve: CallerResolver, surface: Surface): (request: Request) => Promise<Response> {
  return async (request) => {
    const r = await resolve(request);
    if ("caller" in r) return surface(request, r.caller);
    const status = r.status ?? 401;
    const d = makeDiagnostic({
      code: status === 401 ? "UNAUTHENTICATED" : "AUTH_DENIED", phase: "runtime", severity: "error", path: "request:authorization",
      message: status === 401 ? "The presented credential is missing, malformed, expired, revoked, or invalid." : "The verified credential lacks a required scope.",
    });
    return Response.json({ error: redactForWire(d) }, { status, headers: r.challenge ? { "www-authenticate": r.challenge } : {} });
  };
}
