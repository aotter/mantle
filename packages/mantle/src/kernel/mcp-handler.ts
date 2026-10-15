/** Request-only MCP implementation, excluded from Worker startup. */
import { authorized, authorizeTarget } from "./authorization.js";
import { forwarded, isAdmin, ContractError, checkOrigin, surfaceCaller, surfaceError, wire, type Caller, type RequestContext } from "./contracts.js";
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

/** The handler for `/mcp` (public tools) and `/mcp/admin` (tools for `admin` roles); other paths are undefined. */
export function handler<Env, Database, Handlers>(tools: Tools<Env, Database, Handlers>, options: Options<Env, Database> & { handlers?: Handlers }, apps: Partial<Record<string, ReturnType<typeof linkSurface>>> = {}, reads: readonly { readonly name: string; readonly surface: string }[] = []): (request: Request, env: Env, ctx?: RequestContext) => Promise<Response | undefined> {
  return async (request, env, ctx) => {
    const access = options.gateway ? (await import("./host-access.js")).accessRequest(ctx, options) : undefined;
    let resolved: Caller | undefined;
    try {
    const requiredScopes = options.requiredScopes ?? ["mcp"], locale = options.locale ?? "en";
    const url = new URL(request.url), path = url.pathname.replace(/\/+$/, ""), surface = path === "/mcp" ? "public" as const : path === "/mcp/admin" ? "admin" as const : undefined;
    if (!surface) return;
    const select = async () => (typeof tools === "function" ? await tools(request, env) : tools).filter(tool => tool.surface === surface);
    // Dynamic admin tables stay behind the admin gate; cache classification uses generated metadata only.
    let selected = surface === "public" ? await select() : [];
    let parsedBody: unknown, tooLarge = false;
    const cookieOnly = request.headers.has("cookie") && !request.headers.has("authorization");
    const parse = async () => {
      if (options.gateway) {
        try { const raw = await (await import("./json-body.js")).bytes(request, 1024 * 1024, () => { tooLarge = true; throw new Error("Body limit"); }); parsedBody = JSON.parse(new TextDecoder().decode(raw)); } catch {}
        return;
      }
      const { readRequestBody } = await import("@modelcontextprotocol/server");
      try { const body = await readRequestBody(request.clone() as Parameters<typeof readRequestBody>[0], 1024 * 1024); tooLarge = body.tooLarge; if (!body.tooLarge) parsedBody = JSON.parse(body.text); } catch {}
    };
    if (request.method === "POST" && (cookieOnly || options.gateway)) await parse();
    const messages = Array.isArray(parsedBody) ? parsedBody : [parsedBody];
    const readOnly = request.method === "POST" && messages.length > 0 && messages.every(message => {
      if (!isRecord(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") return false;
      if (["initialize", "tools/list", "resources/list", "resources/read"].includes(message.method)) return true;
      if (message.method !== "tools/call") return false;
      const name = isRecord(message.params) ? message.params.name : undefined;
      return reads.some(tool => tool.surface === surface && tool.name === name);
    });
    const challenge = async (error: unknown, scope?: string, bare = false) => {
      access?.finish(error);
      const result = wire(error);
      if (result.status === 401 || result.status === 403) {
        observe(options.onObservation, { kind: "request-refused", at: Date.now(), surface, status: result.status });
        observe(options.onRefusal, { at: Date.now(), status: result.status, reason: "credential" });
      }
      if (result.status === 401) scope ??= requiredScopes.join(" ");
      return (await import("./host-caller.js")).hostFailure(error, resolved, `mcp ${path}`, bare ? undefined : 'Bearer ' + (scope ? (result.status === 403 ? 'error="insufficient_scope", ' : '') + 'scope="' + scope + '", ' : '') + 'resource_metadata="' + (options.resourceMetadata ?? url.origin + '/.well-known/oauth-protected-resource/mcp') + '"');
    };
    let caller: Caller;
    try {
      const requested = isRecord(parsedBody) && isRecord(parsedBody.params) ? parsedBody.params.name : undefined;
      const requestedTool = selected.find(t => t.name === requested) ?? (typeof tools === "function" ? undefined : tools.find(t => t.surface === surface && t.name === requested));
      await access?.select(requestedTool?.target ? `${requestedTool.target.kind}:${requestedTool.target.name}` : typeof requested === "string" ? `mcp:${requested}` : "mcp");
      caller = resolved = forwarded(ctx, options.gateway)
        ? (await import("./host-caller.js")).gatewayCaller(ctx, options.gateway, options.fields)
        : await surfaceCaller(request, env, options.caller ?? (() => ({ kind: "anonymous" })), readOnly);
      await access?.select(requestedTool?.target ? `${requestedTool.target.kind}:${requestedTool.target.name}` : "target" in caller && caller.target ? caller.target : "mcp", caller);
      if (caller.kind === "anonymous" && (surface === "admin" || selected.length > 0 && selected.every(tool => tool.closed))) throw new ContractError("UNAUTHENTICATED", "Authentication is required.", "mcp");
      if (caller.kind === "system") return challenge(new ContractError("AUTH_DENIED", "System callers cannot use MCP.", "mcp"), undefined, true);
      if (surface === "admin" && !isAdmin(caller)) return challenge(new ContractError("AUTH_DENIED", "Admin role is required.", "mcp/admin"), undefined, true);
      if (!options.gateway && caller.kind === "user" && caller.credential !== "session" && requiredScopes.some(scope => !(caller as Extract<Caller, {kind: "user"}>).scopes.includes(scope))) return challenge(new ContractError("AUTH_DENIED", "The credential needs the required MCP scopes.", "mcp"), union(caller.scopes, requiredScopes));
    } catch (error) { return challenge(error); }
    if (surface === "admin") selected = await select();
    // Before per-caller filtering, so every caller of a deploy sees one catalogue version.
    const version = catalogueVersion(selected);
    const { McpServer, ProtocolError, ProtocolErrorCode, createMcpHandler, fromJsonSchema } = await import("@modelcontextprotocol/server");
    if (request.method === "POST" && !cookieOnly && !options.gateway) await parse();
    if (tooLarge && access) return challenge(new ContractError("INPUT_VALIDATION_FAILED", "MCP body exceeds its limit.", "mcp"), undefined, true);
    if (tooLarge) return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "Request body exceeds 1048576 bytes." } }, { status: 413 });
    const host = options.gateway && (await import("./host-caller.js")).isHostCaller(caller);
    if (host) {
      try {
        if (Array.isArray(parsedBody)) throw new ContractError("INPUT_VALIDATION_FAILED", "Host calls cannot batch MCP messages.", "mcp");
        if (isRecord(parsedBody) && typeof parsedBody.method === "string" && !["initialize", "tools/call"].includes(parsedBody.method)) throw new ContractError("AUTH_DENIED", "Host callers may only initialize or call a tool.", "mcp", {status: 403});
        if (isRecord(parsedBody) && parsedBody.method === "initialize") {
          const pinned = "target" in caller ? caller.target : undefined;
          if (pinned && !selected.some(tool => (tool.target ? `${tool.target.kind}:${tool.target.name}` : `admin:tool:${tool.name}`) === pinned)) throw new ContractError("TARGET_MISMATCH", "Initialize must pin a mounted tool.", pinned, {status:412});
          await access?.select(pinned ?? "mcp", caller);
          await access?.check(true);
        } else {
          const params = isRecord(parsedBody) && isRecord(parsedBody.params) ? parsedBody.params : undefined;
          const tool = selected.find(t => t.name === params?.name);
          if (tool) {
            await access?.select(tool.target ? `${tool.target.kind}:${tool.target.name}` : `admin:tool:${tool.name}`, caller);
            await access?.check(!!tool.page || tool.readOnly === true);
          }
        }
      } catch (error) { return challenge(error, undefined, true); }
    }
    if (request.method === "POST") {
      for (const message of Array.isArray(parsedBody) ? parsedBody : [parsedBody]) {
        if (!message || message.method !== "tools/call") continue;
        const tool = selected.find(tool => tool.name === message.params?.name);
        if (!tool) continue;
        const scopes = tool.scopes ?? [];
        if (caller.kind === "anonymous" && tool.closed) return challenge(new ContractError("UNAUTHENTICATED", "Authentication is required.", "mcp"), union(requiredScopes, scopes));
        if (!options.gateway && caller.kind === "user" && caller.credential === "oauth" && scopes.some(scope => !caller.scopes.includes(scope))) return challenge(new ContractError("AUTH_DENIED", "The credential needs additional scopes.", "mcp"), union(caller.scopes, scopes));
      }
    }
    const app = options.apps?.[surface];
    const links = app ? (apps[surface] = linkSurface(app, selected, apps[surface])).links : undefined;
    if (options.authorize) {
      try {
        for (const message of Array.isArray(parsedBody) ? parsedBody : [parsedBody]) {
          if (message?.method !== "tools/call") continue;
          const tool = selected.find(tool => tool.name === message.params?.name);
          if (!tool) continue;
          tool.check?.(caller);
          await authorizeTarget(options.authorize, tool.target ?? { kind: tool.page ? "view" : "procedure", name: tool.name }, caller);
        }
        if ((Array.isArray(parsedBody) ? parsedBody : [parsedBody]).some(message => message?.method === "tools/list")) {
          const visible = [];
          for (const tool of selected) {
            if (caller.kind === "anonymous" && tool.closed || !options.gateway && caller.kind === "user" && caller.credential === "oauth" && tool.scopes?.some(scope => !caller.scopes.includes(scope))) continue;
            try { tool.check?.(caller); } catch (error) { if (error instanceof ContractError && ["AUTH_DENIED", "UNAUTHENTICATED"].includes(error.code)) continue; throw error; }
            if (await authorized(options.authorize, tool.target ?? { kind: tool.page ? "view" : "procedure", name: tool.name }, caller)) visible.push(tool);
          }
          selected = visible;
        }
      } catch (error) { return challenge(error); }
    }
    const serverInfo = { name: "aotter.mantle", ...options.serverInfo, version: options.serverInfo?.version ?? version };
    // Host calls execute in the SDK callback, after transport validation.
    const handler = createMcpHandler(() => {
      const schema = (value: unknown) => fromJsonSchema(value as Parameters<typeof fromJsonSchema>[0], { getValidator<T>(): import("@modelcontextprotocol/server").JsonSchemaValidator<T> { return (input: unknown) => ({ valid: true, data: input as T, errorMessage: undefined }); } });
      // Tools capability after construction: given to the constructor, the SDK installs its tools/call handler before the wrap below.
      const server = new McpServer(serverInfo, options.instructions ? { instructions: options.instructions } : {});
      server.server.registerCapabilities({ tools: { listChanged: false } });
      if (host) server.server.onclose = () => access?.finish(isRecord(parsedBody) && parsedBody.method === "initialize" ? undefined : new ContractError("INPUT_VALIDATION_FAILED", "MCP request refused.", "mcp", {status: 400}));
      const appMeta = links ? registerApps(server, links, parsedBody) : undefined;
      // A host's stale copy names a tool this catalogue lacks: say so, with the catalogue version, instead of the SDK's bare "not found".
      // Wrapped where the SDK stores it, so transport and request validation still answer first.
      const registered = new Set<string>(), set = server.server.setRequestHandler.bind(server.server) as (method: string, handler: unknown) => void;
      server.server.setRequestHandler = ((method: string, handler: unknown) => set(method, method === "tools/call" && typeof handler === "function" ? (request: { params: { name: string } }, context: unknown) => {
        if (!registered.has(request.params.name)) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `No tool named ${JSON.stringify(request.params.name)} exists in the current catalogue (catalogue version ${serverInfo.version}).`);
        return handler(request, context);
      } : handler)) as typeof server.server.setRequestHandler;
      for (const tool of selected) {
        const meta = appMeta?.(tool.name);
        if (meta === false) continue;
        registered.add(tool.name);
        // Not part of structured output: the version, and on failure the current input contract.
        const about = (contract: boolean) => { const text = [tool.version && `tool version ${tool.version}`, contract && `input schema ${JSON.stringify(tool.page ? paging(tool.inputSchema as object) : tool.inputSchema)}`].filter(Boolean).join("; "); return text ? [{ type: "text" as const, text }] : []; };
        server.registerTool(tool.name, { ...(meta ? { _meta: meta } : {}), ...(tool.title ? { title: text(tool.title, locale) } : {}), description: text(tool.description, locale) ?? text(tool.title, locale) ?? tool.name, inputSchema: schema(tool.page ? paging(tool.inputSchema as object) : tool.inputSchema), ...(tool.outputSchema ? { outputSchema: schema(tool.outputSchema) } : {}), ...(tool.annotations ? { annotations: tool.annotations } : {}) }, async (raw: unknown) => {
        const metadata = options.onObservation ? { kind: "invocation" as const, surface, invocationId: crypto.randomUUID(), tool: tool.name, caller: Object.freeze(caller.kind === "user" ? { ...caller, scopes: Object.freeze([...caller.scopes]) } : { ...caller }) } : undefined;
        const started = metadata ? performance.now() : 0;
        if (metadata) observe(options.onObservation, { ...metadata, phase: "attempt", at: Date.now() });
        let outcome: "succeeded" | "failed" | "denied" = "succeeded", code: string | undefined;
        try {
          if (host) tool.check?.(caller);
          if (tool.run && (!host || !tool.readOnly)) checkOrigin(request, caller);
          const data = await callTool(tool, raw as Record<string, unknown>, () => options.db(env), caller, options.handlers as Handlers, access?.dryRun ? () => ({dryRun: true, event: access.finish()}) : undefined);
          if (host) access?.finish();
          return { ...(meta ? { _meta: { "net.aotter.mantle/tool": tool.name } } : {}), content: [{ type: "text" as const, text: JSON.stringify(data) }, ...about(false)], ...(data && typeof data === "object" && !Array.isArray(data) ? { structuredContent: data as Record<string, unknown> } : {}) };
        } catch (error) {
          if (host) access?.finish(error);
          const diagnostic = host ? (await (await import("./host-caller.js")).hostFailure(error, caller, `mcp ${tool.name}`).json() as {error: ReturnType<typeof surfaceError>["error"]}).error : surfaceError(error, `mcp ${tool.name}`).error;
          code = diagnostic.code; outcome = code === "AUTH_DENIED" || code === "UNAUTHENTICATED" ? "denied" : "failed";
          if (diagnostic.path === "request:origin") observe(options.onRefusal, { at: Date.now(), status: 403, reason: "origin" });
          const payload = { diagnostics: [diagnostic] };
          return { ...(meta ? { _meta: { "net.aotter.mantle/tool": tool.name } } : {}), isError: true, content: [{ type: "text" as const, text: JSON.stringify(payload) }, ...about(outcome === "failed")], ...(tool.outputSchema ? {} : { structuredContent: payload }) };
        } finally {
          if (metadata) observe(options.onObservation, { ...metadata, phase: "completion", at: Date.now(), outcome, durationMs: Math.max(0, performance.now() - started), ...(code ? { code } : {}) });
        }
      });
      }
      // An empty catalogue still answers tools/list and refuses calls the same way.
      if (registered.size === 0) { server.server.setRequestHandler("tools/list", () => ({ tools: [] })); server.server.setRequestHandler("tools/call", () => ({ content: [] })); }
      return server;
    }, { legacy: "stateless", maxRequestBodySize: 1024 * 1024, onerror: error => console.error("[mantle mcp] request failed", error) });
    const response = await handler.fetch(request, { parsedBody });
    if (host) {
      if (response.status >= 400) access?.finish(new ContractError("INPUT_VALIDATION_FAILED", "MCP request refused.", "mcp", {status: response.status}));
    }
    return response;
    } catch (error) {
      access?.finish(error);
      return (await import("./host-caller.js")).hostFailure(error, resolved, "mcp");
    }
  };
}

/** A hash of the tools an endpoint serves (`surface:name:version`, sorted), as 32-bit FNV-1a hex: it changes with any tool's definition. */
function catalogueVersion(tools: readonly { readonly surface: string; readonly name: string; readonly version?: string }[]): string {
  const text = JSON.stringify(tools.map(tool => `${tool.surface}:${tool.name}:${tool.version ?? ""}`).sort());
  return [...text].reduce((h, c) => Math.imul(h ^ c.codePointAt(0)!, 16777619) >>> 0, 2166136261).toString(16).padStart(8, "0");
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
