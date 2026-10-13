/** View/Procedure dispatch loads only on a matched REST request, after caller resolution. */
import type { Caller } from "./contracts.js";
import { convert, invalid } from "./surface.js";
import { body, type Route } from "./rest.js";
const fail: (message: string) => never = message => invalid(message, "rest");
function number(raw: string): number { const value = Number(raw); if (!raw.trim() || !Number.isFinite(value)) fail("Expected a number."); return value; }
function boolean(raw: string): boolean { if (raw !== "true" && raw !== "false") fail("Expected true or false."); return raw === "true"; }
export async function dispatch<Database, Handlers, Env>(route: Route<Database, Handlers, Env>, request: Request, getDb: () => Database, caller: Caller, params: Record<string, string>, handlers: Handlers): Promise<unknown> {
  if (route.page) {
    const { input: raw, ...paging } = route.query!(new URL(request.url).searchParams);
    const input = { ...raw };
    convert(input, route.convert);
    return route.page(getDb(), caller, input as never, paging);
  }
  const raw = await body(request);
  for (const key in params) raw[key] = route.params?.[key] === "number" ? number(params[key]!) : route.params?.[key] === "boolean" ? boolean(params[key]!) : params[key];
  const input = route.validate!(raw);
  convert(input, route.convert);
  return route.run!(getDb(), caller, input as never, handlers);
}

