# Low-level Cloudflare Worker composition

Use `createMantleWorker` unless the application must own the top-level Worker
assembly. This copyable fixture keeps Mantle's standard bindings, Auth,
Admin/API routes, OAuth/MCP dispatch, cache policy and redacted error boundary,
while adding one application-owned post-response Queue audit across every route.

```ts
import { Hono } from "hono";
import {
  createMantleRuntimeRef,
  createConventionalAuth,
  createConventionalBindings,
  createMcpApiHandler,
  createOAuthProvider,
  mountAuthorize,
  mountAdmin,
  mountRuntimeEndpoints,
  runMantleWorkerRequest,
  setupIncompleteAuthResponse,
  type MantleCloudflareEnv,
} from "@aotter/mantle/cloudflare";
import { plan } from "../.mantle/generated/mantle.js";

interface Env extends MantleCloudflareEnv {
  readonly AUDIT_QUEUE: Queue<{
    readonly kind: "request-complete";
    readonly path: string;
    readonly status: number;
  }>;
}

let assembled: ReturnType<typeof assemble> | undefined;

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return runMantleWorkerRequest(async () => {
      assembled ??= assemble(env);
      const incomplete = await setupIncompleteAuthResponse(request, assembled.auth);
      const response = incomplete ?? await assembled.fetch(request, env, ctx);
      ctx.waitUntil(env.AUDIT_QUEUE.send({
        kind: "request-complete",
        path: new URL(request.url).pathname,
        status: response.status,
      }));
      return response;
    });
  },
} satisfies ExportedHandler<Env>;

function assemble(env: Env) {
  const bindings = createConventionalBindings(env);
  const auth = createConventionalAuth(env);
  const ref = createMantleRuntimeRef({ plan, bindings, auth });
  const app = new Hono<{ Bindings: Env }>();

  mountRuntimeEndpoints(app, ref);
  if (bindings.adminAssets) mountAdmin(app, ref, bindings.adminAssets);
  mountAuthorize(app, { auth, loginPath: "/admin/sign-in" });
  app.get("/cache-probe", () => new Response("public", {
    headers: { "cache-control": "public, s-maxage=60" },
  }));

  const provider = createOAuthProvider<Env>({
    defaultHandler: {
      fetch: (request, workerEnv, ctx) => app.fetch(request, workerEnv, ctx),
    },
    apiHandlers: {
      "/mcp/staff": createMcpApiHandler<Env>({ ref, surface: "staff" }),
      "/mcp": createMcpApiHandler<Env>({ ref, surface: "public" }),
    },
  });
  return { auth, fetch: provider.fetch.bind(provider) };
}
```

Keep the conventional `DB` and `OAUTH_KV` bindings and
`nodejs_compat`; add the Queue producer in `wrangler.jsonc`:

```jsonc
{
  "compatibility_flags": ["nodejs_compat", "global_fetch_strictly_public"],
  "queues": {
    "producers": [
      { "binding": "AUDIT_QUEUE", "queue": "my-site-audit" }
    ]
  }
}
```

After copying, the Worker entry, request audit, custom route and Queue contract
belong to the application. Mantle still owns the imported adapters and
standard route behavior; update them through the package version. Do not copy
their source or replace Auth, MCP or cache handling locally. A copied
composition has no automatic merge path back to `createMantleWorker`; keep it
only while the custom top-level lifecycle remains necessary.
