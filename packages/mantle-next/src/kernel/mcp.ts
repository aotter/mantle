/** MCP request handling for a generated tool table; the official SDK loads on the first MCP request. */
import { ContractError, checkOrigin, surfaceCaller, surfaceError, surfaceFailure, wire, type Caller } from "./contracts.js";
import { convert, invalid, type Conversions } from "./surface.js";

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
const text = (value: LocalizedText | undefined, locale: string): string | undefined => typeof value === "string" ? value : value?.[locale] ?? value?.en ?? Object.values(value ?? {})[0];
function observe<T>(listener: ((event: T) => void | Promise<void>) | undefined, event: T): void {
  if (listener) try { void Promise.resolve(listener(event)).catch(() => {}); } catch {}
}
type Paging = { limit?: number; cursor?: string };
const paging = (schema: { properties?: object }) => ({ ...schema, properties: { ...schema.properties, limit: { type: "integer", minimum: 1, maximum: 500 }, cursor: { type: "string" } } });
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

async function call<Database, Handlers>(tool: Tool<Database, Handlers>, raw: Record<string, unknown>, db: Database, caller: Caller, handlers: Handlers): Promise<unknown> {
  if (tool.page) {
    const { limit, cursor, ...input } = raw;
    if (limit !== undefined && (!Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 500) || cursor !== undefined && typeof cursor !== "string") invalid("Invalid paging options.", tool.path!);
    tool.validate(input);
    convert(input, tool.convert);
    return tool.page(db, caller, input as never, { limit: limit as number | undefined, cursor: cursor as string | undefined });
  }
  const input = tool.validate(raw);
  convert(input, tool.convert);
  return tool.run!(db, caller, input as never, handlers);
}

/** The scopes a challenge asks for: the credential's, plus what the request needs. */
const union = (scopes: readonly string[], extra: readonly string[]) => [...new Set([...scopes, ...extra])].join(" ");

/** The handler for `/mcp` (public tools) and `/mcp/staff` (tools for `staff` roles); other paths are undefined. */
export function mcp<Env, Database, Handlers = never>(tools: readonly Tool<Database, Handlers>[], staff: readonly string[], options: Options<Env, Database> & { handlers?: Handlers }): (request: Request, env: Env) => Promise<Response | undefined> {
  const requiredScopes = options.requiredScopes ?? ["mcp"], locale = options.locale ?? "en";
  return async (request, env) => {
    const url = new URL(request.url), path = url.pathname.replace(/\/+$/, ""), surface = path === "/mcp" ? "public" as const : path === "/mcp/staff" ? "staff" as const : undefined;
    if (!surface) return;
    const selected = tools.filter(tool => tool.surface === surface);
    const challenge = (error: unknown, scope?: string, bare = false) => {
      const result = wire(error);
      if (result.status === 401 || result.status === 403) {
        observe(options.onObservation, { kind: "request-refused", at: Date.now(), surface, status: result.status });
        observe(options.onRefusal, { at: Date.now(), status: result.status, reason: "credential" });
      }
      if (result.status === 401) scope ??= requiredScopes.join(" ");
      return surfaceFailure(error, bare ? undefined : 'Bearer ' + (scope ? (result.status === 403 ? 'error="insufficient_scope", ' : '') + 'scope="' + scope + '", ' : '') + 'resource_metadata="' + (options.resourceMetadata ?? url.origin + '/.well-known/oauth-protected-resource/mcp') + '"');
    };
    let caller: Caller;
    try {
      caller = await surfaceCaller(request, env, options.caller);
      if (caller.kind === "anonymous" && (surface === "staff" || selected.length > 0 && selected.every(tool => tool.closed))) throw new ContractError("UNAUTHENTICATED", "Authentication is required.", "mcp");
      if (caller.kind === "system") return challenge(new ContractError("AUTH_DENIED", "System callers cannot use MCP.", "mcp"), undefined, true);
      if (surface === "staff" && caller.kind === "user" && !staff.includes(caller.role ?? "")) return challenge(new ContractError("AUTH_DENIED", "Staff role is required.", "mcp/staff"), undefined, true);
      if (caller.kind === "user" && caller.credential !== "session" && requiredScopes.some(scope => !(caller as Extract<Caller, {kind: "user"}>).scopes.includes(scope))) return challenge(new ContractError("AUTH_DENIED", "The credential needs the required MCP scopes.", "mcp"), union(caller.scopes, requiredScopes));
    } catch (error) { return challenge(error); }
    const { McpServer, createMcpHandler, fromJsonSchema, readRequestBody } = await import("@modelcontextprotocol/server");
    let parsedBody: unknown;
    if (request.method === "POST") {
      try { const body = await readRequestBody(request.clone() as Parameters<typeof readRequestBody>[0], 1024 * 1024); if (body.tooLarge) return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "Request body exceeds 1048576 bytes." } }, { status: 413 }); parsedBody = JSON.parse(body.text); } catch {}
      for (const message of Array.isArray(parsedBody) ? parsedBody : [parsedBody]) {
        if (!message || message.method !== "tools/call") continue;
        const tool = selected.find(tool => tool.name === message.params?.name);
        if (!tool) continue;
        const scopes = tool.scopes ?? [];
        if (caller.kind === "anonymous" && tool.closed) return challenge(new ContractError("UNAUTHENTICATED", "Authentication is required.", "mcp"), union(requiredScopes, scopes));
        if (caller.kind === "user" && caller.credential === "oauth" && scopes.some(scope => !caller.scopes.includes(scope))) return challenge(new ContractError("AUTH_DENIED", "The credential needs additional scopes.", "mcp"), union(caller.scopes, scopes));
      }
    }
    const handler = createMcpHandler(() => {
      const schema = (value: unknown) => fromJsonSchema(value as Parameters<typeof fromJsonSchema>[0], { getValidator<T>(): import("@modelcontextprotocol/server").JsonSchemaValidator<T> { return (input: unknown) => ({ valid: true, data: input as T, errorMessage: undefined }); } });
      const server = new McpServer({ name: "aotter.mantle", version: "0.2.0", ...options.serverInfo }, { capabilities: { tools: { listChanged: false } }, ...(options.instructions ? { instructions: options.instructions } : {}) });
      for (const tool of selected) server.registerTool(tool.name, { ...(tool.title ? { title: text(tool.title, locale) } : {}), description: text(tool.description, locale) ?? text(tool.title, locale) ?? tool.name, inputSchema: schema(tool.page ? paging(tool.inputSchema as object) : tool.inputSchema), ...(tool.outputSchema ? { outputSchema: schema(tool.outputSchema) } : {}), ...(tool.annotations ? { annotations: tool.annotations } : {}) }, async (raw: unknown) => {
        const metadata = options.onObservation ? { kind: "invocation" as const, surface, invocationId: crypto.randomUUID(), tool: tool.name, caller: Object.freeze(caller.kind === "user" ? { ...caller, scopes: Object.freeze([...caller.scopes]) } : { ...caller }) } : undefined;
        const started = metadata ? performance.now() : 0;
        if (metadata) observe(options.onObservation, { ...metadata, phase: "attempt", at: Date.now() });
        let outcome: "succeeded" | "failed" | "denied" = "succeeded", code: string | undefined;
        try {
          if (tool.run) checkOrigin(request, caller);
          const data = await call(tool, raw as Record<string, unknown>, options.db(env), caller, options.handlers as Handlers);
          return { content: [{ type: "text" as const, text: JSON.stringify(data) }], ...(data && typeof data === "object" && !Array.isArray(data) ? { structuredContent: data as Record<string, unknown> } : {}) };
        } catch (error) {
          const diagnostic = surfaceError(error).error;
          code = diagnostic.code; outcome = code === "AUTH_DENIED" || code === "UNAUTHENTICATED" ? "denied" : "failed";
          if (diagnostic.path === "request:origin") observe(options.onRefusal, { at: Date.now(), status: 403, reason: "origin" });
          const payload = { diagnostics: [diagnostic] };
          return { isError: true, content: [{ type: "text" as const, text: JSON.stringify(payload) }], ...(tool.outputSchema ? {} : { structuredContent: payload }) };
        } finally {
          if (metadata) observe(options.onObservation, { ...metadata, phase: "completion", at: Date.now(), outcome, durationMs: Math.max(0, performance.now() - started), ...(code ? { code } : {}) });
        }
      });
      return server;
    }, { legacy: "stateless", maxRequestBodySize: 1024 * 1024 });
    return handler.fetch(request, { parsedBody });
  };
}
