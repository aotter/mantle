/** Request-only MCP implementation, excluded from Worker startup. */
import { ContractError, checkOrigin, surfaceCaller, surfaceError, surfaceFailure, wire, type Caller } from "./contracts.js";
import { callToolLazy as callTool } from "./mcp-call.js";
import type { Tools, Options } from "./mcp.js";
import { RESOURCE_MIME_TYPE, linkSurface, type McpAppResource } from "./mcp-apps.js";
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
export function handler<Env, Database, Handlers>(tools: Tools<Env, Database, Handlers>, staff: readonly string[], options: Options<Env, Database> & { handlers?: Handlers }, apps: Partial<Record<string, ReturnType<typeof linkSurface>>> = {}, reads: readonly { readonly name: string; readonly surface: string }[] = []): (request: Request, env: Env) => Promise<Response | undefined> {
  return async (request, env) => {
    const requiredScopes = options.requiredScopes ?? ["mcp"], locale = options.locale ?? "en";
    const url = new URL(request.url), path = url.pathname.replace(/\/+$/, ""), surface = path === "/mcp" ? "public" as const : path === "/mcp/staff" ? "staff" as const : undefined;
    if (!surface) return;
    const select = async () => (typeof tools === "function" ? await tools(request, env) : tools).filter(tool => tool.surface === surface);
    // Dynamic staff tables stay behind the staff gate; cache classification uses generated metadata only.
    let selected = surface === "public" ? await select() : [];
    let parsedBody: unknown, tooLarge = false;
    const cookieOnly = request.headers.has("cookie") && !request.headers.has("authorization");
    const parse = async () => {
      const { readRequestBody } = await import("@modelcontextprotocol/server");
      try { const body = await readRequestBody(request.clone() as Parameters<typeof readRequestBody>[0], 1024 * 1024); tooLarge = body.tooLarge; if (!body.tooLarge) parsedBody = JSON.parse(body.text); } catch {}
    };
    if (request.method === "POST" && cookieOnly) await parse();
    const messages = Array.isArray(parsedBody) ? parsedBody : [parsedBody];
    const readOnly = request.method === "POST" && messages.length > 0 && messages.every(message => {
      if (!isRecord(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") return false;
      if (["initialize", "tools/list", "resources/list", "resources/read"].includes(message.method)) return true;
      if (message.method !== "tools/call") return false;
      const name = isRecord(message.params) ? message.params.name : undefined;
      return reads.some(tool => tool.surface === surface && tool.name === name);
    });
    const challenge = (error: unknown, scope?: string, bare = false) => {
      const result = wire(error);
      if (result.status === 401 || result.status === 403) {
        observe(options.onObservation, { kind: "request-refused", at: Date.now(), surface, status: result.status });
        observe(options.onRefusal, { at: Date.now(), status: result.status, reason: "credential" });
      }
      if (result.status === 401) scope ??= requiredScopes.join(" ");
      return surfaceFailure(error, bare ? undefined : 'Bearer ' + (scope ? (result.status === 403 ? 'error="insufficient_scope", ' : '') + 'scope="' + scope + '", ' : '') + 'resource_metadata="' + (options.resourceMetadata ?? url.origin + '/.well-known/oauth-protected-resource/mcp') + '"', `mcp ${path}`);
    };
    let caller: Caller;
    try {
      caller = await surfaceCaller(request, env, options.caller, readOnly);
      if (caller.kind === "anonymous" && (surface === "staff" || selected.length > 0 && selected.every(tool => tool.closed))) throw new ContractError("UNAUTHENTICATED", "Authentication is required.", "mcp");
      if (caller.kind === "system") return challenge(new ContractError("AUTH_DENIED", "System callers cannot use MCP.", "mcp"), undefined, true);
      if (surface === "staff" && caller.kind === "user" && !staff.includes(caller.role ?? "")) return challenge(new ContractError("AUTH_DENIED", "Staff role is required.", "mcp/staff"), undefined, true);
      if (caller.kind === "user" && caller.credential !== "session" && requiredScopes.some(scope => !(caller as Extract<Caller, {kind: "user"}>).scopes.includes(scope))) return challenge(new ContractError("AUTH_DENIED", "The credential needs the required MCP scopes.", "mcp"), union(caller.scopes, requiredScopes));
    } catch (error) { return challenge(error); }
    if (surface === "staff") selected = await select();
    const { McpServer, createMcpHandler, fromJsonSchema } = await import("@modelcontextprotocol/server");
    if (request.method === "POST" && !cookieOnly) await parse();
    if (tooLarge) return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "Request body exceeds 1048576 bytes." } }, { status: 413 });
    if (request.method === "POST") {
      for (const message of Array.isArray(parsedBody) ? parsedBody : [parsedBody]) {
        if (!message || message.method !== "tools/call") continue;
        const tool = selected.find(tool => tool.name === message.params?.name);
        if (!tool) continue;
        const scopes = tool.scopes ?? [];
        if (caller.kind === "anonymous" && tool.closed) return challenge(new ContractError("UNAUTHENTICATED", "Authentication is required.", "mcp"), union(requiredScopes, scopes));
        if (caller.kind === "user" && caller.credential === "oauth" && scopes.some(scope => !caller.scopes.includes(scope))) return challenge(new ContractError("AUTH_DENIED", "The credential needs additional scopes.", "mcp"), union(caller.scopes, scopes));
      }
    }
    const app = options.apps?.[surface];
    const links = app ? (apps[surface] = linkSurface(app, selected, apps[surface])).links : undefined;
    const handler = createMcpHandler(() => {
      const schema = (value: unknown) => fromJsonSchema(value as Parameters<typeof fromJsonSchema>[0], { getValidator<T>(): import("@modelcontextprotocol/server").JsonSchemaValidator<T> { return (input: unknown) => ({ valid: true, data: input as T, errorMessage: undefined }); } });
      const server = new McpServer({ name: "aotter.mantle", version: "0.2.0", ...options.serverInfo }, { capabilities: { tools: { listChanged: false } }, ...(options.instructions ? { instructions: options.instructions } : {}) });
      const appMeta = links ? registerApps(server, links, parsedBody) : undefined;
      for (const tool of selected) {
        const meta = appMeta?.(tool.name);
        if (meta === false) continue;
        server.registerTool(tool.name, { ...(meta ? { _meta: meta } : {}), ...(tool.title ? { title: text(tool.title, locale) } : {}), description: text(tool.description, locale) ?? text(tool.title, locale) ?? tool.name, inputSchema: schema(tool.page ? paging(tool.inputSchema as object) : tool.inputSchema), ...(tool.outputSchema ? { outputSchema: schema(tool.outputSchema) } : {}), ...(tool.annotations ? { annotations: tool.annotations } : {}) }, async (raw: unknown) => {
        const metadata = options.onObservation ? { kind: "invocation" as const, surface, invocationId: crypto.randomUUID(), tool: tool.name, caller: Object.freeze(caller.kind === "user" ? { ...caller, scopes: Object.freeze([...caller.scopes]) } : { ...caller }) } : undefined;
        const started = metadata ? performance.now() : 0;
        if (metadata) observe(options.onObservation, { ...metadata, phase: "attempt", at: Date.now() });
        let outcome: "succeeded" | "failed" | "denied" = "succeeded", code: string | undefined;
        try {
          if (tool.run) checkOrigin(request, caller);
          const data = await callTool(tool, raw as Record<string, unknown>, () => options.db(env), caller, options.handlers as Handlers);
          return { ...(meta ? { _meta: { "net.aotter.mantle/tool": tool.name } } : {}), content: [{ type: "text" as const, text: JSON.stringify(data) }], ...(data && typeof data === "object" && !Array.isArray(data) ? { structuredContent: data as Record<string, unknown> } : {}) };
        } catch (error) {
          const diagnostic = surfaceError(error, `mcp ${tool.name}`).error;
          code = diagnostic.code; outcome = code === "AUTH_DENIED" || code === "UNAUTHENTICATED" ? "denied" : "failed";
          if (diagnostic.path === "request:origin") observe(options.onRefusal, { at: Date.now(), status: 403, reason: "origin" });
          const payload = { diagnostics: [diagnostic] };
          return { ...(meta ? { _meta: { "net.aotter.mantle/tool": tool.name } } : {}), isError: true, content: [{ type: "text" as const, text: JSON.stringify(payload) }], ...(tool.outputSchema ? {} : { structuredContent: payload }) };
        } finally {
          if (metadata) observe(options.onObservation, { ...metadata, phase: "completion", at: Date.now(), outcome, durationMs: Math.max(0, performance.now() - started), ...(code ? { code } : {}) });
        }
      });
      }
      return server;
    }, { legacy: "stateless", maxRequestBodySize: 1024 * 1024, onerror: error => console.error("[mantle mcp] request failed", error) });
    return handler.fetch(request, { parsedBody });
  };
}

const CLIENT_CAPABILITIES_META_KEY = "io.modelcontextprotocol/clientCapabilities";
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** `unknown`: a stateless request after `initialize` carries no capabilities, so only an explicit refusal hides Apps. */
function clientUiSupport(message: unknown): "supported" | "unsupported" | "unknown" {
  for (const m of Array.isArray(message) ? message : [message]) {
    if (!isRecord(m) || !isRecord(m.params)) continue;
    const meta = m.params._meta;
    const declared = isRecord(meta) && isRecord(meta[CLIENT_CAPABILITIES_META_KEY]) ? meta[CLIENT_CAPABILITIES_META_KEY] : m.method === "initialize" && isRecord(m.params.capabilities) ? m.params.capabilities : undefined;
    if (!declared) continue;
    const extensions = declared.extensions, ui = isRecord(extensions) ? extensions["io.modelcontextprotocol/ui"] : undefined;
    return isRecord(ui) && Array.isArray(ui.mimeTypes) && ui.mimeTypes.includes(RESOURCE_MIME_TYPE) ? "supported" : "unsupported";
  }
  return "unknown";
}

function appMeta(r: McpAppResource): { ui: Record<string, unknown> } | undefined {
  const ui = { ...(r.csp ? { csp: r.csp } : {}), ...(r.permissions ? { permissions: r.permissions } : {}), ...(r.prefersBorder !== undefined ? { prefersBorder: r.prefersBorder } : {}) };
  return Object.keys(ui).length > 0 ? { ui } : undefined;
}

/** Registration uses the official SDK; HTML loaders run only on resources/read. */
function registerApps(server: import("@modelcontextprotocol/server").McpServer, links: ReturnType<typeof linkSurface>["links"], message: unknown) {
  const enabled = clientUiSupport(message) !== "unsupported";
  if (enabled) for (const resource of links.resources) {
    const meta = appMeta(resource);
    server.registerResource(resource.name, resource.uri, { mimeType: RESOURCE_MIME_TYPE, title: resource.title, description: resource.description, ...(meta ? { _meta: meta } : {}) }, async () => {
      try { return { contents: [{ uri: resource.uri, mimeType: RESOURCE_MIME_TYPE, text: typeof resource.html === "string" ? resource.html : await resource.html(), ...(meta ? { _meta: meta } : {}) }] }; }
      catch { console.error("[mantle mcp] resource rendering failed"); throw new Error("Internal error."); }
    });
  }
  return (tool: string) => {
    if (!enabled) return links.appOnly.has(tool) ? false : undefined;
    const uri = links.renders.get(tool);
    return uri ? { ui: { resourceUri: uri, ...(links.appOnly.has(tool) ? { visibility: ["app"] } : {}) }, "ui/resourceUri": uri, ...(links.appOnly.has(tool) ? {} : { "openai/outputTemplate": uri }) } : undefined;
  };
}
