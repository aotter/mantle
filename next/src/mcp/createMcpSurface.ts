/**
 * The MCP surface (ADR-0032 decision 9): a Fetch function over the runtime. Tools come only from Procedures (through an `mcp`
 * Trigger) and Views, never from a Schema. A Procedure's tool is `invokeProcedure`; a View's tool is `store.as(caller).view`, so both
 * run the same auth, guard and validation as every other source.
 */
import { McpServer, createMcpHandler, fromJsonSchema, isJsonContentType, readRequestBody, type AuthInfo, type CallToolResult, type JsonSchemaType, type JsonSchemaValidator, type StandardSchemaWithJSON, type jsonSchemaValidator } from "@modelcontextprotocol/server";
import { RESOURCE_MIME_TYPE, registerAppResource, registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { DiagnosticError, makeDiagnostic, mcpTools, redactForWire, type AuthPredicate, type AuthorizationRequirements, type Diagnostic, type JsonSchema } from "../spec/index.js";
import { evaluateAuthAll, type Caller, type MantleRuntime, type Surface } from "../core/index.js";
import { appHtml, appMeta, clientUiSupport, linkApps, type ClientUiSupport, type McpApps } from "./apps.js";

export interface McpSurfaceOptions {
  /** Where this surface answers, e.g. `/mcp` or `/mcp/staff`. */
  readonly basePath: string;
  /** Which tools are listed: Triggers and Views of this surface. `staff` also requires a staff role on every request. */
  readonly surface: "public" | "staff";
  /** RFC 9728 metadata URL, carried by every challenge so a client can find the authorization server. */
  readonly resourceMetadata?: string;
  readonly serverInfo?: { readonly name: string; readonly title?: string; readonly version?: string };
  readonly apps?: McpApps;
  /** POST body bound in bytes. Defaults to 1 MiB. */
  readonly maxRequestBodySize?: number;
  /** Language tried first when a description is localized. Defaults to `en`. */
  readonly locale?: string;
}

const CONTEXT_KEY = "mantle.caller";
const UI_KEY = "mantle.clientUi";
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The SDK advertises each schema and accepts the value as given: the runtime validates once, so every source reports the same Diagnostic. */
const PASS_THROUGH: jsonSchemaValidator = { getValidator<T>(): JsonSchemaValidator<T> { return (input) => ({ valid: true, data: input as T, errorMessage: undefined }); } };
const schemaOf = (s: JsonSchema) => fromJsonSchema(s as JsonSchemaType, PASS_THROUGH) as StandardSchemaWithJSON;

const scopesOf = (r: AuthorizationRequirements | undefined) => (r?.auth?.all ?? []).flatMap((p: AuthPredicate) => (typeof p === "object" && "ctx.auth.scope" in p ? [p["ctx.auth.scope"]] : []));

const result = (data: unknown): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(data) }], ...(isRecord(data) ? { structuredContent: data } : {}) });
/** Business failures are results the model can read. With an `outputSchema`, 1.x clients validate `structuredContent` even on `isError`, so the payload rides in the text block only. */
const failure = (d: Diagnostic, hasOutputSchema: boolean): CallToolResult => {
  const payload = { diagnostics: [redactForWire(d)] };
  return { isError: true, content: [{ type: "text", text: JSON.stringify(payload) }], ...(hasOutputSchema ? {} : { structuredContent: payload }) };
};

export function createMcpSurface(runtime: MantleRuntime, options: McpSurfaceOptions): Surface {
  const base = options.basePath.replace(/\/+$/, "") || "/";
  const maxBody = options.maxRequestBodySize ?? 1024 * 1024;
  const tools = mcpTools(runtime.plan, options.surface, options.locale ?? "en");
  const byName = new Map(tools.map((t) => [t.name, t]));
  const apps = linkApps(options.apps, new Set(tools.map((t) => t.name)), new Set(tools.filter((t) => t.kind === "view").map((t) => t.name)));
  const serverInfo = { name: "aotter.mantle", version: "0.2.0", ...options.serverInfo };

  const challenge = (status: 401 | 403, error?: { code?: string; scope?: string }, bare = false) => {
    const parts = [...(error?.code ? [`error="${error.code}"`] : []), ...(error?.scope ? [`scope="${error.scope}"`] : []), ...(options.resourceMetadata ? [`resource_metadata="${options.resourceMetadata}"`] : [])];
    const code = status === 401 ? "UNAUTHENTICATED" : "AUTH_DENIED";
    return Response.json({ error: redactForWire(makeDiagnostic({ code, phase: "runtime", severity: "error", path: "mcp", message: status === 401 ? "Authentication is required." : "The credential does not allow this." })) }, { status, headers: bare ? {} : { "www-authenticate": `Bearer${parts.length ? " " + parts.join(", ") : ""}` } });
  };

  const registers = (name: string, ui: ClientUiSupport) => byName.has(name) && !(apps.appOnly.has(name) && (ui === "unsupported" || apps.resources.length === 0));

  const build = (caller: Caller, ui: ClientUiSupport) => {
    const server = new McpServer(serverInfo, { capabilities: { tools: { listChanged: false } } });
    const withApps = ui !== "unsupported" && apps.resources.length > 0;
    if (withApps) for (const r of apps.resources) {
      const meta = appMeta(r);
      registerAppResource(server, r.name, r.uri, { ...(r.title ? { title: r.title } : {}), ...(r.description ? { description: r.description } : {}), ...(meta ? { _meta: meta } : {}) },
        async () => ({ contents: [{ uri: r.uri, mimeType: RESOURCE_MIME_TYPE, text: await appHtml(r), ...(meta ? { _meta: meta } : {}) }] }));
    }
    for (const tool of tools) {
      if (!registers(tool.name, ui)) continue;
      const run = async (args: unknown): Promise<CallToolResult> => {
        const input = isRecord(args) ? args : {};
        const cause = { kind: "mcp" as const, id: crypto.randomUUID() };
        try {
          if (tool.kind === "procedure") return result(await runtime.invokeProcedure({ procedure: tool.source, input, caller, cause }));
          const { limit, cursor, ...rest } = input;
          return result(await runtime.store.as(caller, cause).view(tool.source, { input: rest, ...(limit !== undefined ? { limit: limit as number } : {}), ...(cursor !== undefined ? { cursor: cursor as string } : {}) }));
        } catch (e) {
          if (e instanceof DiagnosticError) return failure(e.diagnostic, tool.outputSchema !== undefined);
          console.error(`[mantle mcp ${tool.name}] unhandled failure`, e);
          return failure(makeDiagnostic({ code: "INTERNAL_ERROR", phase: "runtime", severity: "error", path: `MCP ${tool.name}`, message: "Internal error." }), tool.outputSchema !== undefined);
        }
      };
      const config = { ...(tool.title ? { title: tool.title } : {}), description: tool.description, inputSchema: schemaOf(tool.inputSchema), ...(tool.outputSchema ? { outputSchema: schemaOf(tool.outputSchema) } : {}), ...(tool.annotations ? { annotations: tool.annotations } : {}) };
      const uri = withApps ? apps.appOnly.get(tool.name) ?? apps.rendersIn.get(tool.name) : undefined;
      if (!uri) { server.registerTool(tool.name, config, run); continue; }
      // writes both the `ui` object and the legacy flat key, so older hosts find the resource too
      registerAppTool(server, tool.name, { ...config, _meta: { ui: { resourceUri: uri, ...(apps.appOnly.has(tool.name) ? { visibility: ["app"] } : {}) } } } as Parameters<typeof registerAppTool>[2], run as never);
    }
    return server;
  };

  const sdk = createMcpHandler(({ authInfo }) => {
    const c = authInfo?.extra?.[CONTEXT_KEY] as Caller | undefined;
    const ui = authInfo?.extra?.[UI_KEY];
    return build(c ?? { kind: "anonymous" }, ui === "supported" || ui === "unsupported" ? ui : "unknown");
  }, { legacy: "stateless", maxRequestBodySize: maxBody, maxSubscriptions: 32, onerror: (e) => console.error("[mantle mcp] request failed", e) });

  return async (request, caller) => {
    const url = new URL(request.url);
    if ((url.pathname.replace(/\/+$/, "") || "/") !== base) return Response.json({ error: { code: "NOT_FOUND", message: "no such route" } }, { status: 404 });
    if (caller.kind !== "user" && caller.kind !== "anonymous") return challenge(403, undefined, true);
    // the staff surface is closed to everyone but staff, for listing as much as for calling
    if (options.surface === "staff") {
      if (caller.kind === "anonymous") return challenge(401);
      if (caller.role === null) return challenge(403, undefined, true); // a role is not a scope: no challenge, or a client would re-authorize in a loop
    }
    const authInfo: AuthInfo = { token: "", clientId: caller.kind === "user" ? caller.clientId ?? "" : "", scopes: caller.kind === "user" ? [...caller.scopes] : [], extra: { [CONTEXT_KEY]: caller } };
    if (request.method.toUpperCase() !== "POST" || !isJsonContentType(request.headers.get("content-type"))) return sdk.fetch(request, { authInfo });
    let text: string;
    try {
      const body = await readRequestBody(request.clone(), maxBody);
      if (body.tooLarge) return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32000, message: `Request body exceeds the ${maxBody}-byte limit.` } }, { status: 413 });
      text = body.text;
    } catch { return sdk.fetch(request, { authInfo }); }
    let message: unknown;
    try { message = JSON.parse(text); } catch { return sdk.fetch(request, { authInfo }); } // the SDK answers its own parse error
    const ui = options.apps ? clientUiSupport(message) : "unknown";
    authInfo.extra![UI_KEY] = ui;
    // every call of a batch is checked, and one refusal refuses the batch so no call in it runs
    const calls = (Array.isArray(message) ? message : [message]).flatMap((m) => (isRecord(m) && m["method"] === "tools/call" && "id" in m && isRecord(m["params"]) && typeof m["params"]["name"] === "string" ? [m["params"]["name"] as string] : []));
    for (const name of calls) {
      const tool = registers(name, ui) ? byName.get(name) : undefined;
      if (!tool) continue;
      if (caller.kind === "anonymous" && (tool.requires?.auth?.all.length ?? 0) > 0) return challenge(401, scopesOf(tool.requires).length ? { scope: scopesOf(tool.requires).join(" ") } : undefined);
      // only an OAuth token can be re-issued with more scopes; a session or key gets the runtime's denial
      if (caller.kind === "user" && caller.credential === "oauth") {
        const missing = scopesOf(tool.requires).filter((s) => !caller.scopes.includes(s));
        if (missing.length) return challenge(403, { code: "insufficient_scope", scope: [...new Set([...caller.scopes, ...missing])].join(" ") });
      }
    }
    return sdk.fetch(request, { authInfo, parsedBody: message });
  };
}
