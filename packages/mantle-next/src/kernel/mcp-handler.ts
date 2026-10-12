/** Request-only MCP implementation, excluded from Worker startup. */
import { ContractError, checkOrigin, surfaceCaller, surfaceError, surfaceFailure, wire, type Caller } from "./contracts.js";
import { callTool } from "./mcp-call.js";
import { clientUiSupport, appMeta, appHtml, RESOURCE_MIME_TYPE } from "./mcp-apps.js";
import type { AppLinks } from "./mcp-app-links.js";
import type { Tool, Options } from "./mcp.js";
type LocalizedText = string | Readonly<Record<string, string>>;
const text = (value: LocalizedText | undefined, locale: string): string | undefined => {
  if (typeof value === "string") return value;
  if (!value) return;
  return Object.hasOwn(value, locale) ? value[locale] : Object.hasOwn(value, "en") ? value.en : Object.values(value)[0];
};
function observe<T>(listener: ((event: T) => void | Promise<void>) | undefined, event: T): void {
  if (listener) try { void Promise.resolve(listener(event)).catch(() => {}); } catch {}
}
const paging = (schema: { properties?: object }) => ({ ...schema, properties: { ...schema.properties, limit: { type: "integer", minimum: 1, maximum: 500 }, cursor: { type: "string" } } });
/** The scopes a challenge asks for: the credential's, plus what the request needs. */
const union = (scopes: readonly string[], extra: readonly string[]) => [...new Set([...scopes, ...extra])].join(" ");

/** The handler for `/mcp` (public tools) and `/mcp/staff` (tools for `staff` roles); other paths are undefined. */
export async function serve<Env, Database, Handlers>(tools: readonly Tool<Database, Handlers>[], staff: readonly string[], options: Options<Env, Database> & { handlers?: Handlers }, request: Request, env: Env, apps: Readonly<Record<string, AppLinks>>): Promise<Response | undefined> {
  const requiredScopes = options.requiredScopes ?? ["mcp"], locale = options.locale ?? "en";
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
    const linked = apps[surface]!, withApps = clientUiSupport(parsedBody) !== "unsupported" && linked.resources.length > 0;
    const visible = selected.filter(tool => !(linked.appOnly.has(tool.name) && !withApps));
    const handler = createMcpHandler(() => {
      const schema = (value: unknown) => fromJsonSchema(value as Parameters<typeof fromJsonSchema>[0], { getValidator<T>(): import("@modelcontextprotocol/server").JsonSchemaValidator<T> { return (input: unknown) => ({ valid: true, data: input as T, errorMessage: undefined }); } });
      const server = new McpServer({ name: "aotter.mantle", version: "0.2.0", ...options.serverInfo }, { capabilities: { tools: { listChanged: false } }, ...(options.instructions ? { instructions: options.instructions } : {}) });
      if (withApps) for (const resource of linked.resources) {
        const meta = appMeta(resource);
        server.registerResource(resource.name, resource.uri, { mimeType: RESOURCE_MIME_TYPE, ...(resource.title ? { title: resource.title } : {}), ...(resource.description ? { description: resource.description } : {}), ...(meta ? { _meta: meta } : {}) }, async () => {
          try { return { contents: [{ uri: resource.uri, mimeType: RESOURCE_MIME_TYPE, text: await appHtml(resource), ...(meta ? { _meta: meta } : {}) }] }; }
          catch { console.error("[mantle mcp] resource rendering failed"); throw new Error("Internal error."); }
        });
      }
      for (const tool of visible) {
        const uri = withApps ? linked.appOnly.get(tool.name) ?? linked.rendersIn.get(tool.name) : undefined;
        const appOnly = linked.appOnly.has(tool.name);
        const resultMeta = withApps && linked.rendersIn.has(tool.name) ? { _meta: { "net.aotter.mantle/tool": tool.name } } : {};
        const meta = uri ? { ui: { resourceUri: uri, ...(appOnly ? { visibility: ["app"] } : {}) }, "ui/resourceUri": uri, ...(appOnly ? {} : { "openai/outputTemplate": uri }) } : undefined;
        server.registerTool(tool.name, { ...(meta ? { _meta: meta } : {}), ...(tool.title ? { title: text(tool.title, locale) } : {}), description: text(tool.description, locale) ?? text(tool.title, locale) ?? tool.name, inputSchema: schema(tool.page ? paging(tool.inputSchema as object) : tool.inputSchema), ...(tool.outputSchema ? { outputSchema: schema(tool.outputSchema) } : {}), ...(tool.annotations ? { annotations: tool.annotations } : {}) }, async (raw: unknown) => {
        const metadata = options.onObservation ? { kind: "invocation" as const, surface, invocationId: crypto.randomUUID(), tool: tool.name, caller: Object.freeze(caller.kind === "user" ? { ...caller, scopes: Object.freeze([...caller.scopes]) } : { ...caller }) } : undefined;
        const started = metadata ? performance.now() : 0;
        if (metadata) observe(options.onObservation, { ...metadata, phase: "attempt", at: Date.now() });
        let outcome: "succeeded" | "failed" | "denied" = "succeeded", code: string | undefined;
        try {
          if (tool.run) checkOrigin(request, caller);
          const data = await callTool(tool, raw as Record<string, unknown>, options.db(env), caller, options.handlers as Handlers);
          return { ...resultMeta, content: [{ type: "text" as const, text: JSON.stringify(data) }], ...(data && typeof data === "object" && !Array.isArray(data) ? { structuredContent: data as Record<string, unknown> } : {}) };
        } catch (error) {
          const diagnostic = surfaceError(error).error;
          code = diagnostic.code; outcome = code === "AUTH_DENIED" || code === "UNAUTHENTICATED" ? "denied" : "failed";
          if (diagnostic.path === "request:origin") observe(options.onRefusal, { at: Date.now(), status: 403, reason: "origin" });
          const payload = { diagnostics: [diagnostic] };
          return { ...resultMeta, isError: true, content: [{ type: "text" as const, text: JSON.stringify(payload) }], ...(tool.outputSchema ? {} : { structuredContent: payload }) };
        } finally {
          if (metadata) observe(options.onObservation, { ...metadata, phase: "completion", at: Date.now(), outcome, durationMs: Math.max(0, performance.now() - started), ...(code ? { code } : {}) });
        }
      });
      }
      return server;
    }, { legacy: "stateless", maxRequestBodySize: 1024 * 1024 });
    return handler.fetch(request, { parsedBody });
}
