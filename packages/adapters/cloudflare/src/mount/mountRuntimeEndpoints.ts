import type { Context, Env, Hono } from "hono";
import {
  createMantleRequestHandler,
  projectCallableCapabilities,
} from "@aotter/mantle-runtime";
import type { MantleRuntimeRef } from "./bootRuntimeOnce.js";
import { gateCaller } from "./resolveCaller.js";

/** Mount manifest-declared HTTP Triggers and public Views only. */
export function mountRuntimeEndpoints<E extends Env>(
  app: Hono<E>,
  ref: MantleRuntimeRef,
): void {
  const handle = createMantleRequestHandler({
    plan: ref.plan,
    getRuntime: () => ref.get(),
    allowSharedViewCache: !ref.credentialResolver && Boolean(ref.publicCacheTag),
    publicCacheTag: ref.publicCacheTag,
  });
  const dispatch = async (c: Context): Promise<Response> => {
    // Credential resolvers and fresh roles may use the same canonical database.
    await ref.get();
    const waitUntil = readWaitUntil(c);
    const gate = await gateCaller(c.req.raw, {
      auth: ref.auth,
      credentialResolver: ref.credentialResolver,
      jwtBearer: ref.jwtBearer,
      env: c.env,
      waitUntil,
    });
    if (gate.kind === "deny") {
      return Response.json(
        { ok: false, diagnostic: gate.diagnostic },
        { status: gate.status },
      );
    }
    return await handle(c.req.raw, gate.context)
      ?? new Response("not found", { status: 404 });
  };

  for (const route of ref.plan.httpRoutes) {
    app.on(route.method, openApiToHono(route.path), dispatch);
  }
  const publicViews = projectCallableCapabilities(ref.plan, { surface: "public" })
    .filter((capability) => capability.kind === "view")
    .map((capability) => ({
      name: capability.name,
      target: { kind: "view", name: capability.ownerName },
      ...(capability.title ? { title: capability.title } : {}),
      description: capability.description,
      inputSchema: capability.inputSchema as Record<string, unknown>,
    }));
  app.get("/api/views", () => Response.json({ ok: true, data: publicViews }));
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
