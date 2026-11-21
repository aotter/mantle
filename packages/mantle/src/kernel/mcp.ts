/** MCP request handling for a generated tool table; the official SDK loads on the first MCP request. */
import type { Caller, Target, Authorize, Gateway, RequestContext, GatewayOptions } from "./contracts.js";
import type { Conversions } from "./surface.js";
import { linkApps, linkSurface, resourcesOf, type McpAppsSource } from "./mcp-apps.js";
// ponytail: a lazy forwarder keeps the public export without pulling paging and call code into every Worker's startup graph.
type Call = typeof import("./mcp-call.js");
// Application seam: applications depend on this. Do not remove or narrow it because Core has no internal use (CONTRIBUTING.md, "Application seams").
export const callTool: Call["callTool"] = async (...args) => (await import("./mcp-call.js")).callTool(...args);
export const callToolLazy: Call["callToolLazy"] = async (...args) =>
  (await import("./mcp-call.js")).callToolLazy(...args);
export type {
  McpApps,
  McpAppsSource,
  McpAppResource,
  McpAppRender,
  McpAppPage,
  McpAppCsp,
  NormalMcpApps,
  NormalMcpAppResource,
} from "./mcp-apps.js";

/** An MCP icon, as `serverInfo`, a tool and an App resource list it. */
export interface McpIcon {
  readonly src: string;
  readonly mimeType?: string;
  readonly sizes?: readonly string[];
  readonly theme?: "light" | "dark";
}

/** Options of a generated `mcp(...)`; it adds required `handlers` when the app declares ref Procedures. */
export interface Options<Env, Database> extends GatewayOptions {
  apps?: Readonly<Partial<Record<"public" | "admin", McpAppsSource | readonly McpAppsSource[]>>>;
  authorize?: Authorize;
  /**
   * With `authorize`: `"authorized"` (default) lists only the tools each caller may call, and resource HTML loaders get
   * those names; `"all"` lists the endpoint's whole catalogue to every caller, so a host's saved tool list stays valid
   * when a caller's grant changes, and `authorize` decides at call time. Listing a tool grants nothing either way.
   */
  discovery?: "authorized" | "all";
  /** Host platform contract, versioned by `v`; stable within a version. */
  gateway?: Gateway;
  db: (env: Env) => Database;
  caller?: (request: Request, env: Env, authority: { readonly readOnly: boolean }) => Caller | Promise<Caller>;
  locale?: string;
  instructions?: string;
  serverInfo?: {
    name?: string;
    title?: string;
    version?: string;
    description?: string;
    websiteUrl?: string;
    icons?: readonly McpIcon[];
  };
  requiredScopes?: readonly string[];
  /** Additional scopes requested by an unauthenticated OAuth challenge (for example offline_access), not an API scope floor. */
  authorizationScopes?: readonly string[];
  resourceMetadata?: string;
  /** Browser origins MCP answers besides loopback, compared by hostname: `https://console.example` or the official SDK's bare `console.example`. The site's own origin is not implied. */
  allowedOrigins?: readonly string[];
  onObservation?: (event: McpObservation) => void | Promise<void>;
  /** Tools per `tools/list` page: the result carries `nextCursor` while more remain. Unset, one page lists every tool. */
  toolsPageSize?: number;
}
export type McpObservation =
  | {
      readonly kind: "request-refused";
      readonly at: number;
      readonly surface: "public" | "admin";
      readonly status: 400 | 401 | 403;
      /**
       * `origin`: a browser Origin the endpoint or the session Origin rule refused; `credential`: the caller's credential;
       * `protocol-version` (status 400): a request that names a protocol revision neither era serves (a `_meta` envelope
       * claiming another revision, refused with JSON-RPC -32022, or an unsupported `MCP-Protocol-Version` header).
       */
      readonly reason: "origin" | "credential" | "protocol-version";
    }
  | ({
      readonly kind: "invocation";
      readonly at: number;
      readonly surface: "public" | "admin";
      readonly invocationId: string;
      readonly tool: string;
      readonly caller: Caller;
      /** The `clientInfo` name and version the request's `_meta` declares (2026-07-28; a stateless 2025-era call carries none). */
      readonly client?: { readonly name: string; readonly version: string };
      /**
       * The protocol revision the call is served on: `2026-07-28`, or a 2025-era revision (the `MCP-Protocol-Version`
       * header, `2025-03-26` when the client sent none, as the SDK assumes).
       */
      readonly protocolVersion?: string;
    } & (
      | { readonly phase: "attempt" }
      | {
          readonly phase: "completion";
          readonly outcome: "succeeded" | "failed" | "denied";
          readonly durationMs: number;
          readonly code?: string;
        }
    ));
import type { LocalizedText } from "./localized-schema.js";
type Paging = { limit?: number; cursor?: string };
/** One tool: a paged View (`page`) or a Procedure (`run`, a write), on the public or admin surface. */
export interface Tool<Database, Handlers = never> {
  readonly readOnly?: boolean;
  readonly name: string;
  readonly target?: Target;
  /** Generated requires guard, used before application authorization. */
  readonly check?: (caller: Caller) => void;
  readonly surface: string;
  readonly title?: LocalizedText;
  readonly description: LocalizedText;
  readonly outputSchema?: unknown;
  readonly icons?: readonly McpIcon[];
  readonly annotations?: {
    readonly title?: string;
    readonly readOnlyHint?: boolean;
    readonly destructiveHint?: boolean;
    readonly openWorldHint?: boolean;
    readonly idempotentHint?: boolean;
  };
  readonly inputSchema: unknown;
  /** The listed definition's version; results carry it so a model holding an older definition can tell. */
  readonly version?: string;
  /** Declares an auth requirement: anonymous callers are challenged. */
  readonly closed?: boolean;
  /** Scopes the requirement names; only a tool with some admits a service credential. */
  readonly scopes?: readonly string[];
  readonly validate: (raw: unknown) => Record<string, unknown> | Promise<Record<string, unknown>>;
  readonly convert?: Conversions;
  /** A View tool: its operation path and paged boundary. */
  readonly path?: string;
  readonly page?: (db: Database, caller: Caller, input: never, paging: Paging) => Promise<unknown>;
  readonly run?: (db: Database, caller: Caller, input: never, handlers: Handlers, call: ToolCall) => Promise<unknown>;
  // Application seam: applications depend on this. Do not remove or narrow it because Core has no internal use (CONTRIBUTING.md, "Application seams").
  /**
   * Merged into this tool's `_meta` in `tools/list` (top level shallow, `ui` one level deep) with what its App links produce;
   * a contradicting value fails at `mcp(...)`. `ui.visibility: ["app"]` hides the tool from the `tools/list` of
   * clients that declare no MCP Apps support (a stateless 2025-era request that declares nothing still lists it); a
   * `tools/call` that names it still runs it. It is a listing hint and grants or removes no
   * execution authority.
   */
  readonly meta?: Readonly<Record<string, unknown>>;
}

// Application seam: applications depend on this. Do not remove or narrow it because Core has no internal use (CONTRIBUTING.md, "Application seams").
export {
  withResult,
  withResultMeta,
  resultData,
  type ResultWith,
  type ResultWithMeta,
  type McpContentBlock,
} from "./result-meta.js";
// Application seam: applications depend on this. Do not remove or narrow it because Core has no internal use (CONTRIBUTING.md, "Application seams").
/** What a `tools/call` tells a tool beside its input. */
export interface ToolCall {
  /** The request declared MCP Apps support, so an App renders the result and reads its `_meta`; a secret for the App belongs there, not in the data a model reads. */
  readonly apps: boolean;
  /** The tool links an MCP App resource, independent of this request's declared support. */
  readonly linkedApp?: boolean;
  /**
   * Aborts while the tool runs if the client closes the `tools/call` request before its result (how a client cancels) or
   * the connection drops; never after the call finished. It follows the incoming `Request.signal`: Bun.serve aborts it;
   * Workers abort it from compatibility date 2026-11-17, or with the `enable_request_signal` flag, and before that only
   * while the call streams its result (a call that sent progress). On Workers the invocation ends at the disconnect, so
   * nothing after the tool's next `await` runs: pass the signal to `fetch()` and other cancellable APIs, and stop work
   * kept alive with `waitUntil` when it aborts. The call is recorded as cancelled (`REQUEST_CANCELLED`) when the signal
   * aborts, and its result is not delivered; a tool that ignores the signal may still complete its writes afterwards,
   * where the runtime keeps running it. A 2025-era `notifications/cancelled` arrives as its own request, which a
   * stateless server cannot relate to this one: on that era the signal aborts only when the client closes the request.
   * Set on every MCP call; `callTool` passes the one it is given.
   */
  readonly signal?: AbortSignal;
  /**
   * Sends `notifications/progress` on this request's stream; present only when the client asked with a `progressToken`.
   * `progress` should increase on each call; a notification the client can no longer receive is dropped.
   */
  readonly progress?: (progress: number, total?: number, message?: string) => Promise<void>;
}

/** Request-bound tool tables keep native environment bindings outside the cached App catalogue. */
export type Tools<Env, Database, Handlers = never> =
  | readonly Tool<Database, Handlers>[]
  | ((
      request: Request,
      env: Env,
    ) => readonly Tool<Database, Handlers>[] | Promise<readonly Tool<Database, Handlers>[]>);

/** The selected MCP routes; all request work loads only when an MCP request arrives. */
export function mcp<Env, Database, Handlers = never>(
  tools: Tools<Env, Database, Handlers>,
  options: Options<Env, Database> &
    Pick<import("./request-pipeline.js").PipelineOptions, "fields"> & { handlers?: Handlers },
  reads: readonly { readonly name: string; readonly surface: string }[] = [],
): (request: Request, env: Env, ctx?: RequestContext) => Promise<Response | undefined> {
  let serve: ReturnType<typeof import("./mcp-handler.js").handler<Env, Database, Handlers>> | undefined;
  // Check known static App configuration now; factories wait for the request caller gate.
  const linked: Partial<Record<string, ReturnType<typeof linkSurface>>> = {};
  const apps: Partial<Record<"public" | "admin", McpAppsSource | readonly McpAppsSource[]>> = {};
  for (const surface of ["public", "admin"] as const) {
    const declared = options.apps?.[surface];
    if (declared) {
      // Read each static contributor's resources getter once, including mixed arrays.
      const sources = ((Array.isArray(declared) ? declared : [declared]) as readonly McpAppsSource[]).map(source =>
        typeof source === "function" ? source : resourcesOf(source),
      );
      const fixed = resourcesOf(sources.filter(source => typeof source !== "function"));
      const dynamic = sources.some(source => typeof source === "function");
      apps[surface] = dynamic ? sources : fixed;
      // Known static conflicts still fail before any request or dynamic factory runs.
      if (typeof tools === "function") linkApps(fixed);
      else {
        const current = linkSurface(
          fixed,
          tools.filter(tool => tool.surface === surface),
        );
        if (!dynamic) linked[surface] = current;
      }
    }
  }
  options = { ...options, apps, allowedOrigins: originHostnames(options.allowedOrigins) };
  return async (request, env, ctx) => {
    if (!/^\/mcp(?:\/admin)?\/*$/.test(new URL(request.url).pathname)) return;
    const { handler } = await import("./mcp-handler.js");
    serve ??= handler(tools, options, linked, reads);
    return serve(request, env, ctx);
  };
}

/** `allowedOrigins` as the hostnames the official SDK compares; a bad entry fails here, not on each request. */
function originHostnames(origins: readonly string[] = []): readonly string[] {
  return Object.freeze(
    origins.map(origin => {
      let url: URL | undefined;
      try {
        url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(origin) ? origin : `http://${origin}`);
      } catch {}
      if (
        origin.includes("*") ||
        !url?.hostname ||
        url.username ||
        url.password ||
        url.pathname !== "/" ||
        url.search ||
        url.hash
      )
        throw new TypeError(
          `mcp allowedOrigins: "${origin}" is not an origin (https://host[:port]) or a host[:port]; wildcards never match.`,
        );
      return url.hostname;
    }),
  );
}
