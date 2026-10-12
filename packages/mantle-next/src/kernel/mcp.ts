/** MCP request work and the official SDK load only after the app routes an MCP request. */
import type { Caller } from "./contracts.js";
import type { Conversions } from "./surface.js";
import type { McpApps } from "./mcp-apps.js";
import { linkApps } from "./mcp-app-links.js";
/** Options of a generated `mcp(...)`; it adds required `handlers` when the app declares ref Procedures. */
export interface Options<Env, Database> {
  apps?: Readonly<Partial<Record<"public" | "staff", McpApps>>>;
  db: (env: Env) => Database;
  caller: (request: Request, env: Env) => Caller | Promise<Caller>;
}
type Paging = { limit?: number; cursor?: string };
/** One tool: a paged View (`page`) or a Procedure (`run`, a write), on the public or staff surface. */
export interface Tool<Database, Handlers = never> {
  readonly name: string;
  readonly surface: string;
  readonly description: string;
  /** The declared input; a View tool's schema gains the `limit` and `cursor` paging properties. */
  readonly inputSchema: unknown;
  /** Declares an auth requirement: anonymous callers are challenged. */
  readonly closed?: boolean;
  /** OAuth scopes the requirement names. */
  readonly scopes?: readonly string[];
  readonly validate: (raw: unknown) => Record<string, unknown>;
  readonly convert?: Conversions;
  /** A View tool: its operation path and paged boundary. */
  readonly path?: string;
  readonly page?: (db: Database, caller: Caller, input: never, paging: Paging) => Promise<unknown>;
  readonly run?: (db: Database, caller: Caller, input: never, handlers: Handlers) => Promise<unknown>;
}

/** Validate App bindings once; caller, SDK and registration work remain request-time. */
export function mcp<Env, Database, Handlers = never>(tools: readonly Tool<Database, Handlers>[], staff: readonly string[], options: Options<Env, Database> & { handlers?: Handlers }): (request: Request, env: Env) => Promise<Response | undefined> {
  const apps = Object.fromEntries((["public", "staff"] as const).map(surface => {
    const selected = tools.filter(tool => tool.surface === surface);
    return [surface, linkApps(options.apps?.[surface], new Set(selected.map(t => t.name)), new Set(selected.filter(t => t.page).map(t => t.name)))];
  }));
  return async (request, env) => {
    if (!/^\/mcp(?:\/staff)?\/*$/.test(new URL(request.url).pathname)) return;
    return (await import("./mcp-handler.js")).serve(tools, staff, options, request, env, apps);
  };
}
