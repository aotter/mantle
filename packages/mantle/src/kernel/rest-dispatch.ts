/** View/Procedure dispatch loads only on a matched REST request, after the pipeline guarded the call. */
import type { Caller } from "./contracts.js";
import type { Pipeline } from "./request-pipeline.js";
import { convert, invalid } from "./surface.js";
import { body, type Options, type Route } from "./rest.js";

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

/** Decode the input, answer a dry run, else run the View or Procedure. */
export async function dispatch<Database, Handlers, Env>(
  route: Route<Database, Handlers, Env>, request: Request, getDb: () => Database, caller: Caller, params: Record<string, string>,
  options: Options<Env, Database> & { handlers?: Handlers }, pipeline: Pipeline,
): Promise<Response> {
  let data: unknown;
  if (route.page) {
    const { input: raw, ...paging } = route.query!(new URL(request.url).searchParams);
    const input = { ...raw };
    convert(input, route.convert);
    if (pipeline.dryRun) return pipeline.dryRunResponse();
    data = await route.page(getDb(), caller, input as never, paging);
  } else {
    const raw = await body(request);
    for (const key in params) raw[key] = typed(params[key]!, route.params?.[key]);
    const input = route.validate!(raw);
    convert(input, route.convert);
    if (pipeline.dryRun) return pipeline.dryRunResponse();
    data = await route.run!(getDb(), caller, input as never, options.handlers as Handlers);
  }
  const headers = { "cache-control": "private, no-store" };
  return request.method === "HEAD" ? new Response(null, { headers }) : Response.json(data, { headers });
}
