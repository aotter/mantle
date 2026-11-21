/**
 * The SDK side of an MCP request, on either protocol era (2025 revisions, stateless; 2026-07-28): one server per
 * request, its tool and App registrations, and the callback that runs a `tools/call`. The caller is already admitted;
 * each call still passes the pipeline's Origin rule and generated guard before it reaches a database.
 */
import { ContractError, type Caller } from "./contracts.js";
import { callToolLazy as callTool } from "./mcp-call.js";
import type { Tool, Options, ToolCall } from "./mcp.js";
import { mcpAppPageLoader } from "./mcp-app-pages.js";
import {
  RESOURCE_MIME_TYPE,
  type linkSurface,
  type McpAppCsp,
  type McpAppRender,
  type McpAppResource,
} from "./mcp-apps.js";
import type { Call, Pipeline } from "./request-pipeline.js";
import { localizedSchema, localizedText as text } from "./localized-schema.js";

type Sdk = typeof import("@modelcontextprotocol/server");
type McpServer = import("@modelcontextprotocol/server").McpServer;
type Links = ReturnType<typeof linkSurface>["links"];
type TextBlock = { type: "text"; text: string };
type Icon = import("@modelcontextprotocol/server").Icon;
type Annotations = import("@modelcontextprotocol/server").Annotations;
type RequestContext = import("@modelcontextprotocol/server").ServerContext;
type RegisteredTool = import("@modelcontextprotocol/server").RegisteredTool;

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
  /** The parsed JSON-RPC body: one message, or a batch (2025-03-26 and earlier). */
  readonly message: unknown;
  /** The tools this caller may list and call, each with the call the pipeline decides on. */
  readonly tools: readonly { readonly tool: Tool<Database, Handlers>; readonly call: Call }[];
}

/**
 * Characters of `JSON.stringify(page)` an MCP View page may hold. A result carries its rows twice (text block and
 * `structuredContent`), and Claude does not pass a result over about 150k characters to its App when code execution
 * is active, so one copy stays at 60k.
 * ponytail: one fixed number; raise it or make it an option if hosts publish other limits.
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
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
export function observe<T>(listener: ((event: T) => void | Promise<void>) | undefined, event: T): void {
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
/** A tool's input schema as listed, its labels in `locale`. */
const listedInput = (tool: Pick<Tool<never>, "page" | "inputSchema">, locale: string) =>
  localizedSchema(tool.page ? paging(tool.inputSchema as object) : tool.inputSchema, locale);

/**
 * Answer the request with a per-request SDK server over the caller's tools. The SDK classifies the request: a 2025-era
 * one (an `initialize`, a message without the `_meta` envelope, a batch) is served statelessly, a 2026-07-28 one on the
 * modern path, and the factory learns which. A request that names a revision neither era serves (an envelope claiming
 * another revision: JSON-RPC -32022; a 2025-era `MCP-Protocol-Version` header the SDK does not support) is observed.
 * Every transport refusal the SDK answers with a 4xx (that one, an invalid envelope, headers that contradict the body,
 * 405, 415) is the client's, so what the SDK reported for it is not logged; a 5xx or an error during a served exchange is.
 */
export async function serveTools<Env, Database, Handlers>(
  sdk: Sdk,
  serving: Serving<Env, Database, Handlers>,
): Promise<Response> {
  const pending: unknown[] = [];
  let settled = false;
  const handler = sdk.createMcpHandler(({ era }) => buildServer(sdk, serving, era === "legacy"), {
    legacy: "stateless",
    maxRequestBodySize: 1024 * 1024,
    onerror: error => (settled ? log(error) : void pending.push(error)),
  });
  const response = await handler.fetch(serving.request, { parsedBody: serving.message });
  const answer =
    response.status === 400
      ? ((await response
          .clone()
          .json()
          .catch(() => undefined)) as { error?: { code?: unknown; message?: unknown } } | undefined)
      : undefined;
  settled = true;
  // -32022 from the modern path; the 2025-era transport answers an unsupported header with -32000 and this message
  // (`validateProtocolVersion`, @modelcontextprotocol/server 2.4.0 dist/index.mjs:689-694).
  const { code, message } = answer?.error ?? {};
  if (
    code === sdk.ProtocolErrorCode.UnsupportedProtocolVersion ||
    (code === -32000 && String(message).startsWith("Bad Request: Unsupported protocol version"))
  )
    observe(serving.options.onObservation, {
      kind: "request-refused",
      at: Date.now(),
      surface: serving.surface,
      status: 400,
      reason: "protocol-version",
    });
  if (response.status < 400 || response.status >= 500) pending.forEach(log);
  return response;
}
const log = (error: unknown) => console.error("[mantle mcp] request failed", error);
/** The client went away before the request was answered (status 499, as nginx records it). */
const cancelled = (cause?: unknown) =>
  new ContractError("REQUEST_CANCELLED", "The client cancelled the request.", "mcp", { status: 499, cause });

/** `legacy`: the SDK serves this request on a 2025 revision (its own classification, handed to the factory). */
function buildServer<Env, Database, Handlers>(
  sdk: Sdk,
  serving: Serving<Env, Database, Handlers>,
  legacy: boolean,
): McpServer {
  const { options, pipeline, message, links, version } = serving;
  const serverInfo = {
    name: "aotter.mantle",
    ...options.serverInfo,
    version: options.serverInfo?.version ?? version,
  } as import("@modelcontextprotocol/server").Implementation;
  // Tools capability after construction: given to the constructor, the SDK installs its tools/call handler before the wrap below.
  const server = new sdk.McpServer(serverInfo, {
    maxToolInputElements: MCP_INPUT_ELEMENTS,
    ...(options.instructions ? { instructions: options.instructions } : {}),
  });
  server.server.registerCapabilities({ tools: { listChanged: false } });
  // A request the transport refuses never reaches a tool: the access event says so. A call that started records its own
  // outcome, also when the client goes away before it ends; the connect step (`initialize` on a 2025 revision,
  // `server/discover` on 2026-07-28) names no tool and succeeds. A request the client left before it was served (the SDK
  // answers 499 and runs nothing) is recorded as cancelled.
  const handshake = isRecord(message) && message.method === (legacy ? "initialize" : "server/discover");
  let calling = false;
  server.server.onclose = () => {
    if (!calling)
      pipeline.finish(
        serving.request.signal.aborted
          ? cancelled()
          : // An `initialize` the SDK refused (invalid params) never reached its handler, which records the client.
            handshake && (!legacy || server.server.getClientVersion() !== undefined)
            ? undefined
            : new ContractError("INPUT_VALIDATION_FAILED", "MCP request refused.", "mcp", { status: 400 }),
      );
  };

  // A 2026-07-28 request always declares its capabilities, so only a stateless 2025-era one can leave support unknown.
  const declared = clientUiSupport(message),
    support = declared === "unknown" && !legacy ? "unsupported" : declared,
    appsEnabled = support !== "unsupported";
  // A stateless server never sends list changes; the SDK would advertise them for resources once one registers.
  if (appsEnabled && links?.resources.length) server.server.registerCapabilities({ resources: { listChanged: false } });
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
  // App-only visibility hides a tool from the list a client without MCP Apps shows its model. A `tools/call` that names
  // one (an App's own call a host forwards, or any client) runs it like any other tool: visibility grants no authority
  // and withholds none. A 2025-era batch that also lists tools registers only what that list may show.
  const messages = Array.isArray(message) ? message : [message],
    method = (name: string) => messages.some(entry => isRecord(entry) && entry.method === name),
    calls = method("tools/call") && !method("tools/list");
  for (const { tool, call } of serving.tools) {
    // `false`: an `appOnly` View of a request without MCP Apps
    const link = linkedMeta?.(tool.name),
      linked = link || undefined,
      own = tool.meta,
      visibility = (own?.ui as { visibility?: unknown } | undefined)?.visibility;
    if (!calls && (link === false || (!appsEnabled && Array.isArray(visibility) && !visibility.includes("model"))))
      continue;
    const meta = linked && own ? { ...linked, ...own, ui: { ...linked.ui, ...(own.ui as object) } } : (linked ?? own);
    registered.add(tool.name);
    // an App renders this result only when the client declared support and a resource renders this tool
    const rendersInApp = support === "supported" && !!linked;
    const listed: RegisteredTool = server.registerTool(
      tool.name,
      {
        ...(meta ? { _meta: meta } : {}),
        ...(tool.title ? { title: text(tool.title, locale) } : {}),
        description: text(tool.description, locale) ?? text(tool.title, locale) ?? tool.name,
        inputSchema: schema(listedInput(tool, locale)),
        ...(tool.outputSchema ? { outputSchema: schema(localizedSchema(tool.outputSchema, locale)) } : {}),
        ...(tool.annotations ? { annotations: tool.annotations } : {}),
        ...(tool.icons ? { icons: tool.icons as Icon[] } : {}),
      },
      (raw: unknown, context: RequestContext) => {
        calling = true;
        return invoke(
          serving,
          tool,
          call,
          raw as Record<string, unknown>,
          !!meta,
          rendersInApp,
          links?.renders.has(tool.name) ?? false,
          sdk.isCallToolResult,
          context,
          listed.outputSchemaJson,
          server.server.getClientVersion(),
          legacy
            ? (serving.request.headers.get("mcp-protocol-version") ?? sdk.DEFAULT_NEGOTIATED_PROTOCOL_VERSION)
            : server.server.getNegotiatedProtocolVersion(),
          legacy,
        );
      },
    );
    // A 2025 revision's structured content is a JSON object. Its SDK codec would list any other root wrapped as
    // `{ result }` and wrap the value to match (`projectCallToolResult`), so one tool would answer two shapes: on that
    // era, a schema whose root the SDK does not list as an object is not listed, and its non-object data is sent as text
    // only. The SDK's own conversion decides, so a typeless root it proves object-shaped stays listed. A root that also
    // admits another value (`nullable`, a type list) is not listed either: that value is sent as text, and the SDK would
    // refuse a listed schema without structured content after the call was recorded.
    const json = listed.outputSchemaJson;
    if (legacy && !(json?.type === "object" && objectOnly(json)))
      listed.outputSchema = listed.outputSchemaJson = undefined;
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

/** The JSON type a schema's root `type` (with `nullable`) names, checked against the value: a cheap guard, not validation. */
function rootAllows(schema: Record<string, unknown>, value: unknown): boolean {
  if (value === undefined || schema.type === undefined) return value !== undefined;
  const types = [schema.type, schema.nullable === true && "null"].flat(),
    kind = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  return types.includes(kind) || (kind === "number" && types.includes(Number.isInteger(value) ? "integer" : ""));
}
/** `rootAllows` admits an object and no other JSON kind under this root. */
const objectOnly = (schema: Record<string, unknown>) =>
  [null, [], "", 1, 0.5, true].every(value => !rootAllows(schema, value));
/** One `tools/call`: the pipeline's per-call steps, the tool, and the result or diagnostic the model reads. */
async function invoke<Env, Database, Handlers>(
  serving: Serving<Env, Database, Handlers>,
  tool: Tool<Database, Handlers>,
  call: Call,
  raw: Record<string, unknown>,
  hasMeta: boolean,
  rendersInApp: boolean,
  linkedApp: boolean,
  isResult: Sdk["isCallToolResult"],
  { mcpReq }: RequestContext,
  /** The outputSchema as listed (the SDK's own conversion): a success carries structuredContent its root admits. */
  listed: Record<string, unknown> | undefined,
  /** The client's `clientInfo`, from the request's `_meta` (2026-07-28 only: a stateless 2025-era call carries none). */
  client: { readonly name: string; readonly version: string } | undefined,
  /** The revision the call is served on. */
  protocolVersion: string | undefined,
  /** Served on a 2025 revision, whose structured content is an object. */
  legacy: boolean,
) {
  const { options, pipeline, caller, request } = serving;
  // Progress only for a request that carries a token; the SDK sends it on this request's stream. One the client can no
  // longer receive is dropped, never failing the call.
  const token = mcpReq._meta?.progressToken;
  // The SDK also aborts its own signal when it tears the request down after sending the result: the tool's follows it
  // only while this call runs, so a call that finished never sees an abort.
  const cancel = new AbortController();
  const toolCall: ToolCall = {
    apps: rendersInApp,
    linkedApp,
    signal: cancel.signal,
    ...(token === undefined
      ? {}
      : {
          progress: (progress, total, message) =>
            mcpReq
              .notify({ method: "notifications/progress", params: { progressToken: token, progress, total, message } })
              .catch(() => {}),
        }),
  };
  // Not part of structured output: the version, and on failure the current input contract.
  const about = (contract: boolean): TextBlock[] => {
    const parts = [
      tool.version && `tool version ${tool.version}`,
      contract && `input schema ${JSON.stringify(listedInput(tool, options.locale ?? "en"))}`,
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
        ...(client ? { client: Object.freeze({ name: client.name, version: client.version }) } : {}),
        ...(protocolVersion ? { protocolVersion } : {}),
        caller: Object.freeze(
          caller.kind === "user" ? { ...caller, scopes: Object.freeze([...caller.scopes]) } : { ...caller },
        ),
      }
    : undefined;
  const started = observed ? performance.now() : 0;
  if (observed) observe(options.onObservation, { ...observed, phase: "attempt", at: Date.now() });
  let outcome: "succeeded" | "failed" | "denied" = "succeeded",
    code: string | undefined,
    completed = false,
    settled = false;
  /** The completion observation, once. */
  const complete = () => {
    if (!observed || completed) return;
    completed = true;
    const durationMs = Math.max(0, performance.now() - started);
    observe(options.onObservation, {
      ...observed,
      phase: "completion",
      at: Date.now(),
      outcome,
      durationMs,
      ...(code ? { code } : {}),
    });
  };
  // A client that goes away before the call settles cancels it: the completion observation and the access event record
  // that in the abort event itself, since Workers ends the invocation at the disconnect and runs nothing after the
  // tool's next `await`. Both keep their first outcome, so a tool that ignores the signal and finishes on a runtime that
  // keeps running changes neither: its result is not delivered, though its writes may be made.
  const follow = () => {
    if (settled) return;
    outcome = "failed";
    code = "REQUEST_CANCELLED";
    pipeline.finish(cancelled());
    complete();
    cancel.abort(mcpReq.signal.reason);
  };
  // The 2025-era stateless transport does not abort its signal for a request that arrived already aborted.
  if (mcpReq.signal.aborted || request.signal.aborted) follow();
  else mcpReq.signal.addEventListener("abort", follow);
  try {
    // A request already aborted when its call starts runs no step of it.
    cancel.signal.throwIfAborted();
    // Frozen by the host contract (v1): a forwarded caller's guard answers before the Origin rule on MCP. Every other
    // caller, and REST for every caller, passes the Origin rule first.
    if (pipeline.host) pipeline.check(call);
    pipeline.enforceOrigin(request, call);
    // Application `authorize` already decided every call of the request. The generated guard runs here, before any
    // input is validated or a database handle acquired.
    pipeline.check(call);
    let db: Database | undefined,
      resultMeta: Readonly<Record<string, unknown>> | undefined,
      blocks: readonly unknown[] | undefined;
    const run = async (input: Record<string, unknown>) => {
      const getDb = () => (db ??= options.db(serving.env));
      const output = await callTool(tool, input, getDb, caller, options.handlers as Handlers, toolCall);
      // A re-run for a smaller page replaces the first run's blocks and meta, also when it returns no wrapper.
      resultMeta = blocks = undefined;
      // withResult: the data is the result; its blocks follow Core's, its meta reaches only the result `_meta`.
      if (!isRecord(output) || !(Symbol.for("net.aotter.mantle/result") in output)) return output;
      resultMeta = output._meta as typeof resultMeta;
      blocks = output.content as typeof blocks;
      return output.data;
    };
    const data = await fitPage(tool, raw, await run(raw), run);
    settled = true;
    // Checked before the call is recorded: the SDK would otherwise answer a protocol error after a recorded success.
    if (blocks && !isResult({ content: blocks })) {
      const list: readonly unknown[] = Array.isArray(blocks) ? blocks : [],
        bad = list.findIndex(block => !isResult({ content: [block] }));
      const where =
        bad < 0
          ? "content that is not a list of blocks"
          : `content[${bad}] (type ${JSON.stringify((list[bad] as { type?: unknown } | null)?.type)})`;
      throw new Error(`MCP tool ${tool.name} returned ${where}, which the SDK refuses.`);
    }
    // On 2026-07-28 structuredContent is any JSON value (SEP-2106); on a 2025 revision only an object, so other data is
    // sent as its text block alone (the schema of such a tool is not listed there). A listed outputSchema requires one
    // of its root type on success: data that does not fit fails here, before it is recorded, instead of reaching the
    // client as a result its schema refuses.
    if (listed && !rootAllows(listed, data))
      throw new Error(
        `MCP tool ${tool.name} returned ${data === undefined ? "no value" : JSON.stringify(data === null ? "null" : Array.isArray(data) ? "array" : typeof data)}, which the root of its listed outputSchema (type ${JSON.stringify(listed.type)}) does not allow.`,
      );
    pipeline.finish();
    // A tool that returns nothing (blocks alone, say) still answers valid JSON text.
    const body = JSON.stringify(data) ?? "null",
      oversized = tool.page && body.length > MCP_PAGE_BUDGET;
    const notice =
      `This page is larger than the ${MCP_PAGE_BUDGET}-character page size budget (a single row over it, ` +
      "or a View without an order, is returned whole), so a host may truncate it or not render its App. Continue with nextCursor, if any.";
    return {
      ...(hasMeta || resultMeta ? { _meta: { ...resultMeta, [TOOL_META_KEY]: tool.name } } : {}),
      content: [
        { type: "text" as const, text: body },
        ...about(false),
        ...(oversized ? [{ type: "text" as const, text: notice }] : []),
        ...((blocks ?? []) as import("@modelcontextprotocol/server").ContentBlock[]),
      ],
      ...(data === undefined || (legacy && !isRecord(data))
        ? {}
        : { structuredContent: data as Record<string, unknown> }),
    };
  } catch (thrown) {
    settled = true;
    // A client that went away is not the tool's failure: its own code, which is not logged as an unhandled failure.
    const error = cancel.signal.aborted && !(thrown instanceof ContractError) ? cancelled(thrown) : thrown;
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
      ...(listed ? {} : { structuredContent: payload }),
    };
  } finally {
    mcpReq.signal.removeEventListener("abort", follow);
    complete();
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

/**
 * MCP Apps support as the request declares it: in its `_meta` client capabilities (every 2026-07-28 request), or in a
 * 2025-era `initialize`. `unknown`: a stateless 2025-era request after `initialize` carries no capabilities, so only an
 * explicit refusal hides Apps.
 */
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
        ...(resource.icons ? { icons: resource.icons as Icon[] } : {}),
        ...(resource.annotations ? { annotations: resource.annotations as Annotations } : {}),
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
