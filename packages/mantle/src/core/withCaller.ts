import { makeDiagnostic, redactForWire, type DiagnosticCode } from "../spec/kernel/index.js";
import type { CallerResolver } from "./caller.js";
import type { MantleRuntime, Surface } from "./service.js";
import { observe } from "./observation.js";

const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

const refuse = (status: 401 | 403, code: DiagnosticCode, message: string, path: string, challenge?: string) =>
  Response.json({ error: redactForWire(makeDiagnostic({ code, phase: "runtime", severity: "error", path, message })) }, { status, headers: { "cache-control": "private, no-store", ...(challenge ? { "www-authenticate": challenge } : {}) } });

export interface WithCallerOptions {
  /**
   * The protected-resource metadata URL (RFC 9728). The MCP authorization spec has a client find the authorization server from the
   * `resource_metadata` parameter of the 401 challenge, so an MCP entry passes it and every challenge carries it.
   */
  readonly resourceMetadata?: string;
  /** Metadata only; no request body or credential. A delivery promise is not awaited. */
  readonly onRefusal?: (event: CallerRefusal) => void | Promise<void>;
}

/** A request refused before a surface runs, not an executed tool invocation. */
export interface CallerRefusal {
  readonly at: number;
  readonly status: 401 | 403;
  readonly reason: "origin" | "credential";
}

/**
 * The one authentication boundary of a service's entry (ADR-0032 decision 8): resolve the Caller once per request, then run the
 * surface. An invalid credential is answered here, before any surface runs, and is never treated as anonymous. A cookie session is
 * ambient authority, so it may not mutate across origins; a bearer token is sent on purpose and is not held to that.
 * The entry's optional current runtime is forwarded unchanged, so cached routes do not capture another request's execution context.
 */
export function withCaller(resolve: CallerResolver, surface: Surface, options: WithCallerOptions = {}): (request: Request, executionRuntime?: MantleRuntime) => Promise<Response> {
  return async (request, executionRuntime) => {
    const rejected = (reason: CallerRefusal["reason"], status: 401 | 403, code: DiagnosticCode, message: string, path: string, challenge?: string) => {
      if (options.onRefusal) observe(options.onRefusal, { at: Date.now(), status, reason });
      return refuse(status, code, message, path, challenge);
    };
    const r = await resolve(request);
    if ("caller" in r) {
      if (r.caller.kind === "user" && r.caller.credential === "session" && !SAFE.has(request.method)) {
        const site = request.headers.get("sec-fetch-site");
        const origin = request.headers.get("origin");
        // neither header is what Better Auth refuses too: every browser sends one of them on a mutation
        if ((!site && !origin) || (site && site !== "same-origin" && site !== "none") || (origin && origin !== new URL(request.url).origin))
          return rejected("origin", 403, "AUTH_DENIED", "Cross-origin session mutation rejected.", "request:origin");
      }
      return surface(request, r.caller, executionRuntime);
    }
    const status = r.status ?? 401;
    const challenge = r.challenge && options.resourceMetadata ? `${r.challenge}, resource_metadata="${options.resourceMetadata}"` : r.challenge ?? (options.resourceMetadata ? `Bearer resource_metadata="${options.resourceMetadata}"` : undefined);
    return status === 401
      ? rejected("credential", 401, "UNAUTHENTICATED", "The presented credential is missing, malformed, expired, revoked, or invalid.", "request:authorization", challenge)
      : rejected("credential", 403, "AUTH_DENIED", "The verified credential lacks a required scope.", "request:authorization", challenge);
  };
}
