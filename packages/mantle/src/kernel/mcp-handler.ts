/**
 * Request-only MCP implementation, excluded from Worker startup. `handler` reads top-down as the steps of one MCP
 * request: the request pipeline makes the caller and authorization decisions, and `mcp-server.ts` speaks the SDK.
 */
import { authorized } from "./authorization.js";
import { isAdmin, ContractError, wire, type Caller, type RequestContext } from "./contracts.js";
import { draining } from "./drain.js";
import type { Tool, Tools, Options } from "./mcp.js";
import { linkSurface, type McpAppRender, type McpAppsSource } from "./mcp-apps.js";
import { resolveMcpApps } from "./mcp-app-pages.js";
import { serveTools, isRecord, observe } from "./mcp-server.js";
import {
  isView,
  notScopeGated,
  openPipeline,
  scopedOnly,
  type Call,
  type Pipeline,
  type PipelineOptions,
} from "./request-pipeline.js";

type Surface = "public" | "admin";
type AppLinks = ReturnType<typeof linkSurface>;
type ReadCatalogue = readonly { readonly name: string; readonly surface: string }[];
const BODY_LIMIT = 1024 * 1024;
/** The SDK's own batch limit (`MAX_BATCH_SIZE`, @modelcontextprotocol/server 2.4.0 dist/index.mjs:39, refused at 515-517). */
const MAX_BATCH_SIZE = 100;
/** Methods that only read the catalogue: they suit cached cookie authority. The connect steps name no tool. */
const CATALOGUE_METHODS = ["initialize", "server/discover", "tools/list", "resources/list", "resources/read"];
/** Methods whose answer names tools, so it is filtered to what the caller may call. */
const LISTING_METHODS = ["tools/list", "resources/read"];
/** The scopes a challenge asks for: the credential’s, plus what the request needs. */
const union = (scopes: readonly string[], extra: readonly string[]) => [...new Set([...scopes, ...extra])].join(" ");
const anonymous = () => ({ kind: "anonymous" }) as const;


/** A refusal answered before any tool runs: `scope` is what the challenge asks for, `bare` sends no challenge. */
interface Refusal {
  readonly error: ContractError;
  readonly scope?: string;
  readonly bare?: boolean;
}

/** The handler for `/mcp` (public tools) and `/mcp/admin` (tools for `admin` roles); other paths are undefined. */
export function handler<Env, Database, Handlers>(
  tools: Tools<Env, Database, Handlers>,
  options: Options<Env, Database> & Pick<PipelineOptions, "fields"> & { handlers?: Handlers },
  apps: Partial<Record<string, AppLinks>> = {},
  reads: ReadCatalogue = [],
): (request: Request, env: Env, ctx?: RequestContext) => Promise<Response | undefined> {
  const allowedOrigins = options.allowedOrigins ?? [];
  if (options.toolsPageSize !== undefined && !(Number.isInteger(options.toolsPageSize) && options.toolsPageSize > 0))
    throw new TypeError("mcp: toolsPageSize must be a positive integer.");
  const requiredScopes = options.requiredScopes ?? ["mcp"];

  const serve = draining(async (request: Request, env: Env, ctx?: RequestContext) => {
    const pipeline = await openPipeline(ctx, options);
    try {
      const url = new URL(request.url),
        path = url.pathname.replace(/\/+$/, "");
      const surface = path === "/mcp" ? ("public" as const) : path === "/mcp/admin" ? ("admin" as const) : undefined;
      if (!surface) return;

      // Transport: a browser on a foreign origin is refused before any credential is read.
      const foreign = await foreignOrigin(request, allowedOrigins);
      if (foreign) {
        pipeline.finish(new ContractError("AUTH_DENIED", "Origin is not allowed.", "request:origin"));
        observeRefusal(options, surface, 403, "origin");
        return foreign;
      }

      /** Every refusal before the SDK runs: the access event, the observations, then an OAuth challenge. */
      const challenge = async (error: unknown, scope?: string, bare = false): Promise<Response> => {
        pipeline.finish(error);
        const { status } = wire(error);
        if (status === 401 || status === 403) observeRefusal(options, surface, status, "credential");
        if (status === 401)
          scope = union(scope === undefined ? requiredScopes : scope.split(" "), options.authorizationScopes ?? []);
        const metadata = options.resourceMetadata ?? url.origin + "/.well-known/oauth-protected-resource/mcp";
        const scopes = scope ? (status === 403 ? 'error="insufficient_scope", ' : "") + `scope="${scope}", ` : "";
        return pipeline.failure(
          error,
          `mcp ${path}`,
          bare ? undefined : `Bearer ${scopes}resource_metadata="${metadata}"`,
        );
      };

      const select = async () =>
        (typeof tools === "function" ? await tools(request, env) : tools).filter(tool => tool.surface === surface);
      // Dynamic admin tables stay behind the admin gate; cache classification uses generated metadata only.
      let selected = surface === "public" ? await select() : [];

      // A cookie's read-only hint and a host's target both come from the body, so those requests read it first.
      const body = bodyReader(request, pipeline.gateway);
      const cookieOnly = request.headers.has("cookie") && !request.headers.has("authorization");
      if (cookieOnly || pipeline.gateway) await body.read();
      const readOnly = request.method === "POST" && readsOnly(body.messages, reads, surface);

      // Caller: resolve it, then apply the endpoint's own rules.
      let caller: Caller;
      try {
        // A request-bound admin table is not loaded to name the target of a caller who may not see it.
        const mounted = typeof tools === "function" ? selected : tools.filter(tool => tool.surface === surface);
        const named = namedTool(body.parsed, mounted);
        await pipeline.select(
          named.tool?.target ? targetId(named.tool) : typeof named.name === "string" ? `mcp:${named.name}` : "mcp",
        );
        caller = await pipeline.resolveCaller(request, env, options.caller ?? anonymous, readOnly);
        await pipeline.select(
          named.tool?.target ? targetId(named.tool) : "target" in caller && caller.target ? caller.target : "mcp",
        );
        const refusal = endpointRefusal(caller, surface, selected, requiredScopes, pipeline.host);
        if (refusal) return challenge(refusal.error, refusal.scope, refusal.bare);
      } catch (error) {
        return challenge(error);
      }

      if (surface === "admin") selected = await select();
      // Before per-caller filtering, so every caller of a deploy sees one catalogue version.
      const version = catalogueVersion(selected);
      const sdk = await import("@modelcontextprotocol/server");
      await body.read();
      if (body.tooLarge && pipeline.gateway)
        return challenge(
          new ContractError("INPUT_VALIDATION_FAILED", "MCP body exceeds its limit.", "mcp"),
          undefined,
          true,
        );
      if (body.tooLarge) {
        const error = { code: -32000, message: `Request body exceeds ${BODY_LIMIT} bytes.` };
        return Response.json({ jsonrpc: "2.0", id: null, error }, { status: 413 });
      }
      // Gateway mode read the request itself, so the SDK cannot read an empty or malformed body again: answer its parse
      // error here, as the client's.
      if (pipeline.gateway && request.method === "POST" && body.parsed === undefined) {
        pipeline.finish(new ContractError("INPUT_VALIDATION_FAILED", "MCP body is not JSON.", "mcp", { status: 400 }));
        const error = { code: -32700, message: "Parse error: Invalid JSON" };
        return Response.json({ jsonrpc: "2.0", id: null, error }, { status: 400 });
      }

      // A host forwards one message per request, and its target is admitted before anything else is decided.
      if (pipeline.host) {
        try {
          await admitHostMessage(pipeline, caller, body.parsed, selected);
        } catch (error) {
          return challenge(error, undefined, true);
        }
      }

      // A batch the SDK would refuse for its size is refused, as the SDK answers it, before any call is authorized.
      if (body.messages.length > MAX_BATCH_SIZE) {
        pipeline.finish(new ContractError("INPUT_VALIDATION_FAILED", "MCP request refused.", "mcp", { status: 400 }));
        const message = `Invalid Request: Batch must not exceed ${MAX_BATCH_SIZE} messages`;
        return Response.json({ jsonrpc: "2.0", error: { code: -32600, message }, id: null }, { status: 400 });
      }
      // Credentials: every call in a batch (2025-03-26 and earlier) is checked before any call runs, each tool once.
      const called = calledTools(body.messages, selected);
      for (const tool of called) {
        const refusal = credentialRefusal(caller, tool, requiredScopes, pipeline.host);
        if (refusal) return challenge(refusal.error, refusal.scope, refusal.bare);
      }
      // A service credential sees only the tools it may call, in every discovery mode.
      if (scopedOnly(caller, pipeline.host)) selected = selected.filter(tool => tool.scopes?.length);

      const links = await linkRequestApps(options.apps?.[surface], selected, apps, surface, { env, request });

      // Application authorization: each called tool, then the tools a list or an App's HTML may name.
      if (options.authorize) {
        try {
          for (const tool of called) await pipeline.guard(callOf(tool));
          const lists = body.messages.some(
            message => isRecord(message) && LISTING_METHODS.includes(message.method as string),
          );
          // an App's HTML is rendered for the same tools the caller's tools/list shows
          if (options.discovery !== "all" && lists) {
            const visible = [];
            for (const tool of selected) {
              if (credentialRefusal(caller, tool, requiredScopes, pipeline.host)) continue;
              try {
                tool.check?.(caller);
              } catch (error) {
                if (error instanceof ContractError && ["AUTH_DENIED", "UNAUTHENTICATED"].includes(error.code)) continue;
                throw error;
              }
              if (await authorized(options.authorize, authorizeTarget(tool), caller)) visible.push(tool);
            }
            selected = visible;
          }
        } catch (error) {
          return challenge(error);
        }
      }

      // Each call runs in the SDK callback, after transport validation; the pipeline finishes its steps there.
      const response = await serveTools(sdk, {
        request,
        env,
        surface,
        caller,
        pipeline,
        options,
        version,
        links,
        message: body.parsed,
        tools: selected.map(tool => ({ tool, call: callOf(tool) })),
      });
      if (response.status >= 400)
        pipeline.finish(
          new ContractError("INPUT_VALIDATION_FAILED", "MCP request refused.", "mcp", { status: response.status }),
        );
      return response;
    } catch (error) {
      return pipeline.failure(error, "mcp");
    }
  });
  return async (request, env, ctx) => {
    const response = await serve(request, env, ctx);
    // The SDK's own refusals (400, 405, 406, a foreign Origin) state no Cache-Control: a shared cache would keep them.
    if (response && !response.headers.has("cache-control")) response.headers.set("cache-control", "private, no-store");
    return response;
  };
}

/** `request-refused` for observers of the endpoint. */
function observeRefusal(
  options: Pick<Options<never, unknown>, "onObservation">,
  surface: Surface,
  status: 401 | 403,
  reason: "origin" | "credential",
): void {
  observe(options.onObservation, { kind: "request-refused", at: Date.now(), surface, status, reason });
}

/**
 * MCP transport MUST: a present Origin is a browser, answered only for loopback or `allowedOrigins`. The request's own
 * host is not implied, since a DNS-rebinding page sends Origin == its rebound Host; a missing Origin is a server client.
 */
async function foreignOrigin(request: Request, allowedOrigins: readonly string[]): Promise<Response | undefined> {
  if (!request.headers.has("origin")) return undefined;
  const sdk = await import("@modelcontextprotocol/server");
  return sdk.originValidationResponse(request, [...sdk.localhostAllowedOrigins(), ...allowedOrigins]);
}

/**
 * The JSON-RPC body, read at most once. Gateway mode reads the request itself; otherwise the SDK reads a clone and
 * the transport reads the original. An unreadable or malformed body stays `undefined` for the SDK to refuse.
 */
function bodyReader(request: Request, gateway: boolean) {
  let parsed: unknown,
    tooLarge = false,
    done = false;
  const readForGateway = async () => {
    try {
      const { bytes } = await import("./json-body.js");
      const raw = await bytes(request, BODY_LIMIT, () => {
        tooLarge = true;
        throw new Error("Body limit");
      });
      parsed = JSON.parse(new TextDecoder().decode(raw));
    } catch {}
  };
  const readClone = async () => {
    const { readRequestBody } = await import("@modelcontextprotocol/server");
    try {
      const text = await readRequestBody(request.clone() as Parameters<typeof readRequestBody>[0], BODY_LIMIT);
      tooLarge = text.tooLarge;
      if (!text.tooLarge) parsed = JSON.parse(text.text);
    } catch {}
  };
  return {
    get parsed() {
      return parsed;
    },
    get tooLarge() {
      return tooLarge;
    },
    /** The body's messages: a batch (2025-03-26 and earlier), or the one message. */
    get messages(): readonly unknown[] {
      return Array.isArray(parsed) ? parsed : [parsed];
    },
    async read(): Promise<void> {
      if (done || request.method !== "POST") return;
      done = true;
      await (gateway ? readForGateway() : readClone());
    },
  };
}

/** The read-only hint for the caller resolver: every message only lists, or calls a tool of the read catalogue. */
function readsOnly(messages: readonly unknown[], reads: ReadCatalogue, surface: Surface): boolean {
  return (
    messages.length > 0 &&
    messages.every(message => {
      if (!isRecord(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") return false;
      if (CATALOGUE_METHODS.includes(message.method)) return true;
      if (message.method !== "tools/call") return false;
      const name = isRecord(message.params) ? message.params.name : undefined;
      return reads.some(tool => tool.surface === surface && tool.name === name);
    })
  );
}

/** The tool a single message names, looked up before the caller is known. */
function namedTool<T extends { readonly name: string }>(
  message: unknown,
  mounted: readonly T[],
): { name: unknown; tool?: T } {
  const name = isRecord(message) && isRecord(message.params) ? message.params.name : undefined;
  return { name, tool: mounted.find(tool => tool.name === name) };
}

/** A tool's id in access events and host pins: its manifest target, or the admin tool's own name. */
const targetId = (tool: Pick<Tool<never>, "target" | "name">): string =>
  tool.target ? `${tool.target.kind}:${tool.target.name}` : `admin:tool:${tool.name}`;
/** What application `authorize` decides on: the manifest target, or one named after the tool. */
const authorizeTarget = (tool: Pick<Tool<never>, "target" | "name" | "page">) =>
  tool.target ?? { kind: tool.page ? ("view" as const) : ("procedure" as const), name: tool.name };
/** A tool as the pipeline sees it. */
const callOf = <Database, Handlers>(tool: Tool<Database, Handlers>): Call => ({
  id: targetId(tool),
  view: isView(tool),
  readOnly: tool.readOnly,
  target: authorizeTarget(tool),
  check: tool.check,
  scoped: !!tool.scopes?.length,
});

/** The endpoint's own caller rules, in order: a closed endpoint, system callers, the admin layer, the scope floor. */
function endpointRefusal(
  caller: Caller,
  surface: Surface,
  selected: readonly { readonly closed?: boolean }[],
  requiredScopes: readonly string[],
  host: boolean,
): Refusal | undefined {
  const closed = surface === "admin" || (selected.length > 0 && selected.every(tool => tool.closed));
  if (caller.kind === "anonymous" && closed)
    return { error: new ContractError("UNAUTHENTICATED", "Authentication is required.", "mcp") };
  if (caller.kind === "system")
    return { error: new ContractError("AUTH_DENIED", "System callers cannot use MCP.", "mcp"), bare: true };
  if (surface === "admin" && !isAdmin(caller))
    return { error: new ContractError("AUTH_DENIED", "Admin role is required.", "mcp/admin"), bare: true };
  // A forwarded caller's scopes were its gateway's to check; a cookie session carries none.
  if (
    !host &&
    caller.kind === "user" &&
    caller.credential !== "session" &&
    requiredScopes.some(scope => !caller.scopes.includes(scope))
  ) {
    const error = new ContractError("AUTH_DENIED", "The credential needs the required MCP scopes.", "mcp");
    return { error, scope: union(caller.scopes, requiredScopes) };
  }
  return undefined;
}

/**
 * One tool's credential rules: an auth requirement challenges an anonymous caller, a service credential reaches only a
 * tool that names scopes, and either credential needs the tool's scopes.
 */
function credentialRefusal(
  caller: Caller,
  tool: { readonly closed?: boolean; readonly scopes?: readonly string[] },
  requiredScopes: readonly string[],
  host: boolean,
): Refusal | undefined {
  const scopes = tool.scopes ?? [];
  if (caller.kind === "anonymous" && tool.closed)
    return {
      error: new ContractError("UNAUTHENTICATED", "Authentication is required.", "mcp"),
      scope: union(requiredScopes, scopes),
    };
  if (scopedOnly(caller, host) && !scopes.length) return { error: notScopeGated(), bare: true };
  if (
    !host &&
    caller.kind === "user" &&
    caller.credential !== "session" &&
    scopes.some(scope => !caller.scopes.includes(scope))
  ) {
    const error = new ContractError("AUTH_DENIED", "The credential needs additional scopes.", "mcp");
    return { error, scope: union(caller.scopes, scopes) };
  }
  return undefined;
}

/**
 * A host's authority is the one target its gateway pinned, so it forwards one message that names nothing else: one
 * `tools/call`, or the connect step pinned to a mounted tool (`initialize` on a 2025 revision, `server/discover` on
 * 2026-07-28; neither names a tool). A catalogue read (`tools/list`, `resources/*`) would show tools and App HTML beyond
 * the pin, so it is refused, as is a notification or a batch. The rule reads the method whichever era the SDK serves
 * the message on, so it holds for both forms.
 */
async function admitHostMessage<Database, Handlers>(
  pipeline: Pipeline,
  caller: Caller,
  message: unknown,
  selected: readonly Tool<Database, Handlers>[],
): Promise<void> {
  if (Array.isArray(message))
    throw new ContractError("INPUT_VALIDATION_FAILED", "Host calls cannot batch MCP messages.", "mcp");
  const method = isRecord(message) ? message.method : undefined;
  if (typeof method === "string" && !["initialize", "server/discover", "tools/call"].includes(method))
    throw new ContractError(
      "AUTH_DENIED",
      "Host callers may only initialize, discover the server or call a tool.",
      "mcp",
      { status: 403 },
    );
  if (method === "initialize" || method === "server/discover") {
    const pinned = "target" in caller ? caller.target : undefined;
    if (pinned && !selected.some(tool => targetId(tool) === pinned))
      throw new ContractError("TARGET_MISMATCH", `${method} must pin a mounted tool.`, pinned, { status: 412 });
    await pipeline.admit({ id: pinned ?? "mcp", view: true });
    return;
  }
  const params = isRecord(message) && isRecord(message.params) ? message.params : undefined;
  const tool = selected.find(candidate => candidate.name === params?.name);
  if (tool) await pipeline.admit(callOf(tool));
}

/** The mounted tools the `tools/call` messages name, each once; a name the catalogue lacks is the SDK's to refuse. */
function calledTools<T extends { readonly name: string }>(messages: readonly unknown[], selected: readonly T[]): T[] {
  const tools = messages.flatMap(message => {
    const call = message as { method?: unknown; params?: { name?: unknown } | null } | null | undefined;
    if (!call || call.method !== "tools/call") return [];
    const tool = selected.find(candidate => candidate.name === call.params?.name);
    return tool ? [tool] : [];
  });
  return [...new Set(tools)];
}

/** Resolve the endpoint's App sources for this request and link them to its tools; static links are cached per surface. */
async function linkRequestApps(
  declared: McpAppsSource | readonly McpAppsSource[] | undefined,
  selected: Parameters<typeof linkSurface>[1],
  cache: Partial<Record<string, AppLinks>>,
  surface: Surface,
  render: Pick<McpAppRender, "env" | "request">,
): Promise<AppLinks["links"] | undefined> {
  if (!declared) return undefined;
  const sources = (Array.isArray(declared) ? declared : [declared]) as readonly McpAppsSource[];
  const dynamic = sources.some(source => typeof source === "function");
  const resolved = await resolveMcpApps(sources, render);
  // Equal tool names say nothing about request-bound resource identity or ownership.
  const current = linkSurface(resolved, selected, dynamic ? undefined : cache[surface]);
  if (!dynamic) cache[surface] = current;
  return current.links;
}

/**
 * A hash of the tools an endpoint serves (`surface:name:version`, sorted), as 32-bit FNV-1a hex: it changes with any
 * tool's definition.
 */
function catalogueVersion(
  tools: readonly { readonly surface: string; readonly name: string; readonly version?: string }[],
): string {
  const text = JSON.stringify(tools.map(tool => `${tool.surface}:${tool.name}:${tool.version ?? ""}`).sort());
  const hash = [...text].reduce((value, char) => Math.imul(value ^ char.codePointAt(0)!, 16777619) >>> 0, 2166136261);
  return hash.toString(16).padStart(8, "0");
}
