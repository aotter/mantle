import type { Database } from "bun:sqlite";
import {
  MANTLE_VIEW_ROUTE_PREFIX,
  bootMantleRuntime,
  createMantleRequestHandler,
  SqliteMantleStorageAdapter,
  type AnyHandler,
  type MantleRuntime,
  type MantleRuntimePorts,
  type MantleRequestHandler,
  type RuntimePlan,
} from "@aotter/mantle-runtime";
import type { SiteDefaults } from "@aotter/mantle-spec";
import { BunDatabaseDriver } from "./BunDatabaseDriver.js";

export interface CreateBunMantleOptions {
  readonly plan: RuntimePlan;
  readonly database: Database;
  readonly handlers?: Readonly<Record<string, AnyHandler>>;
  readonly siteDefaults?: SiteDefaults;
  readonly ports?: MantleRuntimePorts;
  readonly reservedHttpPathPrefixes?: readonly string[];
}

export interface BunMantle {
  getRuntime(): Promise<MantleRuntime>;
  /** Return `null` when the host should continue through its own router. */
  readonly handle: MantleRequestHandler;
}

/** Embed one prepared Mantle revision in an application-owned Bun process. */
export function createBunMantle(options: CreateBunMantleOptions): BunMantle {
  const driver = new BunDatabaseDriver(options.database);
  const storage = new SqliteMantleStorageAdapter(driver, options.siteDefaults);
  let initialization: Promise<MantleRuntime> | null = null;

  const getRuntime = (): Promise<MantleRuntime> => {
    if (initialization) return initialization;
    initialization = bootMantleRuntime({
      plan: options.plan,
      storage,
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

  const handle = createMantleRequestHandler({ plan: options.plan, getRuntime });

  return { getRuntime, handle };
}
