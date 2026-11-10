/**
 * The one request pipeline of the generated surfaces, loaded on a request and never at Worker startup.
 *
 * REST, MCP and web each match a request to a `Call` and decode its input. Every caller and authorization decision
 * between the match and the dispatch is made here, in this order:
 *
 * 1. `select`: name the target, so a refusal that follows is observed against it.
 * 2. `resolveCaller`: forwarded host props, or the application's resolver with a read-only hint.
 * 3. `admit`: a host caller's target pin, freshness and dry-run support.
 * 4. `enforceOrigin`: the cookie-session Origin rule.
 * 5. `guard`: the generated `requires` check, then application `authorize`.
 * 6. `dryRun`: answer the decision instead of dispatching; no database handle is acquired before this point.
 * 7. `finish`, `finishResponse`, `failure`: the access event and the error envelope.
 *
 * Gateway mode lives here only: without `options.gateway` no caller is a host, and `select`, `admit`, `dryRun` and
 * the `finish` steps do nothing.
 *
 * What stays with a surface: REST's route matching and body decoding; MCP's transport Origin check, endpoint and
 * credential-scope rules, batch pre-authorization and SDK plumbing (`mcp-handler.ts`); web's rendering, and its
 * decoding of a page's path fields before `admit` (`web-serve.ts`).
 */
import { authorizeTarget } from "./authorization.js";
import { isHostCaller } from "./caller-identity.js";
import { forwarded } from "./contracts.js";
import type { Authorize, Caller, Gateway, GatewayOptions, RequestContext, Target } from "./contracts.js";
import { checkOrigin, surfaceCaller, surfaceError } from "./surface-failure.js";
import type { UserFields } from "./user-fields.js";

/** The options every surface hands the pipeline. */
export interface PipelineOptions extends GatewayOptions {
  readonly gateway?: Gateway;
  readonly fields?: UserFields;
  readonly authorize?: Authorize;
}

/** An application's caller resolver; `authority.readOnly` lets it serve a read from cached session authority. */
export type CallerResolver<Env> = (request: Request, env: Env, authority: { readonly readOnly: boolean }) => Caller | Promise<Caller>;

/** What a surface matched: one View read or Procedure call. */
export interface Call {
  /** The target's id in access events and in a host caller's pin. */
  readonly id: string;
  /**
   * A View read. REST and web serve one on GET or HEAD; MCP carries every call as a POST, so there a View tool
   * qualifies. A View that a hand-written table serves on another method is not a read.
   */
  readonly view: boolean;
  /** A Procedure the compiler proved read-only; ref handlers never qualify. */
  readonly readOnly?: boolean;
  /** What application `authorize` decides on; without it only `check` guards the call. */
  readonly target?: Target;
  /** The generated `requires` guard. */
  readonly check?: (caller: Caller) => void;
}

/** A View target: it pages, and has neither a Procedure nor an opaque handler. */
export const isView = (target: { readonly page?: unknown; readonly run?: unknown; readonly handle?: unknown }): boolean =>
  !!target.page && !target.run && !target.handle;

/** Is this call a read: a View, or a Procedure the compiler proved read-only. A snapshot host caller may make it. */
export const isRead = (call: Pick<Call, "view" | "readOnly">): boolean => call.view || call.readOnly === true;

/**
 * The Origin rule's one decision: must this call pass `checkOrigin`? A cookie is ambient authority, so every call
 * must, except a View read, which changes nothing. A forwarded host caller holds no ambient authority of its own:
 * its gateway already authenticated the request, so only its writes must.
 */
export const originChecked = (call: Pick<Call, "view" | "readOnly">, host: boolean): boolean =>
  !(call.view || host && call.readOnly === true);

/** A refusal as a client reads it: the redacted wire error. */
export type Diagnostic = ReturnType<typeof surfaceError>["error"];

/** One request's pass through the steps; a surface opens it before matching and ends it with a `finish` step. */
export interface Pipeline {
  /** Gateway mode: the application trusts forwarded host props and resolves no caller of its own. */
  readonly gateway: boolean;
  /** The caller, once `resolveCaller` (or `resolveForwarded`) returned one. */
  readonly caller: Caller | undefined;
  /** The caller is a forwarded host caller. */
  readonly host: boolean;
  /** The host caller asked for the decision only. */
  readonly dryRun: boolean;
  /** Step 1. Also re-names the target after a later match; the resolved caller, if any, stays attached. */
  select(id: string): Promise<void>;
  /** Step 2 for forwarded props alone, so a broken host contract is refused before a surface matches anything. */
  resolveForwarded(): Promise<void>;
  /** Step 2. Resolves once per request: forwarded props win, else `resolve` runs with the read-only hint. */
  resolveCaller<Env>(request: Request, env: Env, resolve: CallerResolver<Env>, readOnly: boolean): Promise<Caller>;
  /** Step 3. */
  admit(call: Pick<Call, "id" | "view" | "readOnly">): Promise<void>;
  /** Step 4. */
  enforceOrigin(request: Request, call: Pick<Call, "view" | "readOnly">): void;
  /** Step 5, first half: the generated guard alone, for a surface that authorized the call earlier in the request. */
  check(call: Pick<Call, "check">): void;
  /** Step 5. */
  guard(call: Pick<Call, "check" | "target">): Promise<void>;
  /** Step 6 as a tool result: the decision's access event. */
  dryRunResult(): { readonly dryRun: true; readonly event: unknown };
  /** Step 6 as an HTTP response. */
  dryRunResponse(): Response;
  /** Step 7: the request's one access event; later calls keep the first outcome. */
  finish(error?: unknown): void;
  /** Step 7 for a response a surface already built: its status and error body decide the outcome. */
  finishResponse(response: Response): Promise<void>;
  /** Step 7 for a refusal: the access event, then the error envelope the caller's kind reads. */
  failure(error: unknown, where: string, challenge?: string): Promise<Response>;
  /** The error a tool result carries, in the same envelope as `failure`. */
  diagnostic(error: unknown, where: string): Promise<Diagnostic>;
}

/** Open the pipeline for one request. Gateway observation loads only in gateway mode. */
export async function openPipeline(ctx: RequestContext | undefined, options: PipelineOptions): Promise<Pipeline> {
  const access = options.gateway ? (await import("./host-access.js")).accessRequest(ctx, options) : undefined;
  const hostCallers = () => import("./host-caller.js");
  let caller: Caller | undefined;
  const isHost = () => !!options.gateway && !!caller && isHostCaller(caller);
  /** Forwarded props are the only authority in gateway mode, and a contract violation anywhere else. */
  const resolveForwarded = async () => {
    if (!caller && forwarded(ctx, options.gateway)) caller = (await hostCallers()).gatewayCaller(ctx, options.gateway, options.fields);
  };
  return {
    gateway: !!options.gateway,
    get caller() { return caller; },
    get host() { return isHost(); },
    get dryRun() { return !!access?.dryRun; },
    async select(id) { await access?.select(id, caller); },
    resolveForwarded,
    async resolveCaller(request, env, resolve, readOnly) {
      await resolveForwarded();
      return caller ??= await surfaceCaller(request, env, resolve, readOnly);
    },
    async admit(call) {
      await access?.select(call.id, caller);
      await access?.check(isRead(call));
    },
    enforceOrigin(request, call) {
      if (originChecked(call, isHost())) checkOrigin(request, caller!);
    },
    check(call) { call.check?.(caller!); },
    async guard(call) {
      call.check?.(caller!);
      if (options.authorize && call.target) await authorizeTarget(options.authorize, call.target, caller!);
    },
    dryRunResult: () => ({ dryRun: true, event: access!.finish() }),
    dryRunResponse: () => access!.response(),
    finish(error) { access?.finish(error); },
    async finishResponse(response) { await access?.finishResponse(response); },
    async failure(error, where, challenge) {
      access?.finish(error);
      return (await hostCallers()).hostFailure(error, caller, where, challenge);
    },
    async diagnostic(error, where) {
      if (!isHost()) return surfaceError(error, where).error;
      const response = (await hostCallers()).hostFailure(error, caller, where);
      return (await response.json() as { error: Diagnostic }).error;
    },
  };
}
