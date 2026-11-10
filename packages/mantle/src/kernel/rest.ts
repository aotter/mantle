/** REST request handling for a generated route table: matching, body and parameter decoding, dispatch and errors. */
import type { Caller, Target, Authorize, Gateway, RequestContext, GatewayOptions } from "./contracts.js";
import { ContractError } from "./contract-error.js";
import type { CallerResolver, Pipeline } from "./request-pipeline.js";
import { invalid, type Conversions } from "./surface.js";
/** The routers' path grammar, for Admin's router: its mount, route patterns and the canonical request path. */
export { ADMIN_API_BASE, canonicalPath, routeSource } from "./route-pattern.js";

type Paging = { limit?: number; cursor?: string };
/** Options of a generated `rest(...)`; it adds required `handlers` when the app declares ref Procedures. */
export interface Options<Env, Database> extends GatewayOptions {
  authorize?: Authorize;
  /** Host platform contract, versioned by `v`; stable within a version. */
  gateway?: Gateway;
  fields?: import("./user-fields.js").UserFields;
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
  readonly target?: Target;
  /** Generated requires guard, used before application authorization. */
  readonly check?: (caller: Caller) => void;
  /** A selected native surface can preserve the Request and return its own Response. */
  readonly handle?: (
    request: Request,
    env: Env,
    getDb: () => Database,
    caller: Caller,
    params: Record<string, string>,
    handlers: Handlers,
    input?: Record<string, unknown>,
  ) => Promise<unknown>;
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
  options: Options<Env, Database>,
  send: Send<Env, Database, Handlers>,
): Fetch<Env> {
  let handle: Fetch<Env> | undefined;
  return async (request, env, ctx) => {
    handle ??= (await import("./rest-router.js")).router(routes, options, send);
    return handle(request, env, ctx);
  };
}

/** Generated REST routes retain the native View/Procedure dispatch. */
export function rest<Env, Database, Handlers = never>(
  routes: readonly Route<Database, Handlers, Env>[],
  options: Options<Env, Database> & { handlers?: Handlers },
): Fetch<Env> {
  return router(routes, options, async (route, request, env, caller, params, pipeline) => {
    const { dispatch } = await import("./rest-dispatch.js");
    return dispatch(route, request, () => options.db(env), caller, params, options, pipeline);
  });
}

/** A selected surface's raw/JSON handlers; its branches are absent from ordinary REST bundles. */
export function nativeRest<Env, Database, Handlers = never>(
  routes: readonly Route<Database, Handlers, Env>[],
  options: Options<Env, Database> & { handlers?: Handlers },
): Fetch<Env> {
  return router(routes, options, async (route, request, env, caller, params, pipeline) => {
    const limit = route.bodyLimit ?? DEFAULT_BODY_LIMIT;
    if (Number(request.headers.get("content-length")) > limit) fail(`Request body exceeds ${limit} bytes.`);
    const bodiless = route.rawBody || ["GET", "HEAD", "OPTIONS"].includes(request.method);
    const input = bodiless ? undefined : await body(request, route.bodyLimit);
    if (pipeline.dryRun)
      throw new ContractError("DRY_RUN_UNSUPPORTED", "Opaque native route.", route.id, { status: 412 });
    let initialized = false,
      db: Database;
    const getDb = () => {
      if (!initialized) {
        db = options.db(env);
        initialized = true;
      }
      return db;
    };
    const output = await route.handle!(request, env, getDb, caller, params, options.handlers as Handlers, input);
    return output instanceof Response ? output : Response.json(output, { headers });
  });
}
