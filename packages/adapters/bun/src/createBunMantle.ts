import type { Database } from "bun:sqlite";
import {
  ViewParamCoercionError,
  coerceViewParams,
  compilePathMatcher,
  createMantleRuntime,
  evaluateAuthAll,
  prepareDeployment,
  SqliteMantleStorageAdapter,
  type AnyHandler,
  type HandlerContext,
  type MantleRuntime,
  type MantleRuntimePorts,
  type RuntimePlan,
} from "@aotter/mantle-runtime";
import {
  DiagnosticError,
  HTTP_STATUS_BY_CODE,
  VIEW_PARAMS_RESERVED,
  httpStatusFor,
  redactForWire,
  runtimeDiagnostic,
  type Diagnostic,
  type SiteDefaults,
} from "@aotter/mantle-spec";
import { BunDatabaseDriver } from "./BunDatabaseDriver.js";

const [PAGE_PARAM, SHOW_PARAM] = VIEW_PARAMS_RESERVED;
const VIEW_ROUTE_PREFIX = "/api/views";

export interface CreateBunMantleOptions {
  readonly plan: RuntimePlan;
  readonly database: Database;
  readonly handlers?: Readonly<Record<string, AnyHandler>>;
  readonly siteDefaults?: SiteDefaults;
  readonly ports?: MantleRuntimePorts;
  readonly reservedHttpPathPrefixes?: readonly string[];
}

export interface BunMantle {
  getRuntime(): Promise<MantleRuntime>;
  /** Return `null` when the host should continue through its own router. */
  handle(request: Request, context?: HandlerContext): Promise<Response | null>;
}

/** Embed one prepared Mantle revision in an application-owned Bun process. */
export function createBunMantle(options: CreateBunMantleOptions): BunMantle {
  const driver = new BunDatabaseDriver(options.database);
  const storage = new SqliteMantleStorageAdapter(driver, options.siteDefaults);
  const triggers = options.plan.httpRoutes.map((route) => ({
    ...route,
    match: compilePathMatcher(route.path),
  }));
  const views = new Map(Object.values(options.plan.views)
    .filter(({ manifest }) => manifest.spec.surface === "public")
    .map((view) => [`/api/views/${view.name}`, view]));
  let initialization: Promise<MantleRuntime> | null = null;

  const getRuntime = (): Promise<MantleRuntime> => {
    if (initialization) return initialization;
    initialization = prepareDeployment(options.plan, storage, {
      handlerNames: Object.keys(options.handlers ?? {}),
      reservedHttpPathPrefixes: [
        VIEW_ROUTE_PREFIX,
        ...(options.reservedHttpPathPrefixes ?? []),
      ],
    }).then((prepared) => createMantleRuntime({
      plan: options.plan,
      prepared,
      handlers: options.handlers,
      ports: options.ports,
    })).catch((error) => {
      initialization = null;
      throw error;
    });
    return initialization;
  };

  return {
    getRuntime,
    async handle(request, context = { user: null, staff: null, env: {} }) {
      const url = new URL(request.url);
      const view = request.method === "GET" ? views.get(url.pathname) : undefined;
      const trigger = view ? undefined : triggers.find((route) =>
        route.method === request.method && route.match(url.pathname) !== null,
      );
      if (!view && !trigger) return null;

      try {
        const runtime = await getRuntime();
        if (view) return handleView(request, runtime, view.name, view.manifest, context);
        const pathParams = trigger!.match(url.pathname)!;
        return handleTrigger(request, runtime, trigger!.trigger, trigger!.path, pathParams, context);
      } catch (error) {
        return errorResponse(error, `${request.method} ${url.pathname}`);
      }
    },
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
      expected: "valid JSON",
      message: "HTTP Trigger request body is not valid JSON.",
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
  const pathPrefix = `GET /api/views/${view}`;
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
  return (await request.json() as Record<string, unknown> | null) ?? {};
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
  console.error(`[mantle bun ${operation}] unhandled error`, error);
  return diagnosticResponse(runtimeDiagnostic({
    code: "INTERNAL_ERROR",
    severity: "error",
    path: operation,
    message: "An internal error occurred.",
  }), 500);
}
