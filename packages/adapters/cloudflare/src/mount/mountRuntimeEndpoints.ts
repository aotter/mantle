import type { Context, Env, Hono } from "hono";
import { createMantleRequestHandler } from "@aotter/mantle-runtime";
import { rejectCrossOriginMutation } from "../auth/rejectCrossOriginMutation.js";
import type { MantleRuntimeRef } from "./bootRuntimeOnce.js";
import { resolveCaller } from "./resolveCaller.js";

/** Mount manifest-declared HTTP Triggers and public Views only. */
export function mountRuntimeEndpoints<E extends Env>(
  app: Hono<E>,
  ref: MantleRuntimeRef,
): void {
  const handle = createMantleRequestHandler({ plan: ref.plan, getRuntime: () => ref.get() });
  const dispatch = async (c: Context): Promise<Response> => {
    const waitUntil = readWaitUntil(c);
    const caller = await resolveCaller(c.req.raw, {
      auth: ref.auth,
      credentialResolver: ref.credentialResolver,
      jwtBearer: ref.jwtBearer,
      env: c.env,
      waitUntil,
    });
    if (caller.kind === "invalid") {
      return Response.json(
        { ok: false, diagnostic: caller.diagnostic },
        { status: caller.status },
      );
    }
    if (caller.context.auth?.credential === "session" && c.req.method !== "GET") {
      const rejected = rejectCrossOriginMutation(c.req.raw);
      if (rejected) return rejected;
    }
    return await handle(c.req.raw, caller.context)
      ?? new Response("not found", { status: 404 });
  };

  for (const route of ref.plan.httpRoutes) {
    app.on(route.method, openApiToHono(route.path), dispatch);
  }
  for (const view of Object.values(ref.plan.views)) {
    if (view.manifest.spec.surface === "public") {
      app.get(`/api/views/${view.name}`, dispatch);
    }
  }
}

function openApiToHono(path: string): string {
  return path.replace(/\{([^}]+)\}/g, ":$1");
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
