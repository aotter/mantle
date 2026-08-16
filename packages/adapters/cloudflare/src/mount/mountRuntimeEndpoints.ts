import type { Context, Env, Hono } from "hono";
import {
  HTTP_STATUS_BY_CODE,
  VIEW_PARAMS_RESERVED,
  redactForWire,
  runtimeDiagnostic,
} from "@aotter/mantle-spec";
import {
  ViewParamCoercionError,
  coerceViewParams,
  compilePathMatcher,
  evaluateAuthAll,
  type CmsRuntime,
} from "@aotter/mantle-runtime";
import { rejectCrossOriginMutation } from "../auth/rejectCrossOriginMutation.js";
import type { CmsRuntimeRef } from "./bootRuntimeOnce.js";
import { resolveCaller } from "./resolveCaller.js";

const [PAGE_PARAM, SHOW_PARAM] = VIEW_PARAMS_RESERVED;

/** Mount manifest-declared HTTP Triggers and public Views only. */
export function mountRuntimeEndpoints<E extends Env>(
  app: Hono<E>,
  ref: CmsRuntimeRef,
): void {
  for (const manifest of ref.manifests) {
    if (manifest.kind !== "Trigger" || manifest.spec.source.kind !== "http") continue;
    const { method, path } = manifest.spec.source;
    const matchPath = compilePathMatcher(path);
    const trigger = manifest.metadata.name;
    app.on(method, openApiToHono(path), async (c) => {
      const runtime = await ref.get();
      return handleHttpTrigger(
        c.req.raw,
        runtime,
        ref,
        trigger,
        path,
        matchPath(c.req.path) ?? {},
        c.env,
        readWaitUntil(c),
      );
    });
  }

  for (const manifest of ref.manifests) {
    if (manifest.kind !== "View" || manifest.spec.surface !== "public") continue;
    const view = manifest.metadata.name;
    app.get(`/api/views/${view}`, async (c) => {
      const runtime = await ref.get();
      return handlePublicView(
        c.req.raw,
        runtime,
        ref,
        view,
        c.env,
        readWaitUntil(c),
      );
    });
  }
}

async function handleHttpTrigger(
  request: Request,
  runtime: CmsRuntime,
  ref: CmsRuntimeRef,
  trigger: string,
  triggerPath: string,
  pathParams: Readonly<Record<string, string>>,
  env: unknown,
  waitUntil: ((promise: Promise<unknown>) => void) | undefined,
): Promise<Response> {
  const pathPrefix = `${request.method} ${triggerPath}`;
  const caller = await resolveCaller(request, {
    auth: ref.auth,
    credentialResolver: ref.credentialResolver,
    jwtBearer: ref.jwtBearer,
    env,
    waitUntil,
  });
  if (caller.kind === "invalid") {
    return Response.json(
      { ok: false, diagnostic: caller.diagnostic },
      { status: caller.status },
    );
  }
  if (caller.context.auth?.credential === "session") {
    const rejected = rejectCrossOriginMutation(request);
    if (rejected) return rejected;
  }

  let body: Record<string, unknown>;
  try {
    body = await readBody(request);
  } catch {
    const diagnostic = runtimeDiagnostic({
      code: "INPUT_VALIDATION_FAILED",
      severity: "error",
      path: `${pathPrefix}#/body`,
      expected: "valid JSON",
      message: "HTTP Trigger request body is not valid JSON.",
    });
    return Response.json(
      { ok: false, diagnostic: redactForWire(diagnostic) },
      { status: 400 },
    );
  }

  const result = await runtime.core.invokeTrigger({
    trigger,
    input: { ...body, ...pathParams },
    ctx: caller.context,
    pathPrefix,
  });
  if (result.ok) return Response.json({ ok: true, data: result.data });
  return Response.json(
    { ok: false, diagnostic: redactForWire(result.diagnostic) },
    { status: HTTP_STATUS_BY_CODE[result.diagnostic.code] ?? 500 },
  );
}

async function handlePublicView(
  request: Request,
  runtime: CmsRuntime,
  ref: CmsRuntimeRef,
  viewName: string,
  env: unknown,
  waitUntil: ((promise: Promise<unknown>) => void) | undefined,
): Promise<Response> {
  const view = runtime.viewsByName.get(viewName);
  if (!view) {
    return Response.json({
      ok: false,
      diagnostic: runtimeDiagnostic({
        code: "INTERNAL_ERROR",
        severity: "error",
        path: `GET /api/views/${viewName}`,
        message: `View '${viewName}' is missing after boot.`,
      }),
    }, { status: 500 });
  }
  const pathPrefix = `GET /api/views/${viewName}`;
  const caller = await resolveCaller(request, {
    auth: ref.auth,
    credentialResolver: ref.credentialResolver,
    jwtBearer: ref.jwtBearer,
    env,
    waitUntil,
  });
  if (caller.kind === "invalid") {
    return Response.json(
      { ok: false, diagnostic: caller.diagnostic },
      { status: caller.status },
    );
  }

  const url = new URL(request.url);
  let params: Record<string, unknown>;
  try {
    params = coerceViewParams(view, url.searchParams);
  } catch (error) {
    if (!(error instanceof ViewParamCoercionError)) throw error;
    if (view.spec.requires?.auth) {
      const denial = evaluateAuthAll(view.spec.requires, caller.context, pathPrefix, "runtime");
      if (denial) {
        return Response.json(
          { ok: false, diagnostic: denial },
          { status: HTTP_STATUS_BY_CODE[denial.code] ?? 403 },
        );
      }
    }
    return Response.json({
      ok: false,
      diagnostic: runtimeDiagnostic({
        code: "INPUT_VALIDATION_FAILED",
        severity: "error",
        path: pathPrefix,
        expected: "query string conforms to View.spec.params",
        message: error.message,
      }),
    }, { status: 400 });
  }

  const result = await runtime.core.executeView({
    view: viewName,
    pathPrefix,
    options: {
      params,
      page: parsePositiveInt(url.searchParams.get(PAGE_PARAM)),
      show: parsePositiveInt(url.searchParams.get(SHOW_PARAM)),
    },
    ctx: caller.context,
  });
  if (result.ok) return Response.json({ ok: true, data: result.result });
  return Response.json(
    { ok: false, diagnostic: redactForWire(result.diagnostic) },
    { status: HTTP_STATUS_BY_CODE[result.diagnostic.code] ?? 500 },
  );
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  if (request.method === "GET" || request.method === "DELETE" || request.method === "HEAD") {
    return {};
  }
  if (!(request.headers.get("content-type") ?? "").includes("json")) return {};
  return await request.json<Record<string, unknown> | null>() ?? {};
}

function openApiToHono(path: string): string {
  return path.replace(/\{([^}]+)\}/g, ":$1");
}

function parsePositiveInt(raw: string | null): number | undefined {
  if (raw == null || raw === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

/** Hono throws outside a Workers execution context; other runtimes await inline. */
export function readWaitUntil(
  context: Context,
): ((promise: Promise<unknown>) => void) | undefined {
  try {
    const execution = context.executionCtx;
    return execution.waitUntil.bind(execution);
  } catch {
    return undefined;
  }
}
