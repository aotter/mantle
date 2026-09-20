import type {
  AnyHandler,
  HandlerFn,
} from "../model/HandlerContext.js";

/**
 * Handler registry keyed by `Procedure.handler.ref`. Consumers call
 * `register` at boot — typically via the `handlers` option of
 * `createMantleRuntime` — and the dispatcher resolves per request via
 * `get`.
 *
 * The registry is a usecase-level port: use cases (specifically
 * `InvokeProcedureUseCase`) depend on it; the consumer's
 * `src/mantle/config.ts` supplies it through the runtime/Worker `handlers`
 * option. Lives here in `domain/port/` (not
 * `usecase/port/`) because the implementation IS the port — there's
 * no separate adapter for it.
 *
 * Boot-time fail-fast (Loop 3 of the SDK authoring contract,
 * ADR-0007) verifies every Procedure's `handler.ref` resolves to a
 * registered function before the runtime accepts traffic.
 */
export interface HandlerRegistry {
  register<I, O, Env = unknown>(ref: string, fn: HandlerFn<I, O, Env>): void;
  get(ref: string): AnyHandler | undefined;
  has(ref: string): boolean;
  /** Snapshot of registered refs — used by the boot validator to
   *  enumerate `candidates` on `HANDLER_NOT_REGISTERED` diagnostics. */
  list(): readonly string[];
}

export class InMemoryHandlerRegistry implements HandlerRegistry {
  private readonly map = new Map<string, AnyHandler>();

  register<I, O, Env = unknown>(ref: string, fn: HandlerFn<I, O, Env>): void {
    this.map.set(ref, fn as AnyHandler);
  }

  get(ref: string): AnyHandler | undefined {
    return this.map.get(ref);
  }

  has(ref: string): boolean {
    return this.map.has(ref);
  }

  list(): readonly string[] {
    return [...this.map.keys()];
  }
}

/**
 * Convenience factory: build a registry from a record of handlers.
 * Equivalent to calling `register()` for each entry.
 */
export function buildHandlerRegistry(
  handlers: Readonly<Record<string, AnyHandler>>,
): HandlerRegistry {
  const r = new InMemoryHandlerRegistry();
  for (const [ref, fn] of Object.entries(handlers)) {
    r.register(ref, fn);
  }
  return r;
}
