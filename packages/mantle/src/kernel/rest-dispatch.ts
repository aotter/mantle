/** View/Procedure dispatch loads only on a matched REST request, after the pipeline guarded the call. */
import type { Caller } from "./contracts.js";
import { convert, invalid } from "./surface.js";
import { body, type Options, type Route } from "./rest.js";
import { resultData } from "./result-meta.js";

const fail: (message: string) => never = message => invalid(message, "rest");
function number(raw: string): number {
  const value = Number(raw);
  if (!raw.trim() || !Number.isFinite(value)) fail("Expected a number.");
  return value;
}
function boolean(raw: string): boolean {
  if (raw !== "true" && raw !== "false") fail("Expected true or false.");
  return raw === "true";
}
/** A path parameter as the Procedure input declares it. */
const typed = (raw: string, type: "number" | "boolean" | undefined): unknown =>
  type === "number" ? number(raw) : type === "boolean" ? boolean(raw) : raw;

const pointer = (key: string) => key.replace(/~/g, "~0").replace(/\//g, "~1");
/**
 * A strict route's input: path parameters merged into the query string and read by the View's own reader. A path
 * parameter repeated in the query, a repeated query parameter and an undeclared one are refused, in that order, all
 * before the database is opened. Paging is `limit` and `cursor`, as on the View's generated route.
 */
function strictQuery<Database, Handlers, Env>(
  route: Route<Database, Handlers, Env>,
  search: URLSearchParams,
  params: Record<string, string>,
): { input: Record<string, unknown>; paging: { limit?: number; cursor?: string } } {
  const target = typeof route.target === "object" ? route.target : undefined;
  const operation = target?.kind === "view" ? `views/${target.name}` : "rest";
  const at = (key: string) =>
    key === "limit" || key === "cursor" ? `${operation}/${key}` : `${operation}/input/${pointer(key)}`;
  const keys = [...new Set(search.keys())];
  for (const key of keys)
    if (Object.hasOwn(params, key)) invalid("Path parameter is repeated in the query string.", at(key));
  for (const key of keys) if (search.getAll(key).length > 1) invalid("Query parameter is repeated.", at(key));
  const merged = new URLSearchParams(search);
  for (const key in params) merged.set(key, params[key]!);
  const { input: raw, ...paging } = route.query!(merged);
  for (const key of new Set(merged.keys()))
    if (key !== "limit" && key !== "cursor" && !Object.hasOwn(raw, key)) invalid("Unknown query parameter.", at(key));
  return { input: { ...raw }, paging };
}

/** Decode the input, then run the View or Procedure. */
export async function dispatch<Database, Handlers, Env>(
  route: Route<Database, Handlers, Env>,
  request: Request,
  getDb: () => Database,
  caller: Caller,
  params: Record<string, string>,
  options: Options<Env, Database> & { handlers?: Handlers },
): Promise<Response> {
  let data: unknown;
  if (route.page && route.strict) {
    const { input, paging } = strictQuery(route, new URL(request.url).searchParams, params);
    convert(input, route.convert);
    data = await route.page(getDb(), caller, input as never, paging);
  } else if (route.page) {
    const { input: raw, ...paging } = route.query!(new URL(request.url).searchParams);
    const input = { ...raw };
    convert(input, route.convert);
    data = await route.page(getDb(), caller, input as never, paging);
  } else {
    const raw = await body(request);
    for (const key in params) raw[key] = typed(params[key]!, route.params?.[key]);
    const input = route.validate!(raw);
    convert(input, route.convert);
    data = await route.run!(getDb(), caller, input as never, options.handlers as Handlers);
  }
  // A route's `withResult` wrapper is for MCP: REST answers its data; the blocks and `_meta` stay out.
  data = resultData(data);
  const headers = { "cache-control": "private, no-store" };
  return request.method === "HEAD" ? new Response(null, { headers }) : Response.json(data, { headers });
}
