import { waitUntil as vercelWaitUntil } from "@vercel/functions";
import {
  MANTLE_VIEW_ROUTE_PREFIX,
  bootMantleRuntime,
  createMantleRequestHandler,
  type AnyHandler,
  type MantleRequestHandler,
  type MantleRuntime,
  type MantleRuntimePorts,
  type MantleStorageAdapter,
  type RuntimePlan,
} from "@aotter/mantle-runtime";

export interface CreateVercelMantleOptions {
  readonly plan: RuntimePlan;
  readonly storage: MantleStorageAdapter;
  readonly handlers?: Readonly<Record<string, AnyHandler>>;
  readonly ports?: MantleRuntimePorts;
  readonly reservedHttpPathPrefixes?: readonly string[];
  /** Override only for another host lifecycle (for example Next.js `after`) or tests. */
  readonly waitUntil?: (promise: Promise<unknown>) => void;
}

export interface VercelMantle {
  getRuntime(): Promise<MantleRuntime>;
  /** Return `null` when the application should continue through its own routes. */
  readonly handle: MantleRequestHandler;
}

/** Bind one plan to application-owned durable storage in a Vercel instance. */
export function createVercelMantle(options: CreateVercelMantleOptions): VercelMantle {
  let initialization: Promise<MantleRuntime> | null = null;

  const getRuntime = (): Promise<MantleRuntime> => {
    if (initialization) return initialization;
    initialization = bootMantleRuntime({
      plan: options.plan,
      storage: options.storage,
      handlers: options.handlers,
      ports: options.ports,
      deployment: {
        reservedHttpPathPrefixes: [
          MANTLE_VIEW_ROUTE_PREFIX,
          ...(options.reservedHttpPathPrefixes ?? []),
        ],
      },
    }).catch((error) => {
      initialization = null;
      throw error;
    });
    return initialization;
  };

  const route = createMantleRequestHandler({ plan: options.plan, getRuntime });
  const schedule = options.waitUntil ?? vercelWaitUntil;
  const handle: MantleRequestHandler = (request, context) => route(request, {
    ...(context ?? { user: null, staff: null, env: {} }),
    waitUntil: context?.waitUntil ?? schedule,
  });

  return { getRuntime, handle };
}
