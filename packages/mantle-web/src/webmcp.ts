import type {
  RuntimeCallableCapability,
  ViewCallableCapability,
} from "@aotter/mantle-runtime";

export interface WebMcpTool {
  readonly name: string;
  readonly title?: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly annotations: {
    readonly readOnlyHint: true;
    readonly untrustedContentHint: true;
  };
  execute(
    input: Record<string, unknown>,
    context: { readonly signal?: AbortSignal },
  ): Promise<unknown>;
}

export interface WebMcpModelContext {
  registerTool(
    tool: WebMcpTool,
    options: { readonly signal: AbortSignal },
  ): void | Promise<void>;
}

export interface WebMcpBinding {
  readonly supported: boolean;
  readonly registered: readonly string[];
  dispose(): void;
}

export interface BindWebMcpOptions {
  readonly modelContext?: WebMcpModelContext;
  readonly fetch?: typeof fetch;
  readonly endpointPrefix?: string;
}

/** Opt-in browser binding for public, read-only View capabilities. */
export async function bindWebMcp(
  capabilities: readonly RuntimeCallableCapability[],
  options: BindWebMcpOptions = {},
): Promise<WebMcpBinding> {
  const modelContext = options.modelContext ?? browserModelContext();
  if (!modelContext) return unsupportedBinding();

  const controller = new AbortController();
  const views = capabilities.filter(
    (capability): capability is ViewCallableCapability =>
      capability.kind === "view" && capability.surface === "public",
  );
  try {
    await Promise.all(views.map((capability) => modelContext.registerTool({
      name: capability.name,
      ...(capability.title ? { title: capability.title } : {}),
      description: capability.description,
      inputSchema: capability.inputSchema as Record<string, unknown>,
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute: (input, context) => queryView(
        capability,
        input,
        context.signal
          ? AbortSignal.any([context.signal, controller.signal])
          : controller.signal,
        options,
      ),
    }, { signal: controller.signal })));
  } catch (error) {
    controller.abort();
    throw error;
  }
  return Object.freeze({
    supported: true,
    registered: Object.freeze(views.map((view) => view.name)),
    dispose: () => controller.abort(),
  });
}

function browserModelContext(): WebMcpModelContext | undefined {
  const modelContext = (globalThis as { document?: { modelContext?: WebMcpModelContext } })
    .document?.modelContext;
  return modelContext && typeof modelContext.registerTool === "function"
    ? modelContext
    : undefined;
}

function unsupportedBinding(): WebMcpBinding {
  return Object.freeze({
    supported: false,
    registered: Object.freeze([]),
    dispose: () => {},
  });
}

async function queryView(
  capability: ViewCallableCapability,
  input: Record<string, unknown>,
  signal: AbortSignal,
  options: BindWebMcpOptions,
): Promise<unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("WebMCP View input must be an object.");
  }
  const query = Object.entries(input)
    .filter((entry): entry is [string, string | number | boolean] =>
      ["string", "number", "boolean"].includes(typeof entry[1]))
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join("&");
  const prefix = (options.endpointPrefix ?? "/api/views").replace(/\/$/u, "");
  if (!/^\/(?!\/)[^\\?#]*$/u.test(prefix)) {
    throw new TypeError("WebMCP endpointPrefix must be a same-origin absolute path.");
  }
  const response = await (options.fetch ?? fetch)(
    `${prefix}/${encodeURIComponent(capability.ownerName)}${query ? `?${query}` : ""}`,
    {
      method: "GET",
      credentials: "same-origin",
      headers: { accept: "application/json" },
      signal,
    },
  );
  if (!response.ok) throw new Error(`Mantle View '${capability.ownerName}' failed (${response.status}).`);
  const body = await response.json() as unknown;
  return body && typeof body === "object" && (body as { ok?: unknown }).ok === true
    ? (body as { data?: unknown }).data
    : body;
}
