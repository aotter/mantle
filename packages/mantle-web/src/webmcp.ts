import type { RuntimeCallableCapability } from "@aotter/mantle-runtime";

export type WebMcpTarget =
  | Readonly<{ readonly kind: "view"; readonly name: string }>
  | Readonly<{ readonly kind: "procedure"; readonly name: string }>;

export interface WebMcpCall {
  readonly name: string;
  readonly target: WebMcpTarget;
  readonly input: Readonly<Record<string, unknown>>;
  readonly signal: AbortSignal;
}

export interface WebMcpTool {
  readonly name: string;
  readonly title?: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly annotations: {
    readonly readOnlyHint: boolean;
    readonly untrustedContentHint?: boolean;
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
  getTools?():
    | readonly { readonly name: string }[]
    | Promise<readonly { readonly name: string }[]>;
}

export interface WebMcpBinding {
  readonly supported: boolean;
  readonly registered: readonly string[];
  readonly skipped: readonly string[];
  dispose(): void;
}

export type WebMcpInvoker = (
  capability: RuntimeCallableCapability,
  input: Readonly<Record<string, unknown>>,
  signal: AbortSignal,
) => Promise<unknown>;

export interface BindWebMcpOptions {
  readonly capabilities: readonly RuntimeCallableCapability[];
  readonly invoke: WebMcpInvoker;
  readonly modelContext?: WebMcpModelContext;
  readonly before?: (call: WebMcpCall) => void | Promise<void>;
  readonly after?: (
    call: WebMcpCall,
    result: PromiseSettledResult<unknown>,
  ) => void | Promise<void>;
}

/** Opt-in browser binding over public callable capabilities. */
export async function bindWebMcp(
  options: BindWebMcpOptions,
): Promise<WebMcpBinding> {
  const modelContext = options.modelContext ?? browserModelContext();
  if (!modelContext) return unsupportedBinding();

  const capabilities = options.capabilities.filter(
    (capability) => capability.surface === "public",
  );
  assertUniqueNames(capabilities);

  const controller = new AbortController();
  try {
    const existing = modelContext.getTools
      ? new Set((await modelContext.getTools()).map((tool) => tool.name))
      : new Set<string>();
    const skipped = capabilities
      .filter((capability) => existing.has(capability.name))
      .map((capability) => capability.name);
    const pending = capabilities.filter((capability) => !existing.has(capability.name));

    await Promise.all(pending.map((capability) => modelContext.registerTool(
      toWebMcpTool(capability, options),
      { signal: controller.signal },
    )));

    return binding(
      pending.map((capability) => capability.name),
      skipped,
      controller,
    );
  } catch (error) {
    controller.abort();
    throw error;
  }
}

function toWebMcpTool(
  capability: RuntimeCallableCapability,
  options: BindWebMcpOptions,
): WebMcpTool {
  const target: WebMcpTarget = Object.freeze({
    kind: capability.kind,
    name: capability.ownerName,
  });
  return {
    name: capability.name,
    ...(capability.title ? { title: capability.title } : {}),
    description: capability.description,
    inputSchema: capability.inputSchema as Record<string, unknown>,
    annotations: {
      readOnlyHint: capability.kind === "view" || capability.inputSchema.readOnly === true,
      ...(capability.kind === "view" ? { untrustedContentHint: true } : {}),
    },
    execute: async (input, context) => {
      if (!input || typeof input !== "object" || Array.isArray(input)) {
        throw new TypeError("WebMCP tool input must be an object.");
      }
      const signal = context.signal ?? new AbortController().signal;
      const call: WebMcpCall = Object.freeze({
        name: capability.name,
        target,
        input,
        signal,
      });
      let result: PromiseSettledResult<unknown>;
      try {
        signal.throwIfAborted();
        await options.before?.(call);
        result = {
          status: "fulfilled",
          value: await options.invoke(capability, input, signal),
        };
      } catch (reason) {
        result = { status: "rejected", reason };
      }
      try {
        await options.after?.(call, result);
      } catch {
        // Observational hooks never change the domain result.
      }
      if (result.status === "fulfilled") return result.value;
      throw result.reason;
    },
  };
}

function assertUniqueNames(capabilities: readonly RuntimeCallableCapability[]): void {
  const names = new Set<string>();
  for (const capability of capabilities) {
    if (names.has(capability.name)) {
      throw new TypeError(`Duplicate WebMCP capability name '${capability.name}'.`);
    }
    names.add(capability.name);
  }
}

function browserModelContext(): WebMcpModelContext | undefined {
  const modelContext = (globalThis as { document?: { modelContext?: WebMcpModelContext } })
    .document?.modelContext;
  return modelContext && typeof modelContext.registerTool === "function"
    ? modelContext
    : undefined;
}

function binding(
  registered: readonly string[],
  skipped: readonly string[],
  controller: AbortController,
): WebMcpBinding {
  return Object.freeze({
    supported: true,
    registered: Object.freeze(registered),
    skipped: Object.freeze(skipped),
    dispose: () => controller.abort(),
  });
}

function unsupportedBinding(): WebMcpBinding {
  return Object.freeze({
    supported: false,
    registered: Object.freeze([]),
    skipped: Object.freeze([]),
    dispose: () => {},
  });
}
