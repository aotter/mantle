/** REST request handling for a generated route table: matching, body and parameter decoding, dispatch and errors. */
import type { Caller, Target, Authorize, Gateway, RequestContext, GatewayOptions } from "./contracts.js";
import { ContractError } from "./contract-error.js";
import { invalid, type Conversions } from "./surface.js";

type Paging = { limit?: number; cursor?: string };
/** Options of a generated `rest(...)`; it adds required `handlers` when the app declares ref Procedures. */
export interface Options<Env, Database> extends GatewayOptions {
  authorize?: Authorize;
  gateway?: Gateway;
  fields?: import("./user-fields.js").UserFields;
  db: (env: Env) => Database;
  caller?: (request: Request, env: Env, authority: { readonly readOnly: boolean }) => Caller | Promise<Caller>;
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
  readonly handle?: (request: Request, env: Env, getDb: () => Database, caller: Caller, params: Record<string, string>, handlers: Handlers, input?: Record<string, unknown>) => Promise<unknown>;
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

const headers = { "cache-control": "private, no-store" };
const fail: (message: string) => never = message => invalid(message, "rest");
export async function body(request: Request, limit = 1_000_000): Promise<Record<string, unknown>> {
  if (Number(request.headers.get("content-length")) > limit) fail(`Request body exceeds ${limit} bytes.`);
  return (await import("./json-body.js")).body(request, limit, fail);
}

/** Shared matching/auth/error envelope; selected dispatch is supplied by the surface. */
function router<Env, Database, Handlers>(routes: readonly Route<Database, Handlers, Env>[], options: Options<Env, Database>, send: (route: Route<Database, Handlers, Env>, request: Request, env: Env, caller: Caller, params: Record<string, string>, access?: ReturnType<typeof import("./host-access.js").accessRequest>) => Promise<Response>): (request: Request, env: Env, ctx?: RequestContext) => Promise<Response | undefined> {
  let handle: ReturnType<typeof import("./rest-router.js").router<Env, Database, Handlers>> | undefined;
  return async (request, env, ctx) => {
    handle ??= (await import("./rest-router.js")).router(routes, options, send);
    return handle(request, env, ctx);
  };
}

/** Generated REST routes retain the native View/Procedure dispatch. */
export function rest<Env, Database, Handlers = never>(routes: readonly Route<Database, Handlers, Env>[], options: Options<Env, Database> & { handlers?: Handlers }): (request: Request, env: Env, ctx?: RequestContext) => Promise<Response | undefined> {
  return router(routes, options, async (route, request, env, caller, params, access) => {
    const { dispatch } = await import("./rest-dispatch.js");
    return dispatch(route, request, () => options.db(env), caller, params, options, access);
  });
}

/** A selected surface's raw/JSON handlers; its branches are absent from ordinary REST bundles. */
export function nativeRest<Env, Database, Handlers = never>(routes: readonly Route<Database, Handlers, Env>[], options: Options<Env, Database> & { handlers?: Handlers }): (request: Request, env: Env, ctx?: RequestContext) => Promise<Response | undefined> {
  return router(routes, options, async (route, request, env, caller, params, access) => {
    if (Number(request.headers.get("content-length")) > (route.bodyLimit ?? 1_000_000)) fail(`Request body exceeds ${route.bodyLimit ?? 1_000_000} bytes.`);
    const input = route.rawBody || ["GET", "HEAD", "OPTIONS"].includes(request.method) ? undefined : await body(request, route.bodyLimit);
    if (access?.dryRun) throw new ContractError("DRY_RUN_UNSUPPORTED", "Opaque native route.", route.id, {status: 412});
    let initialized = false, db: Database;
    const getDb = () => { if (!initialized) { db = options.db(env); initialized = true; } return db; };
    const boundRequest = route.rawBody ? (await import("./json-body.js")).replay(request) : request;
    const output = await route.handle!(boundRequest, env, getDb, caller, params, options.handlers as Handlers, input);
    return output instanceof Response ? output : Response.json(output, {headers});
  });
}
