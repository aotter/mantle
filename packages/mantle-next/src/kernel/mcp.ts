/** MCP request handling for a generated tool table; the official SDK loads on the first MCP request. */
import type { Caller } from "./contracts.js";
import type { Conversions } from "./surface.js";

/** Options of a generated `mcp(...)`; it adds required `handlers` when the app declares ref Procedures. */
export interface Options<Env, Database> {
  db: (env: Env) => Database;
  caller: (request: Request, env: Env) => Caller | Promise<Caller>;
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
  | { readonly kind: "request-refused"; readonly at: number; readonly surface: "public" | "staff"; readonly status: 401 | 403 }
  | { readonly kind: "invocation"; readonly at: number; readonly surface: "public" | "staff"; readonly invocationId: string; readonly tool: string; readonly caller: Caller } & (
    | { readonly phase: "attempt" }
    | { readonly phase: "completion"; readonly outcome: "succeeded" | "failed" | "denied"; readonly durationMs: number; readonly code?: string }
  );
type LocalizedText = string | Readonly<Record<string, string>>;
type Paging = { limit?: number; cursor?: string };
/** One tool: a paged View (`page`) or a Procedure (`run`, a write), on the public or staff surface. */
export interface Tool<Database, Handlers = never> {
  readonly name: string;
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
  readonly validate: (raw: unknown) => Record<string, unknown>;
  readonly convert?: Conversions;
  /** A View tool: its operation path and paged boundary. */
  readonly path?: string;
  readonly page?: (db: Database, caller: Caller, input: never, paging: Paging) => Promise<unknown>;
  readonly run?: (db: Database, caller: Caller, input: never, handlers: Handlers) => Promise<unknown>;
}

/** The selected MCP routes; all request work loads only when an MCP request arrives. */
export function mcp<Env, Database, Handlers = never>(tools: readonly Tool<Database, Handlers>[], staff: readonly string[], options: Options<Env, Database> & { handlers?: Handlers }): (request: Request, env: Env) => Promise<Response | undefined> {
  return async (request, env) => {
    if (!/^\/mcp(?:\/staff)?\/*$/.test(new URL(request.url).pathname)) return;
    return (await import("./mcp-handler.js")).serve(tools, staff, options, request, env);
  };
}
