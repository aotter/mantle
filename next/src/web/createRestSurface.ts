/**
 * The REST surface (ADR-0032 decision 9): a Fetch function over the runtime. Public Views are `GET {basePath}/views/<name>`;
 * each HTTP Trigger is its own method and path (which the grammar requires to start with `/api/`), with path params
 * bound to the Procedure's input.
 */
import { DiagnosticError, httpStatusFor, makeDiagnostic, redactForWire, type Diagnostic, type JsonSchema } from "../spec/index.js";
import type { Surface } from "../core/index.js";
import type { MantleRuntime } from "../core/index.js";

export interface RestSurfaceOptions {
  /** Where the Views are mounted, e.g. `/api`. HTTP Trigger paths are absolute. */
  readonly basePath: string;
}

const diag = (code: Diagnostic["code"], message: string) => new DiagnosticError(makeDiagnostic({ code, phase: "runtime", severity: "error", path: "rest", message }));

/** Query and path text to the declared JSON type; anything else stays a string. */
function coerce(raw: string, schema: JsonSchema | undefined, name: string): unknown {
  const type = [schema?.type].flat().find((t) => t && t !== "null");
  if (type === "integer" || type === "number") {
    const n = Number(raw);
    if (raw.trim() === "" || !Number.isFinite(n) || (type === "integer" && !Number.isInteger(n))) throw diag("INPUT_VALIDATION_FAILED", `'${name}' must be ${type === "integer" ? "an integer" : "a number"}; got ${JSON.stringify(raw)}.`);
    return n;
  }
  if (type === "boolean") {
    if (raw !== "true" && raw !== "false") throw diag("INPUT_VALIDATION_FAILED", `'${name}' must be true or false; got ${JSON.stringify(raw)}.`);
    return raw === "true";
  }
  return raw;
}

/** `/items/{id}` against a request path, or null. Segments are decoded once; a malformed escape is a routing miss. */
function match(template: string, path: string): Record<string, string> | null {
  const strip = (p: string) => (p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p);
  const t = strip(template).split("/");
  const r = strip(path).split("/");
  if (t.length !== r.length) return null;
  const params: Record<string, string> = {};
  for (const [i, part] of t.entries()) {
    let seg: string;
    try { seg = decodeURIComponent(r[i]!); } catch { return null; }
    if (part.startsWith("{") && part.endsWith("}")) params[part.slice(1, -1)] = seg;
    else if (part !== seg) return null;
  }
  return params;
}

const json = (body: unknown, status = 200) => Response.json(body, { status });
const fail = (e: unknown): Response => {
  if (e instanceof DiagnosticError) return json({ error: redactForWire(e.diagnostic) }, httpStatusFor(e.diagnostic));
  console.error("[mantle rest] unhandled failure", e);
  return json({ error: { code: "INTERNAL_ERROR", message: "An internal error occurred." } }, 500);
};

export function createRestSurface(runtime: MantleRuntime, options: RestSurfaceOptions): Surface {
  const base = options.basePath.replace(/\/+$/, "");
  const { plan } = runtime;
  const routes = Object.entries(plan.triggers).flatMap(([name, t]) => (t.source.kind === "http" ? [{ name, method: t.source.method, path: t.source.path, procedure: t.procedure }] : []));

  return async (request, caller) => {
    try {
      const url = new URL(request.url);
      const path = url.pathname;
      const view = request.method === "GET" ? match(`${base}/views/{name}`, path)?.name : undefined;
      if (view !== undefined) {
        const v = plan.views[view];
        if (!v || v.surface !== "public") throw diag("NOT_FOUND", `no public View '${view}'`);
        const props = v.input?.properties ?? {};
        const input: Record<string, unknown> = {};
        for (const [k, schema] of Object.entries(props)) {
          const raw = url.searchParams.get(k);
          if (raw !== null) input[k] = coerce(raw, schema as JsonSchema, k);
          else if (v.input?.required?.includes(k)) throw diag("INPUT_VALIDATION_FAILED", `View '${view}' requires query param '${k}'.`);
        }
        const limit = url.searchParams.get("limit");
        return json(await runtime.store.as(caller).view(view, { input, ...(limit === null ? {} : { limit: coerce(limit, { type: "integer" }, "limit") as number }), ...(url.searchParams.get("cursor") ? { cursor: url.searchParams.get("cursor")! } : {}) }));
      }

      for (const route of routes) {
        if (route.method !== request.method) continue;
        const params = match(route.path, path);
        if (!params) continue;
        const props = plan.procedures[route.procedure]?.input.properties ?? {};
        let body: unknown = {};
        if (request.body) {
          const text = await request.text();
          try { body = text.trim() ? JSON.parse(text) : {}; } catch { throw diag("INPUT_VALIDATION_FAILED", "the request body is not valid JSON"); }
        }
        if (typeof body !== "object" || body === null || Array.isArray(body)) throw diag("INPUT_VALIDATION_FAILED", "the request body must be a JSON object");
        const input = { ...(body as Record<string, unknown>), ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, coerce(v, props[k] as JsonSchema | undefined, k)])) };
        return json(await runtime.invokeProcedure({ procedure: route.procedure, input, caller, cause: { kind: "http", id: crypto.randomUUID() } }));
      }
      throw diag("NOT_FOUND", "no such route");
    } catch (e) {
      return fail(e);
    }
  };
}
