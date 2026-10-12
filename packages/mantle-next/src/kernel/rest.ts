/** REST request handling for a generated route table: matching, body and parameter decoding, dispatch and errors. */
import { ContractError, checkOrigin, surfaceCaller, surfaceFailure, type Caller } from "./contracts.js";
import { convert, decode, invalid, type Conversions } from "./surface.js";

type Paging = { limit?: number; cursor?: string };
/** Options of a generated `rest(...)`; it adds required `handlers` when the app declares ref Procedures. */
export interface Options<Env, Database> {
  db: (env: Env) => Database;
  caller: (request: Request, env: Env) => Promise<Caller>;
}
/** A public View at `GET /api/views/<name>`: its query-string reader and paged boundary. */
export interface ViewRoute<Database> {
  readonly view: string;
  readonly query: (params: URLSearchParams) => { input: Record<string, unknown> } & Paging;
  readonly page: (db: Database, caller: Caller, input: never, paging: Paging) => Promise<unknown>;
  readonly convert?: Conversions;
}
/** An http Trigger: a JSON body merged with `{name}` path parameters (typed as the input declares them). */
export interface ProcedureRoute<Database, Handlers> {
  readonly method: string;
  readonly path: string;
  readonly params?: Readonly<Record<string, "number" | "boolean">>;
  readonly validate: (raw: unknown) => Record<string, unknown>;
  readonly convert?: Conversions;
  readonly run: (db: Database, caller: Caller, input: never, handlers: Handlers) => Promise<unknown>;
}
interface Route<Database> { method: string; pattern: RegExp; keys: readonly string[]; run(request: Request, db: Database, caller: Caller, params: Record<string, string>): Promise<unknown> }

const headers = { "cache-control": "private, no-store" };
function fail(message: string): never { return invalid(message, "rest"); }
function number(raw: string): number { if (!raw.trim() || !Number.isFinite(Number(raw))) fail("Expected a number."); return Number(raw); }
function boolean(raw: string): boolean { if (raw !== "true" && raw !== "false") fail("Expected true or false."); return raw === "true"; }
async function body(request: Request): Promise<Record<string, unknown>> {
  if (Number(request.headers.get("content-length")) > 1_000_000) fail("Request body exceeds 1000000 bytes.");
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > 1_000_000) fail("Request body exceeds 1000000 bytes.");
  const text = new TextDecoder().decode(bytes);
  let value: unknown;
  try { value = text.trim() ? JSON.parse(text) : {}; } catch { fail("Expected a JSON body."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("Expected a JSON object.");
  return value as Record<string, unknown>;
}
/** Each segment is matched in its encoded form; `{name}` segments capture. */
function pattern(path: string): Pick<Route<unknown>, "pattern" | "keys"> {
  const keys: string[] = [];
  const source = path.split("/").map(segment => {
    if (segment.startsWith("{") && segment.endsWith("}")) { keys.push(segment.slice(1, -1)); return "([^/]+)"; }
    return encodeURIComponent(segment).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }).join("/");
  return { pattern: new RegExp("^" + source + "/?$"), keys };
}

/** The handler for one app's routes: a response for `/api` paths, otherwise undefined. */
export function rest<Env, Database, Handlers = never>(views: readonly ViewRoute<Database>[], procedures: readonly ProcedureRoute<Database, Handlers>[], options: Options<Env, Database> & { handlers?: Handlers }): (request: Request, env: Env) => Promise<Response | undefined> {
  const routes: Route<Database>[] = [
    ...views.map(view => ({ method: "GET", ...pattern(`/api/views/${view.view}`), async run(request: Request, db: Database, caller: Caller) {
      const { input: raw, ...paging } = view.query(new URL(request.url).searchParams);
      const input = { ...raw };
      convert(input, view.convert);
      return view.page(db, caller, input as never, paging);
    } })),
    ...procedures.map(route => ({ method: route.method, ...pattern(route.path), async run(request: Request, db: Database, caller: Caller, params: Record<string, string>) {
      const raw = await body(request);
      for (const key in params) raw[key] = route.params?.[key] === "number" ? number(params[key]!) : route.params?.[key] === "boolean" ? boolean(params[key]!) : params[key];
      const input = route.validate(raw);
      convert(input, route.convert);
      return route.run(db, caller, input as never, options.handlers as Handlers);
    } })),
  ];
  return async (request, env) => {
    try {
      const original = new URL(request.url).pathname;
      let path: string;
      try { path = original.split("/").map(segment => encodeURIComponent(decodeURIComponent(segment))).join("/"); } catch { if (original !== "/api" && !original.startsWith("/api/")) return undefined; fail("Malformed request path."); }
      const allowed = new Set<string>();
      for (const route of routes) {
        const match = route.pattern.exec(path); if (!match) continue; allowed.add(route.method);
        if (route.method !== request.method) continue;
        const params = decode(route.keys, match, "Malformed path parameter.", "rest");
        const caller = await surfaceCaller(request, env, options.caller);
        checkOrigin(request, caller);
        return Response.json(await route.run(request, options.db(env), caller, params), { headers });
      }
      if (allowed.size) { const response = surfaceFailure(new ContractError("METHOD_NOT_ALLOWED", "Method is not allowed for this route.", "rest")); response.headers.set("allow", [...allowed].join(", ")); return response; }
      if (path! === "/api" || path!.startsWith("/api/")) throw new ContractError("NOT_FOUND", "No such route.", "rest");
      return undefined;
    } catch (error) { return surfaceFailure(error); }
  };
}
