import {
  McpServer,
  fromJsonSchema,
  type CallToolResult,
  type JsonSchemaType,
  type JsonSchemaValidator,
  type ScopeChallengeHandler,
  type StandardSchemaWithJSON,
  type Tool,
  type ToolAnnotations,
  type jsonSchemaValidator,
} from "@modelcontextprotocol/server";
import { redactForWire, runtimeDiagnostic, type Diagnostic, type SiteIcon } from "@aotter/mantle-spec";
import type {
  AuditSink,
  Capability,
  CapabilityHints,
  HandlerContext,
  InvokeCapabilityUseCase,
} from "@aotter/mantle-runtime";
import { RESOURCE_MIME_TYPE, registerAppResource, registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import packageJson from "../package.json" with { type: "json" };
import {
  APP_ONLY_CAPABILITIES,
  appResourceHtml,
  appResourceMeta,
  linkApps,
  type ClientUiSupport,
  type MantleMcpApps,
} from "./apps.js";

export interface MantleMcpServerInfo {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly websiteUrl?: string;
  readonly icons?: readonly SiteIcon[];
}

export interface MantleMcpServerOptions {
  readonly serverInfo?: MantleMcpServerInfo;
  /** Optional tools/call audit trail; one event per call. */
  readonly audit?: AuditSink;
  /**
   * OAuth step-up. When set, an OAuth caller whose token lacks a tool's
   * declared `ctx.auth.scope` scopes gets the SDK's `insufficient_scope`
   * challenge (403) naming `scopes` plus the tool's scopes, instead of a
   * denied tool result it cannot recover from.
   *
   * `grantable` lists the scopes the authorization server can issue for this
   * resource; omitted, any scope is assumed grantable. A tool whose missing
   * scopes are not all grantable keeps the runtime's denied result, because
   * re-authorizing could never satisfy it.
   */
  readonly oauth?: { readonly scopes: readonly string[]; readonly grantable?: readonly string[] };
  /**
   * MCP Apps (ADR-0029 D7): UI resources for this surface, and which tools
   * render in them. A client that declares no MCP Apps support gets plain
   * tools, no resources and no app-only tools; a client whose support is
   * unknown gets the App metadata, which hosts without MCP Apps ignore.
   */
  readonly apps?: MantleMcpApps;
}

/**
 * Registers one surface's capability catalog on official `McpServer`
 * instances. Tool definitions are built once; `create(ctx)` produces the
 * fresh per-request server the SDK's serving model expects, with every tool
 * bound to that request's verified caller.
 */
export interface MantleMcpServerFactory {
  readonly invoker: InvokeCapabilityUseCase;
  create(ctx: HandlerContext, ui?: ClientUiSupport): McpServer;
  /** Whether `create(ctx, ui)` registers the tool: an app-only tool is
   *  absent for a client without MCP Apps. */
  registers(name: string, ui: ClientUiSupport): boolean;
  /** Record one audit event for a call that never reached a tool. */
  audit(ctx: HandlerContext, tool: string, args: Readonly<Record<string, unknown>>, outcome: string): void;
}

export function createMantleMcpServer(
  invoker: InvokeCapabilityUseCase,
  options: MantleMcpServerOptions = {},
): MantleMcpServerFactory {
  const catalog = invoker.catalog;
  const apps = linkApps(options.apps, invoker);
  // A capability whose use case is not bound is not served at all, and an
  // App-only capability no App lists is not offered to anyone.
  const offered = (name: string) => invoker.serves(name) && (!APP_ONLY_CAPABILITIES.has(name) || apps.appOnly.has(name));
  const tools = catalog.capabilities
    .filter((capability) => offered(capability.name))
    .map((capability) => ({ capability, config: toolConfig(capability) }));
  /**
   * A tool this request registers whose `collection` input accepts the
   * collection, such as `read_entry`; the App calls it only when named.
   */
  const coversCollection = (name: string, collection: string | null, ui: ClientUiSupport): boolean => {
    const target = catalog.get(name);
    if (!target || !collection || !offered(name) || (apps.appOnly.has(name) && ui === "unsupported")) return false;
    const property = (target.inputSchema["properties"] as { collection?: { enum?: readonly string[] } } | undefined)?.collection;
    return (property?.enum ?? []).includes(collection);
  };
  /**
   * What an App needs to render a View and act on its rows (ADR-0029 D7):
   * the source collection, the tools that read one of its entries and
   * render its site preview when this surface has them, and each row action with the tool's title and input
   * schema, limited to tools this request registers. It travels in the
   * result's `_meta` of App-linked Views only, so hosts that render no UI
   * and the model's text are unchanged.
   */
  const interactionMeta = (capability: Capability, ui: ClientUiSupport): Record<string, unknown> | undefined => {
    if (capability.route.kind !== "view") return undefined;
    const collection = capability.route.view.spec.from ?? null;
    const actions = (capability.rowActions ?? []).flatMap((action) => {
      const target = catalog.get(action.capability);
      if (!target || !invoker.serves(action.capability) || (apps.appOnly.has(action.capability) && ui === "unsupported")) return [];
      return [{
        capability: action.capability,
        // People see the title; the description is written for the model.
        ...(target.title ? { title: target.title } : {}),
        inputSchema: target.inputSchema,
        bind: action.bind,
        ...(action.version ? { version: action.version } : {}),
        mutates: action.mutates,
      }];
    });
    return {
      [INTERACTION_META_KEY]: {
        view: capability.name,
        collection,
        rowActions: actions,
        ...(coversCollection(READ_ENTRY, collection, ui) ? { read: READ_ENTRY } : {}),
        ...(coversCollection(PREVIEW_ENTRY, collection, ui) ? { preview: PREVIEW_ENTRY } : {}),
      },
    };
  };
  const serverInfo = {
    ...(options.serverInfo ?? { name: "aotter.mantle" }),
    icons: options.serverInfo?.icons?.map(({ sizes, ...icon }) => ({
      ...icon,
      ...(sizes ? { sizes: [...sizes] } : {}),
    })),
    version: packageJson.version,
  };

  const record = (
    ctx: HandlerContext,
    tool: string,
    operationId: string | null,
    outcome: string,
    startedAt: number,
  ): void => {
    const sink = options.audit;
    if (!sink) return;
    // Audit is off the response path: nothing it does may change a result.
    try {
      const settled = Promise.resolve()
      .then(() => sink.record({
        at: startedAt,
        surface: catalog.surface,
        callerId: ctx.user?.id ?? null,
        clientId: ctx.auth?.clientId ?? null,
        credential: ctx.auth?.credential ?? null,
        tool,
        operationId,
        outcome,
        durationMs: Date.now() - startedAt,
      }))
      .catch((error: unknown) => {
        console.error("[mantle-mcp] audit sink failed", error);
      });
      ctx.waitUntil?.(settled);
    } catch (error) {
      console.error("[mantle-mcp] audit scheduling failed", error);
    }
  };

  const operationIdOf = (tool: string, args: Readonly<Record<string, unknown>>): string | null => {
    const value = args[catalog.get(tool)?.operationIdArgument ?? "operationId"];
    return typeof value === "string" ? value : null;
  };

  return {
    invoker,
    create(ctx, ui = "unknown") {
      const server = new McpServer(serverInfo, { capabilities: { tools: { listChanged: false } } });
      const withApps = ui !== "unsupported" && apps.resources.length > 0;
      if (withApps) {
        for (const resource of apps.resources) {
          const meta = appResourceMeta(resource);
          registerAppResource(server, resource.name, resource.uri, {
            ...(resource.title ? { title: resource.title } : {}),
            ...(resource.description ? { description: resource.description } : {}),
            ...(meta ? { _meta: meta } : {}),
          }, async () => ({
            contents: [{
              uri: resource.uri,
              mimeType: RESOURCE_MIME_TYPE,
              text: await appResourceHtml(resource),
              ...(meta ? { _meta: meta } : {}),
            }],
          }));
        }
      }
      for (const { capability, config } of tools) {
        const appOnlyUri = apps.appOnly.get(capability.name);
        if (appOnlyUri && !withApps) continue;
        const resourceUri = withApps ? appOnlyUri ?? apps.rendersIn.get(capability.name) : undefined;
        const scopeChallenge = stepUp(capability, ctx, options.oauth, (args) => {
          record(ctx, capability.name, operationIdOf(capability.name, args), "INSUFFICIENT_SCOPE", Date.now());
        });
        const definition = { ...config, ...(scopeChallenge ? { scopeChallenge } : {}) };
        const run = async (args: unknown): Promise<CallToolResult> => {
          const input = isRecord(args) ? args : {};
          const startedAt = Date.now();
          let outcome = "ok";
          try {
            const result = await invoker.execute({
              name: capability.name,
              args: input,
              ctx,
              path: `MCP ${capability.name}`,
            });
            if (result.ok && capability.route.kind === "preview") return previewResult(result.data, input);
            if (result.ok) return successResult(result.data, resourceUri ? interactionMeta(capability, ui) : undefined);
            outcome = result.diagnostic.code;
            return errorResult(redactForWire(result.diagnostic), config.outputSchema !== undefined);
          } catch (error) {
            // Adapter exceptions can carry binding or driver detail; the real
            // cause goes to server logs and the wire stays opaque.
            outcome = "INTERNAL";
            console.error("[mantle-mcp] unhandled tool-call error", error);
            return errorResult(runtimeDiagnostic({
              code: "INTERNAL_ERROR",
              severity: "error",
              path: `MCP ${capability.name}`,
              message: "Internal error.",
            }), config.outputSchema !== undefined);
          } finally {
            record(ctx, capability.name, operationIdOf(capability.name, input), outcome, startedAt);
          }
        };
        if (!resourceUri) {
          server.registerTool(capability.name, definition, run);
          continue;
        }
        // The official helper writes both the `ui` object and the legacy
        // flat `ui/resourceUri` key, so older hosts find the resource too.
        registerAppTool(server, capability.name, {
          ...definition,
          _meta: { ui: { resourceUri, ...(appOnlyUri ? { visibility: ["app"] } : {}) } },
        } as Parameters<typeof registerAppTool>[2], run as never);
      }
      return server;
    },
    registers(name, ui) {
      if (!offered(name)) return false;
      return !(apps.appOnly.has(name) && (ui === "unsupported" || apps.resources.length === 0));
    },
    audit(ctx, tool, args, outcome) {
      record(ctx, tool, operationIdOf(tool, args), outcome, Date.now());
    },
  };
}

/** MCP `tools/list` definitions for a catalog, for transports that list
 *  tools outside an `McpServer` (for example WebMCP in a browser). */
export function mcpToolDefinitions(invoker: InvokeCapabilityUseCase): Tool[] {
  return invoker.catalog.capabilities.filter((capability) => invoker.serves(capability.name)).map((capability) => ({
    name: capability.name,
    ...(capability.title ? { title: capability.title } : {}),
    description: capability.description,
    inputSchema: capability.inputSchema as Tool["inputSchema"],
    ...(capability.outputSchema ? { outputSchema: capability.outputSchema as Tool["outputSchema"] } : {}),
    ...(capability.hints ? { annotations: toAnnotations(capability.hints) } : {}),
  }));
}

function stepUp(
  capability: Capability,
  ctx: HandlerContext,
  oauth: MantleMcpServerOptions["oauth"],
  onChallenge: (args: Readonly<Record<string, unknown>>) => void,
): ScopeChallengeHandler | undefined {
  const required = capability.requiredScopes;
  if (!oauth || required.length === 0) return undefined;
  const grantable = oauth.grantable ? new Set(oauth.grantable) : null;
  if (grantable && !required.every((scope) => grantable.has(scope))) return undefined;
  const scopes = [...new Set([...oauth.scopes, ...required])] as [string, ...string[]];
  return ({ request }) => {
    // Only an OAuth token can be re-issued with more scopes. Sessions, API
    // keys and personal tokens get the runtime's denial instead.
    if (ctx.auth?.credential !== "oauth") return undefined;
    const granted = new Set(ctx.auth.scopes);
    if (required.every((scope) => granted.has(scope))) return undefined;
    const params = request.params as { arguments?: unknown } | undefined;
    onChallenge(isRecord(params?.arguments) ? params.arguments : {});
    return { scopes };
  };
}

/**
 * Runtime validates every argument and output exactly once, so MCP, HTTP and
 * Admin report the same Diagnostic. The SDK still advertises each schema but
 * accepts values as given, which also keeps its default Ajv validator out of
 * the bundle.
 */
const PASS_THROUGH: jsonSchemaValidator = {
  getValidator<T>(): JsonSchemaValidator<T> {
    return (input) => ({ valid: true, data: input as T, errorMessage: undefined });
  },
};

function toolConfig(capability: Capability): {
  title?: string;
  description: string;
  inputSchema: StandardSchemaWithJSON;
  outputSchema?: StandardSchemaWithJSON;
  annotations?: ToolAnnotations;
} {
  return {
    ...(capability.title ? { title: capability.title } : {}),
    description: capability.description,
    inputSchema: fromJsonSchema(capability.inputSchema as JsonSchemaType, PASS_THROUGH),
    ...(capability.outputSchema
      ? { outputSchema: fromJsonSchema(capability.outputSchema as JsonSchemaType, PASS_THROUGH) }
      : {}),
    ...(capability.hints ? { annotations: toAnnotations(capability.hints) } : {}),
  };
}

function toAnnotations(hints: CapabilityHints): ToolAnnotations {
  return Object.fromEntries(Object.entries(hints).map(([key, value]) => [`${key}Hint`, value]));
}

/** Result `_meta` key carrying a View's row actions for MCP Apps. */
export const INTERACTION_META_KEY = "net.aotter.mantle/interaction";

/** The staff tools that read one entry and render its site preview (ADR-0029 D7, D10). */
const READ_ENTRY = "read_entry";
const PREVIEW_ENTRY = "preview_entry";

/** MCP requires `structuredContent` to be an object, so arrays and
 *  primitives travel in the text block only. */
function successResult(data: unknown, meta?: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data) }],
    ...(isRecord(data) ? { structuredContent: data } : {}),
    ...(meta ? { _meta: meta } : {}),
  };
}

/**
 * A rendered page is for the App only: the text block, which every host
 * shows to the model, says what was rendered and carries none of the page.
 */
function previewResult(data: unknown, input: Readonly<Record<string, unknown>>): CallToolResult {
  const html = isRecord(data) && typeof data["html"] === "string" ? data["html"] : "";
  return {
    content: [{ type: "text", text: `Rendered the site page of ${String(input["collection"])} entry ${String(input["id"])} (${html.length} characters) for the App to show.` }],
    structuredContent: { html },
  };
}

/**
 * Business failures are tool results the model can read and act on (D1).
 * When the tool advertises an `outputSchema`, the diagnostics travel in the
 * text block only: 1.x clients validate `structuredContent` against that
 * schema even on `isError`, and the spec requires structured results to
 * conform to it.
 */
function errorResult(diagnostic: Diagnostic, hasOutputSchema: boolean): CallToolResult {
  const payload = { diagnostics: [diagnostic] };
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(payload) }],
    ...(hasOutputSchema ? {} : { structuredContent: payload }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
