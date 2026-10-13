/** REST request handling for a generated route table: matching, body and parameter decoding, dispatch and errors. */
import { ContractError, checkOrigin, surfaceCaller, surfaceFailure, type Caller } from "./contracts.js";
import { decode, invalid, type Conversions } from "./surface.js";

type Paging = { limit?: number; cursor?: string };
/** Options of a generated `rest(...)`; it adds required `handlers` when the app declares ref Procedures. */
export interface Options<Env, Database> {
  db: (env: Env) => Database;
  caller: (request: Request, env: Env, authority: { readonly readOnly: boolean }) => Caller | Promise<Caller>;
}
/**
 * One generated route, matched in order: a public View (`query`, `page`) at `GET /api/views/<name>`, or an http
 * Trigger whose JSON body merges with its `{name}` path parameters (typed as the input declares them). The
 * generator prints `pattern` (encoded segments, optional trailing slash) and `keys`, so mounting runs no code.
 */
export interface Route<Database, Handlers = never, Env = unknown> {
  readonly method: string;
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
const isApi = (path: string): boolean => path === "/api" || path.startsWith("/api/");
const fail: (message: string) => never = message => invalid(message, "rest");
export async function body(request: Request, limit = 1_000_000): Promise<Record<string, unknown>> {
  if (Number(request.headers.get("content-length")) > limit) fail(`Request body exceeds ${limit} bytes.`);
  return (await import("./json-body.js")).body(request, limit, fail);
}

/** Shared matching/auth/error envelope; selected dispatch is supplied by the surface. */
function router<Env, Database, Handlers>(routes: readonly Route<Database, Handlers, Env>[], options: Options<Env, Database>, send: (route: Route<Database, Handlers, Env>, request: Request, env: Env, caller: Caller, params: Record<string, string>) => Promise<Response>): (request: Request, env: Env) => Promise<Response | undefined> {
  return async (request, env) => {
    try {
      const original = new URL(request.url).pathname;
      let path: string;
      try { path = original.split("/").map(segment => encodeURIComponent(decodeURIComponent(segment))).join("/"); } catch { if (!isApi(original)) return undefined; fail("Malformed request path."); }
      const allowed = new Set<string>();
      for (const route of routes) {
        const match = route.pattern.exec(path); if (!match) continue; allowed.add(route.method);
        const read = !!route.page && !route.run && !route.handle;
        if (route.method !== request.method && !(request.method === "HEAD" && route.method === "GET" && read)) continue;
        const params = decode(route.keys ?? [], match, "Malformed path parameter.", "rest");
        const caller = await surfaceCaller(request, env, options.caller, read && ["GET", "HEAD"].includes(request.method));
        checkOrigin(request, caller);
        return await send(route, request, env, caller, params);
      }
      if (allowed.size) { const response = surfaceFailure(new ContractError("METHOD_NOT_ALLOWED", "Method is not allowed for this route.", "rest")); response.headers.set("allow", [...allowed].join(", ")); return response; }
      if (isApi(path!)) throw new ContractError("NOT_FOUND", "No such route.", "rest");
      return undefined;
    } catch (error) { return surfaceFailure(error, undefined, `rest ${request.method} ${new URL(request.url).pathname}`); }
  };
}

/** Generated REST routes retain the native View/Procedure dispatch. */
export function rest<Env, Database, Handlers = never>(routes: readonly Route<Database, Handlers, Env>[], options: Options<Env, Database> & { handlers?: Handlers }): (request: Request, env: Env) => Promise<Response | undefined> {
  return router(routes, options, async (route, request, env, caller, params) => {
    const { dispatch } = await import("./rest-dispatch.js");
    const data = await dispatch(route, request, () => options.db(env), caller, params, options.handlers as Handlers);
    return request.method === "HEAD" ? new Response(null, {headers}) : Response.json(data, {headers});
  });
}

/** A selected surface's raw/JSON handlers; its branches are absent from ordinary REST bundles. */
export function nativeRest<Env, Database, Handlers = never>(routes: readonly Route<Database, Handlers, Env>[], options: Options<Env, Database> & { handlers?: Handlers }): (request: Request, env: Env) => Promise<Response | undefined> {
  return router(routes, options, async (route, request, env, caller, params) => {
    if (Number(request.headers.get("content-length")) > (route.bodyLimit ?? 1_000_000)) fail(`Request body exceeds ${route.bodyLimit ?? 1_000_000} bytes.`);
    const input = route.rawBody || ["GET", "HEAD", "OPTIONS"].includes(request.method) ? undefined : await body(request, route.bodyLimit);
    let initialized = false, db: Database;
    const getDb = () => { if (!initialized) { db = options.db(env); initialized = true; } return db; };
    const output = await route.handle!(request, env, getDb, caller, params, options.handlers as Handlers, input);
    return output instanceof Response ? output : Response.json(output, {headers});
  });
}
