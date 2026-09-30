/** HTTP plumbing shared by the REST and Admin surfaces: path matching, query coercion, JSON bodies and the error envelope. Not a public name. */
import { DiagnosticError, httpStatusFor, makeDiagnostic, redactForWire, type Diagnostic } from "../spec/kernel/index.js";
import type { JsonSchema, PlanView } from "../spec/domain/index.js";

export const wireError = (code: Diagnostic["code"], message: string, path: string) => new DiagnosticError(makeDiagnostic({ code, phase: "runtime", severity: "error", path, message }));

/** Query and path text to the declared JSON type; anything else stays a string. */
export function coerce(raw: string, schema: JsonSchema | undefined, name: string, path: string): unknown {
  const type = [schema?.type].flat().find((t) => t && t !== "null");
  if (type === "integer" || type === "number") {
    const n = Number(raw);
    if (raw.trim() === "" || !Number.isFinite(n) || (type === "integer" && !Number.isInteger(n))) throw wireError("INPUT_VALIDATION_FAILED", `'${name}' must be ${type === "integer" ? "an integer" : "a number"}; got ${JSON.stringify(raw)}.`, path);
    return n;
  }
  if (type === "boolean") {
    if (raw !== "true" && raw !== "false") throw wireError("INPUT_VALIDATION_FAILED", `'${name}' must be true or false; got ${JSON.stringify(raw)}.`, path);
    return raw === "true";
  }
  return raw;
}

/** `/items/{id}` against a request path, or null. Segments are decoded once; a malformed escape is a routing miss. */
export function match(template: string, path: string): Record<string, string> | null {
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

/** A View's declared input, `limit` and `cursor` from a query string, as `store.view` takes them. */
export function viewQuery(name: string, v: PlanView, query: URLSearchParams, path: string): { input: Record<string, unknown>; limit?: number; cursor?: string } {
  const input: Record<string, unknown> = {};
  for (const [k, schema] of Object.entries(v.input?.properties ?? {})) {
    const raw = query.get(k);
    if (raw !== null) input[k] = coerce(raw, schema as JsonSchema, k, path);
    else if (v.input?.required?.includes(k)) throw wireError("INPUT_VALIDATION_FAILED", `View '${name}' requires query param '${k}'.`, path);
  }
  const limit = query.get("limit");
  const cursor = query.get("cursor");
  return { input, ...(limit === null ? {} : { limit: coerce(limit, { type: "integer" }, "limit", path) as number }), ...(cursor ? { cursor } : {}) };
}

const MAX_BODY = 1_000_000;

/** The request body as a JSON object; no body is `{}`. */
export async function readJsonObject(request: Request, path: string): Promise<Record<string, unknown>> {
  let body: unknown = {};
  if (request.body) {
    const text = await request.text();
    if (text.length > MAX_BODY) throw wireError("INPUT_VALIDATION_FAILED", `the request body is larger than ${MAX_BODY} characters`, path);
    try { body = text.trim() ? JSON.parse(text) : {}; } catch { throw wireError("INPUT_VALIDATION_FAILED", "the request body is not valid JSON", path); }
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw wireError("INPUT_VALIDATION_FAILED", "the request body must be a JSON object", path);
  return body as Record<string, unknown>;
}

export const json = (body: unknown, status = 200, headers?: Record<string, string>): Response => Response.json(body, { status, ...(headers ? { headers } : {}) });

/** A DiagnosticError answers with its own status; anything else is logged and never leaks. */
export function failure(e: unknown, surface: string, headers?: Record<string, string>): Response {
  if (e instanceof DiagnosticError) return json({ error: redactForWire(e.diagnostic) }, httpStatusFor(e.diagnostic), headers);
  console.error(`[mantle ${surface}] unhandled failure`, e);
  return json({ error: { code: "INTERNAL_ERROR", message: "An internal error occurred." } }, 500, headers);
}
