import { Hono } from "hono";
import {
  AssetsAssetServer,
  D1DatabaseDriver,
  KvCacheBinding,
  createCmsRef,
  createMcpApiHandler,
  createOAuthProvider,
  createSetupIncompleteAuth,
  mountAuthorize,
  mountServerEndpoints,
  runMantleUseCase,
  runMantleWorkerRequest,
  setupIncompleteAuthResponse,
} from "@aotter/mantle/cloudflare";
import type { Manifest } from "@aotter/mantle/spec";

interface Env {
  readonly DB: D1Database;
  readonly KV: KVNamespace;
  readonly OAUTH_KV: KVNamespace;
  readonly ASSETS?: Fetcher;
  readonly AUDIT_QUEUE: Queue<{ readonly kind: "custom-route" }>;
}

let assembled: ReturnType<typeof assemble> | undefined;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return runMantleWorkerRequest(async () => {
      assembled ??= assemble(env);
      const setupIncomplete = await setupIncompleteAuthResponse(request, assembled.auth);
      if (setupIncomplete) return setupIncomplete;
      return assembled.fetch(request, env, ctx);
    });
  },
} satisfies ExportedHandler<Env>;

function assemble(env: Env) {
  const auth = createSetupIncompleteAuth();
  const ref = createCmsRef({
    manifests,
    bindings: {
      db: new D1DatabaseDriver(env.DB),
      kv: new KvCacheBinding(env.KV),
      assets: env.ASSETS
        ? new AssetsAssetServer(env.ASSETS)
        : { fetch: async () => null },
    },
    auth,
  });
  const app = new Hono<{ Bindings: Env }>();
  mountServerEndpoints(app, ref);
  mountAuthorize(app, { auth });
  app.post("/api/custom-audit", (c) => runMantleUseCase(
    "POST /api/custom-audit",
    async () => {
      await c.env.AUDIT_QUEUE.send({ kind: "custom-route" });
      return { ok: true, queued: true };
    },
  ));
  app.get("/cache-probe", () =>
    new Response("public", { headers: { "cache-control": "public, s-maxage=60" } }));
  const provider = createOAuthProvider<Env>({
    defaultHandler: { fetch: (request, workerEnv, ctx) => app.fetch(request, workerEnv, ctx) },
    apiHandlers: {
      "/mcp": createMcpApiHandler({ ref, surface: "public" }),
      "/mcp/staff": createMcpApiHandler({ ref, surface: "staff" }),
    },
  });
  return { auth, fetch: provider.fetch.bind(provider) };
}

const manifests = [
  {
    apiVersion: "cms.mantle.aotter.net/v1",
    kind: "Schema",
    metadata: { name: "notes" },
    spec: {
      title: "Notes",
      schema: {
        type: "object",
        required: ["title"],
        properties: { title: { type: "string" } },
      },
      lifecycle: "simple",
    },
  },
  {
    apiVersion: "cms.mantle.aotter.net/v1",
    kind: "View",
    metadata: { name: "published-notes" },
    spec: {
      from: "notes",
      fields: ["id", "title"],
      filter: { eq: { field: "status", value: "published" } },
    },
  },
] as const satisfies readonly Manifest[];
