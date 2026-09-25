import {
  McpServer,
  fromJsonSchema,
  type CallToolResult,
  type JsonSchemaType,
  type JsonSchemaValidator,
  type StandardSchemaWithJSON,
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
import packageJson from "../package.json" with { type: "json" };

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
}

/**
 * Registers one surface's capability catalog on official `McpServer`
 * instances. Tool definitions are built once; `create(ctx)` produces the
 * fresh per-request server the SDK's serving model expects, with every tool
 * bound to that request's verified caller.
 */
export interface MantleMcpServerFactory {
  readonly invoker: InvokeCapabilityUseCase;
  create(ctx: HandlerContext): McpServer;
  /** Record one audit event for a call that never reached a tool. */
  audit(ctx: HandlerContext, tool: string, args: Readonly<Record<string, unknown>>, outcome: string): void;
}

export function createMantleMcpServer(
  invoker: InvokeCapabilityUseCase,
  options: MantleMcpServerOptions = {},
): MantleMcpServerFactory {
  const catalog = invoker.catalog;
  const tools = catalog.capabilities.map((capability) => ({ capability, config: toolConfig(capability) }));
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
    create(ctx) {
      const server = new McpServer(serverInfo, { capabilities: { tools: { listChanged: false } } });
      for (const { capability, config } of tools) {
        server.registerTool(capability.name, config, async (args: unknown): Promise<CallToolResult> => {
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
            if (result.ok) return successResult(result.data);
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
        });
      }
      return server;
    },
    audit(ctx, tool, args, outcome) {
      record(ctx, tool, operationIdOf(tool, args), outcome, Date.now());
    },
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

/** MCP requires `structuredContent` to be an object, so arrays and
 *  primitives travel in the text block only. */
function successResult(data: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data) }],
    ...(isRecord(data) ? { structuredContent: data } : {}),
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
