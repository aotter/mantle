import {
  DiagnosticError,
  HTTP_STATUS_BY_CODE,
  VIEW_PARAMS_RESERVED,
  httpStatusFor,
  redactForWire,
  runtimeDiagnostic,
  type Diagnostic,
} from "@aotter/mantle-spec";
import type { MantleRuntime } from "../../MantleRuntime.js";
import type { HandlerContext } from "../../domain/model/HandlerContext.js";
import { evaluateAuthAll } from "../../domain/service/AuthPredicateEvaluator.js";
import { compilePathMatcher } from "../../domain/service/PathMatcher.js";
import type { RuntimePlan } from "../../domain/service/RuntimePlanCompiler.js";
import {
  ViewParamCoercionError,
  coerceViewParams,
} from "../../domain/service/ViewParamCoercer.js";

const [PAGE_PARAM, SHOW_PARAM] = VIEW_PARAMS_RESERVED;
export const MANTLE_VIEW_ROUTE_PREFIX = "/api/views";

export interface MantleRequestHandlerOptions {
  readonly plan: RuntimePlan;
  readonly getRuntime: () => Promise<MantleRuntime>;
}

export type MantleRequestHandler = (
  request: Request,
  context?: HandlerContext,
) => Promise<Response | null>;

/** Map the portable public View/HTTP Trigger surface onto Web Requests. */
export function createMantleRequestHandler(
  options: MantleRequestHandlerOptions,
): MantleRequestHandler {
  const triggers = options.plan.httpRoutes.map((route) => ({
    ...route,
    match: compilePathMatcher(route.path),
  }));
  const views = new Map(Object.values(options.plan.views)
    .filter(({ manifest }) => manifest.spec.surface === "public")
    .map((view) => [`${MANTLE_VIEW_ROUTE_PREFIX}/${view.name}`, view]));

  return async (request, context = { user: null, staff: null, env: {} }) => {
    const url = new URL(request.url);
    const view = request.method === "GET" ? views.get(url.pathname) : undefined;
    const trigger = view ? undefined : triggers.find((route) =>
      route.method === request.method && route.match(url.pathname) !== null,
    );
    if (!view && !trigger) return null;

    try {
      const runtime = await options.getRuntime();
      if (view) return handleView(request, runtime, view.name, view.manifest, context);
      const pathParams = trigger!.match(url.pathname)!;
      return handleTrigger(
        request,
        runtime,
        trigger!.trigger,
        trigger!.path,
        pathParams,
        context,
      );
    } catch (error) {
      return errorResponse(error, `${request.method} ${url.pathname}`);
    }
  };
}

async function handleTrigger(
  request: Request,
  runtime: MantleRuntime,
  trigger: string,
  triggerPath: string,
  pathParams: Readonly<Record<string, string>>,
  context: HandlerContext,
): Promise<Response> {
  const pathPrefix = `${request.method} ${triggerPath}`;
  let body: Record<string, unknown>;
  try {
    body = await readBody(request);
  } catch {
    return diagnosticResponse(runtimeDiagnostic({
      code: "INPUT_VALIDATION_FAILED",
      severity: "error",
      path: `${pathPrefix}#/body`,
      expected: "JSON object",
      message: "HTTP Trigger request body must be a JSON object.",
    }), 400);
  }
  const result = await runtime.invokeTrigger({
    trigger,
    input: { ...body, ...pathParams },
    ctx: context,
    pathPrefix,
  });
  return result.ok
    ? Response.json({ ok: true, data: result.data })
    : diagnosticResponse(result.diagnostic);
}

async function handleView(
  request: Request,
  runtime: MantleRuntime,
  view: string,
  manifest: RuntimePlan["views"][string]["manifest"],
  context: HandlerContext,
): Promise<Response> {
  const pathPrefix = `GET ${MANTLE_VIEW_ROUTE_PREFIX}/${view}`;
  const search = new URL(request.url).searchParams;
  let params: Record<string, unknown>;
  try {
    params = coerceViewParams(manifest, search);
  } catch (error) {
    if (!(error instanceof ViewParamCoercionError)) throw error;
    const denial = manifest.spec.requires?.auth
      ? evaluateAuthAll(manifest.spec.requires, context, pathPrefix, "runtime")
      : null;
    if (denial) return diagnosticResponse(denial);
    return diagnosticResponse(runtimeDiagnostic({
      code: "INPUT_VALIDATION_FAILED",
      severity: "error",
      path: pathPrefix,
      expected: "query string conforms to View.spec.params",
      message: error.message,
    }), 400);
  }
  const result = await runtime.executeView({
    view,
    options: {
      params,
      page: positiveNumber(search.get(PAGE_PARAM)),
      show: positiveNumber(search.get(SHOW_PARAM)),
    },
    ctx: context,
    pathPrefix,
  });
  return result.ok
    ? Response.json({ ok: true, data: result.result })
    : diagnosticResponse(result.diagnostic);
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  if (["GET", "DELETE", "HEAD"].includes(request.method)) return {};
  if (!(request.headers.get("content-type") ?? "").includes("json")) return {};
  const value: unknown = await request.json();
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("expected a JSON object");
  }
  return value as Record<string, unknown>;
}

function positiveNumber(value: string | null): number | undefined {
  if (!value) return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

function diagnosticResponse(
  diagnostic: Diagnostic,
  status = HTTP_STATUS_BY_CODE[diagnostic.code] ?? httpStatusFor(diagnostic),
): Response {
  return Response.json(
    { ok: false, diagnostic: redactForWire(diagnostic) },
    { status },
  );
}

function errorResponse(error: unknown, operation: string): Response {
  if (error instanceof DiagnosticError) return diagnosticResponse(error.diagnostic);
  console.error(`[mantle http ${operation}] unhandled error`, error);
  return diagnosticResponse(runtimeDiagnostic({
    code: "INTERNAL_ERROR",
    severity: "error",
    path: operation,
    message: "An internal error occurred.",
  }), 500);
}
