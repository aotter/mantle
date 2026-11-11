/** REST request handling for a generated route table: matching, body and parameter decoding, dispatch and errors. */
import type { Caller, Target, Authorize, Gateway, RequestContext, GatewayOptions } from "./contracts.js";
import { ContractError } from "./contract-error.js";
import type { CallerResolver, Pipeline, PipelineOptions } from "./request-pipeline.js";
import { invalid, type Conversions } from "./surface.js";
/** The routers' path grammar, for Admin's router: its mount, route patterns and the canonical request path. */
export { ADMIN_API_BASE, canonicalPath, routeSource } from "./route-pattern.js";

type Paging = { limit?: number; cursor?: string };
/** Options of a generated `rest(...)`; it adds required `handlers` when the app declares ref Procedures. */
export interface Options<Env, Database> extends GatewayOptions {
  authorize?: Authorize;
  /** Host platform contract, versioned by `v`; stable within a version. */
  gateway?: Gateway;
  db: (env: Env) => Database;
  caller?: CallerResolver<Env>;
}
/**
 * One generated route, matched in order: a public View (`query`, `page`) at `GET /api/views/<name>`, or an http
 * Trigger whose JSON body merges with its `{name}` path parameters (typed as the input declares them). The
 * generator prints `pattern` (encoded segments, optional trailing slash) and `keys`, so mounting runs no code.
 */
export interface Route<Database, Handlers = never, Env = unknown> {
  readonly method: string;
  /** Describe route id; parameterized native routes supply their path template. */
  readonly id?: string;
  /** Compiler-proved read-only Procedure; ref handlers never qualify. */
  readonly readOnly?: boolean;
  /** The variant of the route's access target that a host caller's dry run is decided by, e.g. `procedure:<name>`. */
  readonly variant?: string;
  /**
   * What application `authorize` decides on. A native route may compute it from the decoded request; it is then
   * authorized after the body is decoded, before `prepare` or `handle`.
   */
  readonly target?: Target | NativeTarget<Env>;
  /** Generated requires guard, used before application authorization. */
  readonly check?: (caller: Caller) => void;
  /** The scopes the generated `requires` names; only such a route admits a service credential. */
  readonly scopes?: readonly string[];
  /** A selected native surface can preserve the Request and return its own Response. */
  readonly handle?: (
    request: Request,
    env: Env,
    getDb: () => Database,
    caller: Caller,
    params: Record<string, string>,
    handlers: Handlers,
    input: Record<string, unknown> | undefined,
    access: RouteAccess,
  ) => Promise<unknown>;
  /**
   * A native route's checks without effects. A host caller's dry run runs it, with no database, and answers the
   * decision; a native route without it refuses a dry run as `DRY_RUN_UNSUPPORTED` before reading the body.
   */
  readonly prepare?: (
    request: Request,
    env: Env,
    caller: Caller,
    params: Record<string, string>,
    input: Record<string, unknown> | undefined,
    access: RouteAccess,
  ) => Promise<void> | void;
  /** Selected raw APIs may declare a different body limit; JSON routes default to one million bytes. */
  readonly bodyLimit?: number;
  /** The app owns raw stream consumption; only the declared Content-Length is checked. */
  readonly rawBody?: boolean;
  readonly pattern: RegExp;
  readonly keys?: readonly string[];
  readonly convert?: Conversions;
  readonly query?: (params: URLSearchParams) => { input: Record<string, unknown> } & Paging;
  readonly page?: (db: Database, caller: Caller, input: never, paging: Paging) => Promise<unknown>;
  readonly params?: Readonly<Record<string, "number" | "boolean">>;
  readonly validate?: (raw: unknown) => Record<string, unknown>;
  readonly run?: (db: Database, caller: Caller, input: never, handlers: Handlers) => Promise<unknown>;
}
/** A native route's authorize target, computed from the decoded request. */
export type NativeTarget<Env = unknown> = (
  request: Request,
  env: Env,
  caller: Caller,
  params: Record<string, string>,
  input: Record<string, unknown> | undefined,
) => Target;
/** Application `authorize`, bound to the request's caller; without one every target is authorized. */
export interface RouteAccess {
  /** Refuse with `AUTH_DENIED` unless the target is authorized. */
  authorize(target: Target): Promise<void>;
  /** Whether the target is authorized; a rejection is `false`. */
  authorized(target: Target): Promise<boolean>;
}
/** Options of `nativeRest`. */
export interface NativeOptions<Env, Database, Handlers>
  extends Options<Env, Database>,
    Pick<PipelineOptions, "fields"> {
  handlers?: Handlers;
  /**
   * Where the mount lives (default `/api`): under it an unmatched path is `NOT_FOUND`, a method mismatch 405 and a
   * malformed escape 400. A mount with an explicit base serves only paths under it as written, and takes no encoded
   * separators or NUL (`%2F`, `%5C`, `%00`, `\`).
   */
  base?: string;
  /**
   * Who may use the mount at all, decided once the caller is resolved and before a host caller's admission, the
   * Origin rule and the route's guard. Throw to refuse, or return the response that refuses; `undefined` admits.
   */
  admission?: (caller: Caller) => Response | undefined | Promise<Response | undefined>;
}
/** A mounted surface: `undefined` for a request outside its paths. */
export type Fetch<Env> = (request: Request, env: Env, ctx?: RequestContext) => Promise<Response | undefined>;
/** A surface's own dispatch of a matched route, called once the pipeline admitted the caller and guarded the call. */
export type Send<Env, Database, Handlers> = (
  route: Route<Database, Handlers, Env>,
  request: Request,
  env: Env,
  caller: Caller,
  params: Record<string, string>,
  pipeline: Pipeline,
) => Promise<Response>;

const headers = { "cache-control": "private, no-store" };
const DEFAULT_BODY_LIMIT = 1_000_000;
const fail: (message: string) => never = message => invalid(message, "rest");
export async function body(request: Request, limit = DEFAULT_BODY_LIMIT): Promise<Record<string, unknown>> {
  if (Number(request.headers.get("content-length")) > limit) fail(`Request body exceeds ${limit} bytes.`);
  return (await import("./json-body.js")).body(request, limit, fail);
}

/** Shared matching/auth/error envelope; selected dispatch is supplied by the surface. */
function router<Env, Database, Handlers>(
  routes: readonly Route<Database, Handlers, Env>[],
  options: NativeOptions<Env, Database, Handlers>,
  send: Send<Env, Database, Handlers>,
): Fetch<Env> {
  let handle: Fetch<Env> | undefined;
  return async (request, env, ctx) => {
    handle ??= (await import("./rest-router.js")).router(routes, options, send);
    return handle(request, env, ctx);
  };
}

/** Generated REST routes retain the native View/Procedure dispatch. Generated code supplies the manifest's `fields`. */
export function rest<Env, Database, Handlers = never>(
  routes: readonly Route<Database, Handlers, Env>[],
  options: Options<Env, Database> & Pick<PipelineOptions, "fields"> & { handlers?: Handlers },
): Fetch<Env> {
  return router(routes, options, async (route, request, env, caller, params, pipeline) => {
    const { dispatch } = await import("./rest-dispatch.js");
    return dispatch(route, request, () => options.db(env), caller, params, options, pipeline);
  });
}

/** A selected surface's raw/JSON handlers; its branches are absent from ordinary REST bundles. */
export function nativeRest<Env, Database, Handlers = never>(
  routes: readonly Route<Database, Handlers, Env>[],
  options: NativeOptions<Env, Database, Handlers>,
): Fetch<Env> {
  return router(routes, options, async (route, request, env, caller, params, pipeline) => {
    if (pipeline.dryRun && !route.prepare)
      throw new ContractError("DRY_RUN_UNSUPPORTED", "Opaque native route.", route.id, { status: 412 });
    const limit = route.bodyLimit ?? DEFAULT_BODY_LIMIT;
    if (Number(request.headers.get("content-length")) > limit) fail(`Request body exceeds ${limit} bytes.`);
    const bodiless = route.rawBody || ["GET", "HEAD", "OPTIONS"].includes(request.method);
    const input = bodiless ? undefined : await body(request, route.bodyLimit);
    const { authorizeTarget, authorized } = await import("./authorization.js");
    const authorize = options.authorize;
    const access: RouteAccess = {
      authorize: async target => {
        if (authorize) await authorizeTarget(authorize, target, caller);
      },
      authorized: async target => !authorize || authorized(authorize, target, caller),
    };
    if (typeof route.target === "function")
      await pipeline.guard({ target: route.target(request, env, caller, params, input) });
    if (pipeline.dryRun) {
      await route.prepare!(request, env, caller, params, input, access);
      return pipeline.dryRunResponse();
    }
    let initialized = false,
      db: Database;
    const getDb = () => {
      if (!initialized) {
        db = options.db(env);
        initialized = true;
      }
      return db;
    };
    const output = await route.handle!(
      request,
      env,
      getDb,
      caller,
      params,
      options.handlers as Handlers,
      input,
      access,
    );
    return output instanceof Response ? output : Response.json(output, { headers });
  });
}
