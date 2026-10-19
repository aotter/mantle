/** View/Procedure dispatch loads only on a matched REST request, after caller resolution. */
import { authorizeTarget } from "./authorization.js";
import type { Caller } from "./contracts.js";
import { convert, invalid } from "./surface.js";
import { body, type Options, type Route } from "./rest.js";
const fail: (message: string) => never = message => invalid(message, "rest");
function number(raw: string): number { const value = Number(raw); if (!raw.trim() || !Number.isFinite(value)) fail("Expected a number."); return value; }
function boolean(raw: string): boolean { if (raw !== "true" && raw !== "false") fail("Expected true or false."); return raw === "true"; }
export async function dispatch<Database, Handlers, Env>(route: Route<Database, Handlers, Env>, request: Request, getDb: () => Database, caller: Caller, params: Record<string, string>, options: Options<Env, Database> & { handlers?: Handlers }, access?: ReturnType<typeof import("./host-access.js").accessRequest>): Promise<Response> {
  route.check?.(caller);
  if (options.authorize && route.target) { await authorizeTarget(options.authorize, route.target, caller); }
  let data: unknown;
  if (route.page) {
    const { input: raw, ...paging } = route.query!(new URL(request.url).searchParams);
    const input = { ...raw };
    convert(input, route.convert);
    if (access?.dryRun) return access.response();
    data = await route.page(getDb(), caller, input as never, paging);
  } else {
    const raw = await body(request);
    for (const key in params) raw[key] = route.params?.[key] === "number" ? number(params[key]!) : route.params?.[key] === "boolean" ? boolean(params[key]!) : params[key];
    const input = route.validate!(raw);
    convert(input, route.convert);
    if (access?.dryRun) return access.response();
    data = await route.run!(getDb(), caller, input as never, options.handlers as Handlers);
  }
  const headers = { "cache-control": "private, no-store" };
  const response = request.method === "HEAD" ? new Response(null, {headers}) : Response.json(data, {headers});
  access?.finish();
  return response;
}
