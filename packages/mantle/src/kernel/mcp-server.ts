/**
 * The SDK side of an MCP request: one stateless server per request, its tool and App registrations, and the callback
 * that runs a `tools/call`. The caller is already admitted; each call still passes the pipeline's Origin rule and
 * generated guard before it reaches a database.
 */
import { ContractError, type Caller } from "./contracts.js";
import { callToolLazy as callTool } from "./mcp-call.js";
import type { Tool, Options } from "./mcp.js";
import { mcpAppPageLoader } from "./mcp-app-pages.js";
import {
  RESOURCE_MIME_TYPE,
  type linkSurface,
  type McpAppCsp,
  type McpAppRender,
  type McpAppResource,
} from "./mcp-apps.js";
import type { Call, Pipeline } from "./request-pipeline.js";

type Sdk = typeof import("@modelcontextprotocol/server");
type McpServer = import("@modelcontextprotocol/server").McpServer;
type Links = ReturnType<typeof linkSurface>["links"];
type LocalizedText = string | Readonly<Record<string, string>>;
type TextBlock = { type: "text"; text: string };

/** What the handler decided before the SDK runs. */
export interface Serving<Env, Database, Handlers> {
  readonly request: Request;
  readonly env: Env;
  readonly surface: "public" | "admin";
  readonly caller: Caller;
  readonly pipeline: Pipeline;
  readonly options: Options<Env, Database> & { handlers?: Handlers };
  /** The catalogue version, hashed before per-caller filtering. */
  readonly version: string;
  readonly links: Links | undefined;
  /** The parsed JSON-RPC body: one message, or a batch. */
  readonly message: unknown;
  /** The tools this caller may list and call, each with the call the pipeline decides on. */
  readonly tools: readonly { readonly tool: Tool<Database, Handlers>; readonly call: Call }[];
}

/**
 * Characters of `JSON.stringify(page)` an MCP View page may hold. A result carries its rows twice (text block and
 * `structuredContent`) and hosts are reported to truncate near 150k characters, so one copy stays at 60k.
 * ponytail: one fixed number; raise it or make it an option if hosts publish their limits.
 */
const MCP_PAGE_BUDGET = 60_000;
/**
 * Array elements plus object members one `tools/call` may carry (the SDK's `maxToolInputElements`, GHSA-46jr-4wx8-v453).
 * Refused before generated validation runs; the 1 MiB body limit still bounds everything else.
 * ponytail: one fixed number; make it an option if an application's tool needs larger inputs.
 */
const MCP_INPUT_ELEMENTS = 10_000;
const TOOL_META_KEY = "net.aotter.mantle/tool";
const CLIENT_CAPABILITIES_META_KEY = "io.modelcontextprotocol/clientCapabilities";
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: LocalizedText | undefined, locale: string): string | undefined => {
  if (typeof value === "string") return value;
  if (!value) return;
  return Object.hasOwn(value, locale) ? value[locale] : Object.hasOwn(value, "en") ? value.en : Object.values(value)[0];
};
function observe<T>(listener: ((event: T) => void | Promise<void>) | undefined, event: T): void {
  if (listener)
    try {
      void Promise.resolve(listener(event)).catch(() => {});
    } catch {}
}
/** A View tool's input schema as listed: its own properties plus the paging ones. */
const paging = (schema: { properties?: object }) => ({
  ...schema,
  properties: {
    ...schema.properties,
    limit: { type: "integer", minimum: 1, maximum: 500 },
    cursor: { type: "string" },
  },
});
const listedInput = (tool: Pick<Tool<never>, "page" | "inputSchema">) =>
  tool.page ? paging(tool.inputSchema as object) : tool.inputSchema;

/** Answer the request with a stateless SDK server over the caller's tools. */
export function serveTools<Env, Database, Handlers>(
  sdk: Sdk,
  serving: Serving<Env, Database, Handlers>,
): Promise<Response> {
  const handler = sdk.createMcpHandler(() => buildServer(sdk, serving), {
    legacy: "stateless",
    maxRequestBodySize: 1024 * 1024,
    onerror: error => console.error("[mantle mcp] request failed", error),
  });
  return handler.fetch(serving.request, { parsedBody: serving.message });
}

function buildServer<Env, Database, Handlers>(sdk: Sdk, serving: Serving<Env, Database, Handlers>): McpServer {
  const { options, pipeline, message, links, version } = serving;
  const serverInfo = { name: "aotter.mantle", ...options.serverInfo, version: options.serverInfo?.version ?? version };
  // Tools capability after construction: given to the constructor, the SDK installs its tools/call handler before the wrap below.
  const server = new sdk.McpServer(serverInfo, {
    maxToolInputElements: MCP_INPUT_ELEMENTS,
    ...(options.instructions ? { instructions: options.instructions } : {}),
  });
  server.server.registerCapabilities({ tools: { listChanged: false } });
  // A request the transport refuses never reaches a tool: the access event says so. A finished call keeps its own outcome.
  const handshake = isRecord(message) && message.method === "initialize";
  server.server.onclose = () =>
    pipeline.finish(
      handshake
        ? undefined
        : new ContractError("INPUT_VALIDATION_FAILED", "MCP request refused.", "mcp", { status: 400 }),
    );

  const support = clientUiSupport(message),
    appsEnabled = support !== "unsupported";
  const names = new Set(serving.tools.map(({ tool }) => tool.name));
  const linkedMeta = links
    ? registerApps(server, links, appsEnabled, names, { env: serving.env, request: serving.request })
    : undefined;
  const registered = new Set<string>();
  wrapCatalogueHandlers(sdk, server, registered, version, serverInfo.version, options.toolsPageSize);

  const schema = (value: unknown) =>
    sdk.fromJsonSchema(value as Parameters<Sdk["fromJsonSchema"]>[0], {
      // Generated validators check the input; the SDK's own validation would only repeat them.
      getValidator<T>(): import("@modelcontextprotocol/server").JsonSchemaValidator<T> {
        return (input: unknown) => ({ valid: true, data: input as T, errorMessage: undefined });
      },
    });
  const locale = options.locale ?? "en";
  for (const { tool, call } of serving.tools) {
    const linked = linkedMeta?.(tool.name),
      own = tool.meta,
      visibility = (own?.ui as { visibility?: unknown } | undefined)?.visibility;
    if (linked === false || (!appsEnabled && Array.isArray(visibility) && !visibility.includes("model"))) continue;
    const meta = linked && own ? { ...linked, ...own, ui: { ...linked.ui, ...(own.ui as object) } } : (linked ?? own);
    registered.add(tool.name);
    // an App renders this result only when the client declared support and a resource renders this tool
    const rendersInApp = support === "supported" && !!linked;
    server.registerTool(
      tool.name,
      {
        ...(meta ? { _meta: meta } : {}),
        ...(tool.title ? { title: text(tool.title, locale) } : {}),
        description: text(tool.description, locale) ?? text(tool.title, locale) ?? tool.name,
        inputSchema: schema(listedInput(tool)),
        ...(tool.outputSchema ? { outputSchema: schema(tool.outputSchema) } : {}),
        ...(tool.annotations ? { annotations: tool.annotations } : {}),
      },
      (raw: unknown) => invoke(serving, tool, call, raw as Record<string, unknown>, !!meta, rendersInApp),
    );
  }
  // An empty catalogue still answers tools/list and refuses calls the same way.
  if (registered.size === 0) {
    server.server.setRequestHandler("tools/list", () => ({ tools: [] }));
    server.server.setRequestHandler("tools/call", () => ({ content: [] }));
  }
  return server;
}

/**
 * Wrap the two catalogue handlers where the SDK stores them, so transport and request validation still answer first.
 * `tools/call`: a host's stale copy names a tool this catalogue lacks: say so, with the catalogue version, instead of
 * the SDK's bare "not found". `tools/list`: pages of `pageSize` tools, when the application set one.
 */
function wrapCatalogueHandlers(
  sdk: Sdk,
  server: McpServer,
  registered: ReadonlySet<string>,
  version: string,
  serverVersion: string,
  pageSize: number | undefined,
): void {
  const { ProtocolError, ProtocolErrorCode } = sdk;
  const set = server.server.setRequestHandler.bind(server.server) as (method: string, handler: unknown) => void;
  type Handle = (request: never, context: unknown) => unknown;
  const callKnown = (handle: Handle) => (request: { params: { name: string } }, context: unknown) => {
    if (!registered.has(request.params.name)) {
      const name = JSON.stringify(request.params.name);
      const message = `No tool named ${name} exists in the current catalogue (catalogue version ${serverVersion}).`;
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, message);
    }
    return handle(request as never, context);
  };
  const listPage =
    (handle: Handle, size: number) => async (request: { params?: { cursor?: string } }, context: unknown) => {
      // The cursor names the catalogue version, so a page of another catalogue is refused instead of skipping or repeating tools.
      const { tools } = (await handle(request as never, context)) as { tools: unknown[] };
      const cursor = request.params?.cursor,
        start = cursor === undefined ? 0 : Number(cursor.split(":")[1]);
      const valid =
        cursor === undefined ||
        (start > 0 && start % size === 0 && start < tools.length && cursor === `${version}:${start}`);
      if (!valid) {
        const message = `Unknown tools/list cursor; list again from the first page (catalogue version ${serverVersion}).`;
        throw new ProtocolError(ProtocolErrorCode.InvalidParams, message);
      }
      const end = start + size;
      return { tools: tools.slice(start, end), ...(end < tools.length ? { nextCursor: `${version}:${end}` } : {}) };
    };
  server.server.setRequestHandler = ((method: string, handler: unknown) => {
    if (typeof handler !== "function") return set(method, handler);
    if (method === "tools/call") return set(method, callKnown(handler as Handle));
    if (method === "tools/list" && pageSize) return set(method, listPage(handler as Handle, pageSize));
    return set(method, handler);
  }) as typeof server.server.setRequestHandler;
}

/** One `tools/call`: the pipeline's per-call steps, the tool, and the result or diagnostic the model reads. */
async function invoke<Env, Database, Handlers>(
  serving: Serving<Env, Database, Handlers>,
  tool: Tool<Database, Handlers>,
  call: Call,
  raw: Record<string, unknown>,
  hasMeta: boolean,
  rendersInApp: boolean,
) {
  const { options, pipeline, caller, request } = serving;
  // Not part of structured output: the version, and on failure the current input contract.
  const about = (contract: boolean): TextBlock[] => {
    const parts = [
      tool.version && `tool version ${tool.version}`,
      contract && `input schema ${JSON.stringify(listedInput(tool))}`,
    ];
    const line = parts.filter(Boolean).join("; ");
    return line ? [{ type: "text", text: line }] : [];
  };
  const observed = options.onObservation
    ? {
        kind: "invocation" as const,
        surface: serving.surface,
        invocationId: crypto.randomUUID(),
        tool: tool.name,
        caller: Object.freeze(
          caller.kind === "user" ? { ...caller, scopes: Object.freeze([...caller.scopes]) } : { ...caller },
        ),
      }
    : undefined;
  const started = observed ? performance.now() : 0;
  if (observed) observe(options.onObservation, { ...observed, phase: "attempt", at: Date.now() });
  let outcome: "succeeded" | "failed" | "denied" = "succeeded",
    code: string | undefined;
  try {
    // Frozen by the host contract (v1): a forwarded caller's guard answers before the Origin rule on MCP. Every other
    // caller, and REST for every caller, passes the Origin rule first.
    if (pipeline.host) pipeline.check(call);
    pipeline.enforceOrigin(request, call);
    // Application `authorize` already decided every call of the request. The generated guard runs here, before any
    // input is validated or a database handle acquired.
    pipeline.check(call);
    let db: Database | undefined, resultMeta: Readonly<Record<string, unknown>> | undefined;
    const run = async (input: Record<string, unknown>) => {
      const dryRun = pipeline.dryRun ? () => pipeline.dryRunResult() : undefined;
      const getDb = () => (db ??= options.db(serving.env));
      const output = await callTool(tool, input, getDb, caller, options.handlers as Handlers, dryRun, {
        apps: rendersInApp,
      });
      // withResultMeta: the data is the result, the meta reaches only the result `_meta`.
      if (!isRecord(output) || !(Symbol.for("net.aotter.mantle/result") in output)) return output;
      resultMeta = output._meta as typeof resultMeta;
      return output.data;
    };
    const data = await fitPage(tool, raw, await run(raw), run);
    pipeline.finish();
    const body = JSON.stringify(data),
      oversized = tool.page && body.length > MCP_PAGE_BUDGET;
    const notice =
      `This page is larger than the ${MCP_PAGE_BUDGET}-character page size budget (a single row over it, ` +
      "or a View without an order, is returned whole), so a host may truncate it. Continue with nextCursor, if any.";
    return {
      ...(hasMeta || resultMeta ? { _meta: { ...resultMeta, [TOOL_META_KEY]: tool.name } } : {}),
      content: [
        { type: "text" as const, text: body },
        ...about(false),
        ...(oversized ? [{ type: "text" as const, text: notice }] : []),
      ],
      ...(data && typeof data === "object" && !Array.isArray(data)
        ? { structuredContent: data as Record<string, unknown> }
        : {}),
    };
  } catch (error) {
    pipeline.finish(error);
    const diagnostic = await pipeline.diagnostic(error, `mcp ${tool.name}`);
    code = diagnostic.code;
    outcome = code === "AUTH_DENIED" || code === "UNAUTHENTICATED" ? "denied" : "failed";
    if (diagnostic.path === "request:origin")
      observe(options.onObservation, {
        kind: "request-refused",
        at: Date.now(),
        surface: serving.surface,
        status: 403,
        reason: "origin",
      });
    const payload = { diagnostics: [diagnostic] };
    return {
      ...(hasMeta ? { _meta: { [TOOL_META_KEY]: tool.name } } : {}),
      isError: true,
      content: [{ type: "text" as const, text: JSON.stringify(payload) }, ...about(outcome === "failed")],
      ...(tool.outputSchema ? {} : { structuredContent: payload }),
    };
  } finally {
    if (observed) {
      const durationMs = Math.max(0, performance.now() - started);
      const completion = {
        phase: "completion" as const,
        at: Date.now(),
        outcome,
        durationMs,
        ...(code ? { code } : {}),
      };
      observe(options.onObservation, { ...observed, ...completion });
    }
  }
}

/**
 * A page is cut before the first row that overflows the budget: the same page re-runs with the limit that fits, so the
 * cursor is the View's own. Data can change between reads, so the re-run is measured again. A View without an order is
 * one page and refuses a smaller limit: it stays whole.
 */
async function fitPage(
  tool: { readonly page?: unknown },
  raw: Record<string, unknown>,
  first: unknown,
  run: (input: Record<string, unknown>) => Promise<unknown>,
): Promise<unknown> {
  let data = first;
  for (let tries = 0; tool.page && isRecord(data) && Array.isArray(data.rows); tries++) {
    const rows = data.rows as unknown[],
      total = JSON.stringify(data).length;
    if (total <= MCP_PAGE_BUDGET) break;
    if (rows.length === 1 || tries === 4) break;
    const sizes = rows.map(row => JSON.stringify(row).length);
    let size = total - sizes.reduce((sum, length) => sum + length, 0) - (rows.length - 1),
      fit = 0;
    for (const length of sizes) {
      size += length + (fit ? 1 : 0);
      if (size > MCP_PAGE_BUDGET) break;
      fit++;
    }
    const cut = await run({ ...raw, limit: Math.max(1, fit) }).catch(() => undefined);
    if (cut === undefined) break;
    data = cut;
  }
  return data;
}

/** `unknown`: a stateless request after `initialize` carries no capabilities, so only an explicit refusal hides Apps. */
function clientUiSupport(message: unknown): "supported" | "unsupported" | "unknown" {
  for (const entry of Array.isArray(message) ? message : [message]) {
    if (!isRecord(entry) || !isRecord(entry.params)) continue;
    const meta = entry.params._meta;
    const declared =
      isRecord(meta) && isRecord(meta[CLIENT_CAPABILITIES_META_KEY])
        ? meta[CLIENT_CAPABILITIES_META_KEY]
        : entry.method === "initialize" && isRecord(entry.params.capabilities)
          ? entry.params.capabilities
          : undefined;
    if (!declared) continue;
    const extensions = declared.extensions,
      ui = isRecord(extensions) ? extensions["io.modelcontextprotocol/ui"] : undefined;
    return isRecord(ui) && Array.isArray(ui.mimeTypes) && ui.mimeTypes.includes(RESOURCE_MIME_TYPE)
      ? "supported"
      : "unsupported";
  }
  return "unknown";
}

function appMeta(
  resource: McpAppResource,
  csp: McpAppCsp | undefined = resource.csp,
): { ui: Record<string, unknown> } | undefined {
  const ui = {
    ...(csp ? { csp } : {}),
    ...(resource.permissions ? { permissions: resource.permissions } : {}),
    ...(resource.domain !== undefined ? { domain: resource.domain } : {}),
    ...(resource.prefersBorder !== undefined ? { prefersBorder: resource.prefersBorder } : {}),
  };
  return Object.keys(ui).length > 0 ? { ui } : undefined;
}

/** Registration uses the official SDK; HTML loaders run only on resources/read. */
function registerApps(
  server: McpServer,
  links: Links,
  enabled: boolean,
  tools: ReadonlySet<string>,
  request: Pick<McpAppRender, "env" | "request">,
) {
  if (enabled)
    for (const resource of links.resources) {
      const meta = appMeta(resource);
      const listing = {
        mimeType: RESOURCE_MIME_TYPE,
        title: resource.title,
        description: resource.description,
        ...(meta ? { _meta: meta } : {}),
      };
      server.registerResource(resource.name, resource.uri, listing, async () => {
        try {
          // A statically linked resource is as its contributor declared it; a resolved one is already in normal form.
          const page = await mcpAppPageLoader(resource.html)({ tools, ...request }),
            typed = page.csp ? appMeta(resource, page.csp) : meta,
            own = resource.meta,
            read = typed && own ? { ...own, ui: { ...(own.ui as object), ...typed.ui } } : (typed ?? own);
          return {
            contents: [
              { uri: resource.uri, mimeType: RESOURCE_MIME_TYPE, text: page.html, ...(read ? { _meta: read } : {}) },
            ],
          };
        } catch (error) {
          console.error(
            "[mantle mcp] resource rendering failed:",
            error instanceof Error ? error.message : String(error),
          );
          throw new Error("Internal error.");
        }
      });
    }
  return (tool: string) => {
    if (!enabled) return links.appOnly.has(tool) ? false : undefined;
    const uri = links.renders.get(tool);
    if (!uri) return undefined;
    const appOnly = links.appOnly.has(tool);
    const ui = { resourceUri: uri, ...(appOnly ? { visibility: ["app"] } : {}) };
    return { ui, "ui/resourceUri": uri, ...(appOnly ? {} : { "openai/outputTemplate": uri }) };
  };
}
