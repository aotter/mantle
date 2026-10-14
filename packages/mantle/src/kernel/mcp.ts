/** MCP request handling for a generated tool table; the official SDK loads on the first MCP request. */
import type { Caller, Target, Authorize, Gateway, RequestContext } from "./contracts.js";
import type { Conversions } from "./surface.js";
import { linkApps, linkSurface, resourcesOf } from "./mcp-apps.js";
export { callTool, callToolLazy } from "./mcp-call.js";
export type { McpApps, McpAppResource } from "./mcp-apps.js";

/** Options of a generated `mcp(...)`; it adds required `handlers` when the app declares ref Procedures. */
export interface Options<Env, Database> {
  apps?: Readonly<Partial<Record<"public" | "admin", import("./mcp-apps.js").McpApps | readonly import("./mcp-apps.js").McpApps[]>>>;
  authorize?: Authorize;
  gateway?: Gateway;
  fields?: import("./user-fields.js").UserFields;
  db: (env: Env) => Database;
  caller?: (request: Request, env: Env, authority: { readonly readOnly: boolean }) => Caller | Promise<Caller>;
  locale?: string;
  instructions?: string;
  serverInfo?: { name?: string; title?: string; version?: string; icons?: { src: string; mimeType?: string; sizes?: string[]; theme?: "light" | "dark" }[] };
  requiredScopes?: readonly string[];
  resourceMetadata?: string;
  onObservation?: (event: McpObservation) => void | Promise<void>;
  onRefusal?: (event: CallerRefusal) => void | Promise<void>;
}
export interface CallerRefusal { readonly at: number; readonly status: 401 | 403; readonly reason: "origin" | "credential"; }
export type McpObservation =
  | { readonly kind: "request-refused"; readonly at: number; readonly surface: "public" | "admin"; readonly status: 401 | 403 }
  | { readonly kind: "invocation"; readonly at: number; readonly surface: "public" | "admin"; readonly invocationId: string; readonly tool: string; readonly caller: Caller } & (
    | { readonly phase: "attempt" }
    | { readonly phase: "completion"; readonly outcome: "succeeded" | "failed" | "denied"; readonly durationMs: number; readonly code?: string }
  );
type LocalizedText = string | Readonly<Record<string, string>>;
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
  readonly annotations?: { readonly readOnlyHint?: boolean; readonly destructiveHint?: boolean; readonly openWorldHint?: boolean; readonly idempotentHint?: boolean };
  readonly inputSchema: unknown;
  /** Declares an auth requirement: anonymous callers are challenged. */
  readonly closed?: boolean;
  /** OAuth scopes the requirement names. */
  readonly scopes?: readonly string[];
  readonly validate: (raw: unknown) => Record<string, unknown> | Promise<Record<string, unknown>>;
  readonly convert?: Conversions;
  /** A View tool: its operation path and paged boundary. */
  readonly path?: string;
  readonly page?: (db: Database, caller: Caller, input: never, paging: Paging) => Promise<unknown>;
  readonly run?: (db: Database, caller: Caller, input: never, handlers: Handlers) => Promise<unknown>;
}

/** Request-bound tool tables keep native environment bindings outside the cached App catalogue. */
export type Tools<Env, Database, Handlers = never> = readonly Tool<Database, Handlers>[] | ((request: Request, env: Env) => readonly Tool<Database, Handlers>[] | Promise<readonly Tool<Database, Handlers>[]>);

/** The selected MCP routes; all request work loads only when an MCP request arrives. */
export function mcp<Env, Database, Handlers = never>(tools: Tools<Env, Database, Handlers>, options: Options<Env, Database> & { handlers?: Handlers }, reads: readonly { readonly name: string; readonly surface: string }[] = []): (request: Request, env: Env, ctx?: RequestContext) => Promise<Response | undefined> {
  let serve: ReturnType<typeof import("./mcp-handler.js").handler<Env, Database, Handlers>> | undefined;
  // a bad App configuration fails here, not on the first request
  const linked: Partial<Record<string, ReturnType<typeof linkSurface>>> = {};
  const apps: Partial<Record<"public" | "admin", ReturnType<typeof resourcesOf>>> = {};
  for (const surface of ["public", "admin"] as const) {
    const declared = options.apps?.[surface];
    if (declared) {
      const app = resourcesOf(declared);
      apps[surface] = app;
      typeof tools === "function" ? linkApps(app) : linked[surface] = linkSurface(app, tools.filter(tool => tool.surface === surface));
    }
  }
  options = { ...options, apps };
  return async (request, env, ctx) => {
    if (!/^\/mcp(?:\/admin)?\/*$/.test(new URL(request.url).pathname)) return;
    const { handler } = await import("./mcp-handler.js");
    serve ??= handler(tools, options, linked, reads);
    return serve(request, env, ctx);
  };
}
